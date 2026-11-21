"""The cost receipt: every spend figure shows what it counted, what it left out, and on what basis."""

import uuid
from datetime import UTC, datetime, timedelta
from decimal import Decimal

import pytest
from sqlalchemy import select

from agent_memory.insights.receipt import cost_per_success, cost_receipt, success_definition
from agent_memory.models import CatalogEntry, Job, Run
from agent_memory.projects import create_project

NOW = datetime.now(UTC)
JOB = {"name": "invoices", "check_kind": "ANSWER_KEY", "check_config": {"fields": ["total", "vendor"]}}


@pytest.fixture
async def world(client, session):
    project, key = await create_project(session, "proj1")
    headers = {"X-API-Key": key}
    assert (await client.post("/v1/jobs", json=JOB, headers=headers)).status_code in (200, 201)
    job = (await session.execute(select(Job))).scalar_one()
    return project, job, headers


def add_run(session, project, job, *, cost="0.01", outcome="PASS", status="PRICED", state="CHECKED", age_days=1,
            invalid=False, kind="PRODUCTION", version_id=None):
    session.add(Run(
        run_id=uuid.uuid4(), job_id=job.job_id, project_id=project.project_id, prompt_hash="h", model="m",
        model_version="m", outcome=outcome, state=state, run_kind=kind,
        cost_usd=Decimal(cost) if cost is not None else None, price_status=status, price_version_id=version_id,
        created_at=NOW - timedelta(days=age_days), invalid_at=(NOW if invalid else None)))


async def receipt(session, project, **kw):
    return await cost_receipt(session, project.project_id, now=NOW + timedelta(minutes=1), **kw)


# --- the basics: currency, period, counts ----------------------------------------------------------------------

async def test_the_receipt_names_currency_timezone_and_period(session, world):
    project, job, _ = world
    add_run(session, project, job)
    await session.commit()
    r = await receipt(session, project, days=30)
    assert (r.currency, r.timezone, r.period_days) == ("USD", "UTC", 30)
    assert r.period_end - r.period_start == timedelta(days=30)
    assert any("not your invoice" in n for n in r.notes) and any("UTC" in n for n in r.notes)


async def test_passed_failed_unchecked_and_excluded_are_counted_apart(session, world):
    project, job, _ = world
    add_run(session, project, job, outcome="PASS")
    add_run(session, project, job, outcome="PASS")
    add_run(session, project, job, outcome="FAIL")
    add_run(session, project, job, outcome="UNKNOWN", state="CAPTURED")
    add_run(session, project, job, outcome="PASS", state="ARCHIVED")      # left out of the checks
    add_run(session, project, job, outcome="FAIL", invalid=True)           # answer invalidated: left out too
    add_run(session, project, job, kind="RETEST")                          # not the app's own production call
    add_run(session, project, job, age_days=90)                            # outside the period
    await session.commit()
    r = await receipt(session, project, days=30)
    assert (r.runs, r.passed, r.failed, r.unchecked, r.excluded) == (6, 2, 1, 1, 2)
    assert r.passed + r.failed + r.unchecked + r.excluded == r.runs  # nothing is lost between the buckets


# --- unknown is never zero; zero is known ---------------------------------------------------------------------

async def test_an_unknown_cost_is_excluded_and_reported_never_summed_as_zero(session, world):
    project, job, _ = world
    add_run(session, project, job, cost="0.5")
    add_run(session, project, job, cost=None, status="UNPRICED_UNKNOWN_MODEL")
    add_run(session, project, job, cost=None, status="NO_USAGE")
    await session.commit()
    r = await receipt(session, project)
    assert r.spend_usd == 0.5 and r.unpriced_runs == 2
    assert r.unpriced_note == "2 unpriced runs excluded from this total"
    by = {b["status"]: b for b in r.basis}
    assert by["UNPRICED_UNKNOWN_MODEL"]["spend_usd"] is None and by["NO_USAGE"]["spend_usd"] is None
    assert by["PRICED"]["spend_usd"] == 0.5


async def test_one_unpriced_run_is_singular(session, world):
    project, job, _ = world
    add_run(session, project, job, cost=None, status="UNPRICED_EXPIRED")
    await session.commit()
    assert (await receipt(session, project)).unpriced_note == "1 unpriced run excluded from this total"


async def test_a_priced_zero_is_a_known_zero_not_an_unknown(session, world):
    project, job, _ = world
    add_run(session, project, job, cost="0")  # e.g. a local model at $0
    await session.commit()
    r = await receipt(session, project)
    assert r.unpriced_runs == 0 and r.unpriced_note is None and r.spend_usd == 0.0
    assert r.cost_per_success.value_usd == 0.0  # one pass at a known $0 costs $0, it is not "unknown"


async def test_a_negative_cost_cannot_enter_through_the_api(client, world):
    _, _, headers = world
    body = {"run_id": str(uuid.uuid4()), "job": "invoices", "prompt": "p", "model": "m", "model_version": "m",
            "cost_usd": -1}
    assert (await client.post("/v1/runs", json=body, headers=headers)).status_code == 422


async def test_a_run_with_no_status_but_a_cost_is_labelled_legacy(session, world):
    project, job, _ = world
    add_run(session, project, job, cost="0.2", status=None)
    add_run(session, project, job, cost=None, status=None)
    await session.commit()
    by = {b["status"]: b for b in (await receipt(session, project)).basis}
    assert by["LEGACY"]["runs"] == 1 and "version is not known" in by["LEGACY"]["label"]
    assert by["UNPRICED_UNSPECIFIED"]["runs"] == 1 and by["UNPRICED_UNSPECIFIED"]["spend_usd"] is None


async def test_partly_priced_and_caller_cost_runs_are_counted_on_their_own_basis(session, world):
    project, job, _ = world
    add_run(session, project, job, cost="0.3", status="PARTLY_PRICED")
    add_run(session, project, job, cost="0.4", status="CALLER_COST")
    await session.commit()
    r = await receipt(session, project)
    by = {b["status"]: b for b in r.basis}
    assert r.partly_priced_runs == 1 and r.spend_usd == pytest.approx(0.7)
    assert "cannot price" in by["PARTLY_PRICED"]["label"] and "your own app" in by["CALLER_COST"]["label"]


# --- price versions -----------------------------------------------------------------------------------------------

async def test_the_receipt_lists_the_dated_price_versions_that_priced_the_calls(client, session, world):
    project, job, headers = world
    project_id = project.project_id
    session.add(CatalogEntry(model="acme-s", model_version="acme-s", provider="acme",
                             price_in_per_mtok=Decimal("1"), price_out_per_mtok=Decimal("2")))
    await session.commit()

    async def call():
        body = {"run_id": str(uuid.uuid4()), "job": "invoices", "prompt": "p", "model": "acme-s",
                "model_version": "acme-s", "tokens_in": 1_000_000, "tokens_out": 0,
                "output": '{"total": 1, "vendor": "x"}', "expected": {"total": 1, "vendor": "x"}}
        assert (await client.post("/v1/runs", json=body, headers=headers)).status_code == 202

    await call()
    row = (await session.execute(select(CatalogEntry))).scalar_one()
    row.price_in_per_mtok = Decimal("4")
    await session.commit()
    await call()
    session.expire_all()
    r = await cost_receipt(session, project_id, days=30)
    prices = sorted(v.input_per_mtok for v in r.price_versions)
    assert prices == [1.0, 4.0]  # both the old and the new list price, each with the calls it priced
    old = next(v for v in r.price_versions if v.input_per_mtok == 1.0)
    assert old.effective_to is not None and old.runs == 1 and old.spend_usd == 1.0
    assert all(v.source_url and v.checked_at and "not a negotiated" in v.applicability for v in r.price_versions)
    assert r.spend_usd == 5.0 and r.price_versions_checked_at is not None


async def test_calls_priced_before_versions_existed_show_no_version(session, world):
    project, job, _ = world
    add_run(session, project, job, status=None)
    await session.commit()
    r = await receipt(session, project)
    assert r.price_versions == [] and r.price_versions_checked_at is None and r.spend_usd == 0.01


# --- cost per correct answer: formula, denominators --------------------------------------------------------------

async def test_cost_per_correct_answer_divides_checked_priced_cost_by_those_passes(session, world):
    project, job, _ = world
    add_run(session, project, job, cost="0.10", outcome="PASS")
    add_run(session, project, job, cost="0.30", outcome="PASS")
    add_run(session, project, job, cost="0.20", outcome="FAIL")
    await session.commit()
    c = (await receipt(session, project)).cost_per_success
    assert c.value_usd == pytest.approx(0.30)  # (0.10 + 0.30 + 0.20) / 2 passes
    assert (c.spend_usd, c.passed, c.checked_priced_runs) == (pytest.approx(0.6), 2, 3)
    assert "÷" in c.formula and c.success_definition == "The answer matches your answer key (total, vendor)"


async def test_unchecked_runs_never_enter_the_division(session, world):
    project, job, _ = world
    add_run(session, project, job, cost="0.10", outcome="PASS")
    add_run(session, project, job, cost="9.00", outcome="UNKNOWN", state="CAPTURED")  # expensive but unchecked
    await session.commit()
    r = await receipt(session, project)
    assert r.spend_usd == pytest.approx(9.10)               # the spend figure still shows what was spent
    c = r.cost_per_success
    assert c.value_usd == pytest.approx(0.10) and c.unchecked_runs == 1  # but the unchecked 9.00 is not divided


async def test_checked_but_unpriced_runs_are_left_out_of_both_numbers_and_counted(session, world):
    project, job, _ = world
    add_run(session, project, job, cost="0.10", outcome="PASS")
    add_run(session, project, job, cost=None, outcome="PASS", status="UNPRICED_UNKNOWN_MODEL")
    await session.commit()
    c = (await receipt(session, project)).cost_per_success
    assert (c.value_usd, c.passed, c.checked_priced_runs, c.checked_unpriced_runs) == (pytest.approx(0.10), 1, 1, 1)


async def test_no_passes_gives_no_cost_per_correct_answer_and_says_why(session, world):
    project, job, _ = world
    add_run(session, project, job, cost="0.10", outcome="FAIL")
    await session.commit()
    c = (await receipt(session, project)).cost_per_success
    assert c.value_usd is None and "None of the checked calls passed" in c.reason


async def test_nothing_checked_gives_no_value_and_says_why(session, world):
    project, job, _ = world
    add_run(session, project, job, outcome="UNKNOWN", state="CAPTURED")
    await session.commit()
    c = (await receipt(session, project)).cost_per_success
    assert c.value_usd is None and "No call has been checked and priced" in c.reason and c.unchecked_runs == 1


async def test_every_checked_call_unpriced_says_so(session, world):
    project, job, _ = world
    add_run(session, project, job, cost=None, outcome="PASS", status="UNPRICED_EXPIRED")
    await session.commit()
    c = (await receipt(session, project)).cost_per_success
    assert c.value_usd is None and "missing a price" in c.reason


async def test_excluded_runs_are_in_the_spend_but_not_in_the_division(session, world):
    project, job, _ = world
    add_run(session, project, job, cost="0.10", outcome="PASS")
    add_run(session, project, job, cost="5.00", outcome="PASS", state="ARCHIVED")
    await session.commit()
    r = await receipt(session, project)
    assert r.spend_usd == pytest.approx(5.10) and r.cost_per_success.value_usd == pytest.approx(0.10)


async def test_spend_on_failed_checks_is_not_called_wasted(session, world):
    project, job, _ = world
    add_run(session, project, job, cost="0.10", outcome="PASS")
    add_run(session, project, job, cost="0.25", outcome="FAIL")
    await session.commit()
    r = await receipt(session, project)
    assert r.spend_on_failed_checks_usd == pytest.approx(0.25)
    assert not any("wast" in n.lower() and "not called" not in n for n in r.notes)
    assert any("deliberate test" in n for n in r.notes)


def test_the_success_definition_follows_how_the_task_is_checked():
    assert success_definition("TEST_COMMAND", None) == "The answer passes the test command you set"
    assert success_definition("SCHEMA", {}) == "The answer matches the JSON shape you set"
    assert success_definition("LATE_LABEL", None) == "You marked the answer correct"
    assert success_definition("ANSWER_KEY", {}) == "The answer matches your answer key"


def test_cost_per_success_is_pure_and_never_divides_by_zero():
    c = cost_per_success(check_kind="ANSWER_KEY", config=None, spend=1.0, passed=0, checked_priced=3,
                         checked_unpriced=0, unchecked=0)
    assert c.value_usd is None
    ok = cost_per_success(check_kind="ANSWER_KEY", config=None, spend=1.0, passed=4, checked_priced=4,
                          checked_unpriced=0, unchecked=0)
    assert ok.value_usd == 0.25


# --- several tasks and the API ----------------------------------------------------------------------------------

async def test_several_tasks_are_listed_with_their_own_receipt_and_one_combined_figure(client, session, world):
    project, job, headers = world
    await client.post("/v1/jobs", json={"name": "tickets", "check_kind": "LATE_LABEL", "check_config": {}}, headers=headers)
    other = (await session.execute(select(Job).where(Job.name == "tickets"))).scalar_one()
    add_run(session, project, job, cost="0.10", outcome="PASS")
    add_run(session, project, other, cost="0.30", outcome="PASS")
    await session.commit()
    r = await receipt(session, project)
    assert {j.job for j in r.jobs} == {"invoices", "tickets"}
    assert r.cost_per_success.value_usd == pytest.approx(0.20)
    assert "own definition" in r.cost_per_success.success_definition


async def test_the_endpoint_returns_the_receipt_and_checks_its_inputs(client, session, world):
    project, job, headers = world
    add_run(session, project, job, cost="0.10", outcome="PASS")
    add_run(session, project, job, cost=None, status="NO_USAGE", outcome="UNKNOWN", state="CAPTURED")
    await session.commit()
    body = (await client.get("/v1/insights/cost-receipt?days=7", headers=headers)).json()
    assert body["currency"] == "USD" and body["unpriced_note"] == "1 unpriced run excluded from this total"
    assert body["cost_per_success"]["value_usd"] == pytest.approx(0.10)
    assert (await client.get("/v1/insights/cost-receipt?days=7&job=invoices", headers=headers)).status_code == 200
    assert (await client.get("/v1/insights/cost-receipt?job=nope", headers=headers)).status_code == 404
    assert (await client.get("/v1/insights/cost-receipt?days=0", headers=headers)).status_code == 422
    assert (await client.get("/v1/insights/cost-receipt")).status_code in (401, 403)


async def test_another_projects_calls_are_never_counted(client, session, world):
    project, job, headers = world
    other, _ = await create_project(session, "proj2")
    other_job = Job(project_id=other.project_id, name="x", check_kind="LATE_LABEL", check_config={})
    session.add(other_job)
    await session.flush()
    add_run(session, other, other_job, cost="7.00")
    add_run(session, project, job, cost="0.10")
    await session.commit()
    assert (await receipt(session, project)).spend_usd == pytest.approx(0.10)
