"""The cost-by-feature file and the planner file: who may download them, what is in them, and what is never in them.

Real Postgres, made-up data, no external connection."""

import csv
import io
import uuid
from datetime import UTC, datetime, timedelta
from decimal import Decimal

import pytest
from sqlalchemy import select

from agent_memory.exports import FEATURE_COLUMNS, FORMULA_LEADS, PLANNER_COLUMNS
from agent_memory.models import Job, PriceVersion, Run
from tests.test_company_overview import SECRET, _company, _project
from tests.test_exports import _company_project, dev_login  # noqa: F401  (the fixture is used by name)


def parse(text):
    return list(csv.reader(io.StringIO(text.removeprefix("﻿"), newline="")))


async def _mine(client, dev_login, name="Mine"):  # noqa: F811
    await dev_login(client, "owner@example.com")
    pid = (await client.post("/v1/projects", json={"name": name})).json()["project"]["project_id"]
    return pid, {"X-Project-Id": pid}


async def _job(client, headers, name="invoice"):
    assert (await client.post("/v1/jobs", json={"name": name, "check_kind": "ANSWER_KEY", "check_config": {"fields": ["t"]}}, headers=headers)).status_code == 201


def _run(session, pid, job, *, feature=None, outcome="PASS", cost="0.01", tin=1000, tout=500, version=None, status="PRICED", age=1):
    session.add(Run(
        run_id=uuid.uuid4(), job_id=job.job_id, project_id=pid, prompt=SECRET, output="SECRET ANSWER", prompt_hash="h", model="mini", model_version="mini",
        provider="acme", tokens_in=tin, tokens_out=tout, cost_usd=Decimal(cost) if cost is not None else None, outcome=outcome, state="CHECKED",
        usage_shape="openai_chat", feature=feature, price_status=status, price_version_id=version.version_id if version else None,
        created_at=datetime.now(UTC) - timedelta(days=age)))


# ---- cost by feature ----------------------------------------------------------------------------------------------------

async def test_the_feature_file_has_one_row_per_label_with_units_and_no_text(client, session, dev_login):  # noqa: F811
    pid, h = await _mine(client, dev_login)
    await _job(client, h)
    job = (await session.execute(select(Job).where(Job.project_id == pid))).scalar_one()
    for _ in range(4):
        _run(session, pid, job, feature="support_summary")
    _run(session, pid, job, feature="support_summary", outcome="FAIL")
    for _ in range(3):
        _run(session, pid, job, feature=None, outcome="UNKNOWN")
    _run(session, pid, job, feature="invoice_reader", cost=None, status="UNPRICED_UNKNOWN_MODEL", outcome="UNKNOWN")
    await session.commit()
    r = await client.get("/v1/insights/features/export.csv?days=30", headers=h)
    assert r.status_code == 200 and r.headers["content-type"].startswith("text/csv") and "attachment" in r.headers["content-disposition"]
    assert r.text.startswith("﻿") and "cost-by-feature-last-30-days" in r.headers["content-disposition"]
    rows = parse(r.text)
    assert rows[0] == [("spend_usd" if c == "spend_usd" else c) for c in FEATURE_COLUMNS]
    body = {row[0]: dict(zip(rows[0], row, strict=True)) for row in rows[1:]}
    assert set(body) == {"support_summary", "Unlabelled", "invoice_reader"} and r.headers["x-export-rows"] == "3"
    s = body["support_summary"]
    assert (s["runs"], s["passed"], s["failed"], s["currency"]) == ("5", "4", "1", "USD") and s["label_kind"] == "your label"
    assert body["Unlabelled"]["label_kind"] == "no label sent"
    assert body["invoice_reader"]["unpriced_runs"] == "1" and body["invoice_reader"]["cost_per_correct_answer_usd"] == ""  # unknown stays empty, not 0
    assert "not verified" in s["label_note"] and "list price" in s["cost_basis"]
    assert SECRET not in r.text and "SECRET ANSWER" not in r.text


async def test_the_feature_file_follows_the_period(client, session, dev_login):  # noqa: F811
    pid, h = await _mine(client, dev_login)
    await _job(client, h)
    job = (await session.execute(select(Job).where(Job.project_id == pid))).scalar_one()
    _run(session, pid, job, feature="recent", age=2)
    _run(session, pid, job, feature="old", age=40)
    await session.commit()
    assert {r[0] for r in parse((await client.get("/v1/insights/features/export.csv?days=7", headers=h)).text)[1:]} == {"recent"}
    assert {r[0] for r in parse((await client.get("/v1/insights/features/export.csv?days=90", headers=h)).text)[1:]} == {"recent", "old"}


async def test_an_empty_period_gives_only_the_column_names(client, dev_login):  # noqa: F811
    _, h = await _mine(client, dev_login)
    r = await client.get("/v1/insights/features/export.csv", headers=h)
    assert r.status_code == 200 and len(parse(r.text)) == 1 and r.headers["x-export-rows"] == "0"


# ---- the planner file ---------------------------------------------------------------------------------------------------

async def _priced_task(client, session, dev_login, *, name="invoice", calls=40):  # noqa: F811
    pid, h = await _mine(client, dev_login)
    job = Job(project_id=pid, name=name, check_kind="ANSWER_KEY", check_config={"fields": ["t"]})  # inserted directly: the API refuses names like "=cmd"
    session.add(job)
    await session.flush()
    v = PriceVersion(scope="catalog", model="mini", model_version="", provider="acme", input_per_mtok=1, output_per_mtok=2, source_kind="MANUAL",
                     effective_from=datetime.now(UTC) - timedelta(days=100))
    session.add(v)
    await session.flush()
    for i in range(calls):
        _run(session, pid, job, version=v, tin=800 + (i % 7) * 100, tout=300 + (i % 5) * 50, cost="0.002")
    await session.commit()
    return pid, h


async def test_the_planner_file_matches_the_screen_and_carries_its_assumptions(client, session, dev_login):  # noqa: F811
    _, h = await _priced_task(client, session, dev_login)
    q = {"job": "invoice", "calls": [100, 1000], "retry_rate": 0.25, "input_change_pct": 10, "output_change_pct": -5, "period": "week"}
    screen = (await client.get("/v1/insights/planner", params=q, headers=h)).json()["models"][0]
    r = await client.get("/v1/insights/planner/export.csv", params=q, headers=h)
    assert r.status_code == 200 and "planner-invoice" in r.headers["content-disposition"] and r.text.startswith("﻿")
    rows = parse(r.text)
    assert rows[0] == list(PLANNER_COLUMNS) and len(rows) == 3 and r.headers["x-export-rows"] == "2"
    first = dict(zip(rows[0], rows[1], strict=True))
    assert float(first["estimate_usd"]) == pytest.approx(screen["scenarios"][0]["estimate_usd"], abs=1e-6)  # the file keeps six decimals
    assert float(first["low_usd"]) == pytest.approx(screen["scenarios"][0]["low_usd"], abs=1e-6)
    assert (first["tasks_per_period"], first["period"], first["retry_rate"], first["input_size_change_pct"], first["output_size_change_pct"]) == ("100", "week", "0.25", "10.0", "-5.0")
    assert "not a bill" in first["estimate_basis"] and "typed by the user" in first["assumptions_source"] and first["currency"] == "USD"
    assert "in force from" in first["price_versions_used"] and first["calls_used"] == "40"
    assert SECRET not in r.text and "SECRET ANSWER" not in r.text


async def test_a_scenario_with_too_little_data_is_blank_not_zero(client, session, dev_login):  # noqa: F811
    _, h = await _priced_task(client, session, dev_login, calls=3)
    rows = parse((await client.get("/v1/insights/planner/export.csv", params={"job": "invoice", "calls": [1000]}, headers=h)).text)
    row = dict(zip(rows[0], rows[1], strict=True))
    assert row["estimate_usd"] == "" and row["low_usd"] == "" and row["per_task_usd"] == "" and "Not enough comparable data" in row["result"]


async def test_a_range_is_blank_when_only_one_estimate_is_honest(client, session, dev_login):  # noqa: F811
    _, h = await _priced_task(client, session, dev_login, calls=10)
    rows = parse((await client.get("/v1/insights/planner/export.csv", params={"job": "invoice", "calls": [1000]}, headers=h)).text)
    row = dict(zip(rows[0], rows[1], strict=True))
    assert row["estimate_usd"] != "" and row["low_usd"] == "" and row["high_usd"] == "" and "range needs" in row["result"]


async def test_a_task_name_that_could_run_as_a_formula_is_neutralized(client, session, dev_login):  # noqa: F811
    _, h = await _priced_task(client, session, dev_login, name="=cmd|calc")
    r = await client.get("/v1/insights/planner/export.csv", params={"job": "=cmd|calc", "calls": [100]}, headers=h)
    rows = parse(r.text)
    assert rows[1][0] == "'=cmd|calc" and int(r.headers["x-export-neutralized"]) >= 1
    assert not any(cell.startswith(FORMULA_LEADS) for row in rows[1:] for cell in row)


async def test_bad_assumptions_and_unknown_tasks_are_refused_before_a_file_is_made(client, session, dev_login):  # noqa: F811
    _, h = await _priced_task(client, session, dev_login, calls=2)
    for bad in ({"calls": [0]}, {"calls": [2_000_000_000]}, {"retry_rate": -1}, {"input_change_pct": -100}, {"period": "decade"}):
        assert (await client.get("/v1/insights/planner/export.csv", params={"job": "invoice", **bad}, headers=h)).status_code == 422, bad
    assert (await client.get("/v1/insights/planner/export.csv", params={"job": "nope"}, headers=h)).status_code == 404


# ---- who may download -------------------------------------------------------------------------------------------------

async def test_a_project_key_cannot_download_either_file(client, session):
    from tests.test_exports import _project_with_runs
    key, _ = await _project_with_runs(session)
    for path in ("/v1/insights/features/export.csv", "/v1/insights/planner/export.csv?job=invoice"):
        r = await client.get(path, headers={"X-API-Key": key})
        assert r.status_code == 403 and "Only an admin or owner can export" in r.json()["detail"], path


async def test_only_admins_and_owners_get_the_files_and_each_download_is_recorded_without_content(client, session, dev_login):  # noqa: F811
    org, pid = await _company_project(client, dev_login, session)
    job = Job(project_id=pid, name="invoice", check_kind="ANSWER_KEY", check_config={"fields": ["t"]})
    session.add(job)
    await session.commit()
    await session.refresh(job)
    for _ in range(6):
        _run(session, pid, job, feature="support_summary")
    await session.commit()
    h = {"X-Project-Id": pid}
    paths = ("/v1/insights/features/export.csv?days=7", "/v1/insights/planner/export.csv?job=invoice")
    for email, expected in (("viewer@example.com", 403), ("member@example.com", 403), ("admin@example.com", 200), ("owner@example.com", 200)):
        await dev_login(client, email)
        for path in paths:
            r = await client.get(path, headers=h)
            assert r.status_code == expected, (email, path, r.status_code)
            if expected == 403:
                assert "Only an admin or owner can export" in r.json()["detail"] and SECRET not in r.text
    await dev_login(client, "owner@example.com")
    events = [e for e in (await client.get(f"/v1/organisations/{org}/events")).json() if e["action"] == "project_data_exported"]
    assert {e["detail"].get("export") for e in events} >= {"features", "planner"}
    assert SECRET not in str(events) and "SECRET ANSWER" not in str(events)


async def test_another_projects_numbers_never_appear(client, session, dev_login):  # noqa: F811
    await dev_login(client, "owner@example.com")
    org = await _company(client)
    other = await _project(client, session, org, "Other", "per_use")
    job = Job(project_id=other, name="rival", check_kind="ANSWER_KEY", check_config={"fields": ["t"]})
    session.add(job)
    await session.commit()
    await session.refresh(job)
    _run(session, other, job, feature="rival_feature")
    await session.commit()
    _, h = await _mine(client, dev_login, "Mine two")
    assert "rival_feature" not in (await client.get("/v1/insights/features/export.csv", headers=h)).text
    assert (await client.get("/v1/insights/planner/export.csv", params={"job": "rival"}, headers=h)).status_code == 404
