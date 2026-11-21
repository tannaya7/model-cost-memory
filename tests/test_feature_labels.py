"""The optional feature label: a customer's own name for the feature or workflow a call serves.

It is optional, validated, never inferred from text, never verified, and the breakdown by label follows the same rules as the cost receipt:
an unknown cost is never zero, cost per correct answer uses only checked and priced calls, and calls with no label are shown, not hidden.
Real Postgres, made-up data, nothing leaves the machine."""

import uuid
from datetime import UTC, datetime, timedelta
from decimal import Decimal

import pytest
from sqlalchemy import select

from agent_memory.models import Job, Run
from agent_memory.projects import create_project

JOB = {"name": "support", "check_kind": "ANSWER_KEY", "check_config": {"fields": ["t"]}}


@pytest.fixture
async def keyed(client, session):
    _, key = await create_project(session, "proj1")
    headers = {"X-API-Key": key}
    await client.post("/v1/jobs", json=JOB, headers=headers)
    return headers


def body(**over):
    base = {"run_id": str(uuid.uuid4()), "job": "support", "prompt": "Summarise this support ticket", "model": "m", "model_version": "m-1",
            "tokens_in": 10, "tokens_out": 5}
    base.update(over)
    return base


async def job_id(session, project_id="proj1", name="support"):
    return (await session.execute(select(Job.job_id).where(Job.project_id == project_id, Job.name == name))).scalar_one()


async def add(session, project_id, jid, feature, n, *, cost="0.01", outcome="PASS", shape="openai_chat", state="INDEXED", kind="PRODUCTION", days_ago=1):
    for i in range(n):
        session.add(Run(
            run_id=uuid.uuid4(), job_id=jid, project_id=project_id, prompt="p", prompt_hash=f"h{uuid.uuid4()}", model="m", model_version="m-1",
            tokens_in=100, tokens_out=10, cost_usd=None if cost is None else Decimal(cost), price_status=None if cost is None else "PRICED",
            outcome=outcome, state=state, usage_shape=shape, run_kind=kind, feature=feature,
            created_at=datetime.now(UTC) - timedelta(days=days_ago, minutes=i)))
    await session.commit()


async def breakdown(client, headers, days=30):
    r = await client.get(f"/v1/insights/features?days={days}", headers=headers)
    assert r.status_code == 200, r.text
    return r.json()


# ---- sending a label ---------------------------------------------------------------------------------------------------------

async def test_a_call_with_no_label_is_accepted_exactly_as_before(client, keyed):
    r = await client.post("/v1/runs", json=body(), headers=keyed)
    assert r.status_code == 202
    assert (await client.get("/v1/runs", headers=keyed)).json()["items"][0]["feature"] is None


async def test_a_label_is_stored_and_shown_on_the_run(client, keyed):
    assert (await client.post("/v1/runs", json=body(feature="support_summary"), headers=keyed)).status_code == 202
    assert (await client.get("/v1/runs", headers=keyed)).json()["items"][0]["feature"] == "support_summary"


@pytest.mark.parametrize("bad", ["", "x" * 101, "a\nb", "<script>", "-start", "é", "a/b", "; drop table runs"])
async def test_an_unsafe_or_oversized_label_is_refused_clearly(client, keyed, bad):
    r = await client.post("/v1/runs", json=body(feature=bad), headers=keyed)
    assert r.status_code == 422 and "feature" in r.text


@pytest.mark.parametrize("good", ["a", "support_summary", "Invoice reader v2", "billing.refunds-2", "x" * 100])
async def test_ordinary_labels_are_accepted(client, keyed, good):
    assert (await client.post("/v1/runs", json=body(feature=good), headers=keyed)).status_code == 202


# ---- the breakdown ------------------------------------------------------------------------------------------------------------

async def test_the_breakdown_groups_by_label_and_shows_unlabelled_calls_as_their_own_row(client, session, keyed):
    jid = await job_id(session)
    await add(session, "proj1", jid, "support_summary", 8, outcome="PASS")
    await add(session, "proj1", jid, "support_summary", 2, outcome="FAIL")
    await add(session, "proj1", jid, "invoice_reader", 5, cost="0.04", outcome="UNKNOWN")
    await add(session, "proj1", jid, None, 2, cost="0.05", outcome="PASS")
    await add(session, "proj1", jid, None, 2, cost=None, outcome="PASS", shape="none")
    d = await breakdown(client, keyed)
    assert [r["label"] for r in d["rows"]] == ["invoice_reader", "support_summary", "Unlabelled"]  # by spend, then by calls
    inv, sup, un = d["rows"]
    assert (sup["runs"], sup["passed"], sup["failed"], sup["unchecked"]) == (10, 8, 2, 0)
    assert sup["spend_usd"] == pytest.approx(0.10) and sup["tokens"] == 1100
    assert sup["cost_per_success"]["value_usd"] == pytest.approx(0.10 / 8)
    assert (d["total_runs"], d["labelled_runs"]) == (19, 15) and d["labelled_share"] == pytest.approx(15 / 19)
    assert sum(r["share_of_spend"] for r in d["rows"]) == pytest.approx(1.0)
    assert inv["feature"] == "invoice_reader" and inv["share_of_spend"] == pytest.approx(0.5)
    assert un["feature"] is None and un["runs"] == 4


async def test_an_unknown_cost_is_never_zero_and_unknown_tokens_are_counted_apart(client, session, keyed):
    jid = await job_id(session)
    await add(session, "proj1", jid, None, 2, cost="0.05", outcome="PASS")
    await add(session, "proj1", jid, None, 2, cost=None, outcome="PASS", shape="none")
    (un,) = (await breakdown(client, keyed))["rows"]
    assert un["spend_usd"] == pytest.approx(0.10)  # the two unpriced calls add nothing, and are not counted as free
    assert un["unpriced_runs"] == 2
    assert un["no_usage_runs"] == 2 and un["tokens"] == 220  # tokens only over the calls whose response reported usage
    assert un["cost_per_success"]["checked_priced_runs"] == 2 and un["cost_per_success"]["checked_unpriced_runs"] == 2


async def test_cost_per_correct_answer_needs_a_check_and_says_why_when_it_does_not_exist(client, session, keyed):
    jid = await job_id(session)
    await add(session, "proj1", jid, "unchecked_feature", 5, outcome="UNKNOWN")
    await add(session, "proj1", jid, "all_failed", 3, outcome="FAIL")
    rows = {r["label"]: r for r in (await breakdown(client, keyed))["rows"]}
    a, b = rows["unchecked_feature"]["cost_per_success"], rows["all_failed"]["cost_per_success"]
    assert a["value_usd"] is None and "checked" in a["reason"] and a["unchecked_runs"] == 5
    assert b["value_usd"] is None and "None of the checked calls passed" in b["reason"]  # a failed check is not called waste, and no division by zero


async def test_archived_and_failed_to_record_calls_are_counted_apart_not_as_passes(client, session, keyed):
    jid = await job_id(session)
    await add(session, "proj1", jid, "f", 3, outcome="PASS")
    await add(session, "proj1", jid, "f", 2, outcome="PASS", state="ARCHIVED")
    (row,) = (await breakdown(client, keyed))["rows"]
    assert (row["runs"], row["passed"], row["excluded"]) == (5, 3, 2)


async def test_only_the_apps_own_calls_in_the_period_are_counted(client, session, keyed):
    jid = await job_id(session)
    await add(session, "proj1", jid, "f", 3)
    await add(session, "proj1", jid, "f", 4, kind="RETEST")  # a replay is not the app's traffic
    await add(session, "proj1", jid, "f", 5, days_ago=60)  # outside 30 days
    (row,) = (await breakdown(client, keyed, 30))["rows"]
    assert row["runs"] == 3
    assert (await breakdown(client, keyed, 90))["rows"][0]["runs"] == 8


async def test_many_labels_are_shown_up_to_a_limit_and_the_rest_are_added_together_without_losing_a_call(client, session, keyed):
    jid = await job_id(session)
    for i in range(30):
        await add(session, "proj1", jid, f"feature_{i:02d}", 1, cost=str(0.01 + i / 1000))
    d = await breakdown(client, keyed)
    assert len(d["rows"]) == 26 and d["rows"][-1]["label"] == "Other labels" and d["rows"][-1]["folded_labels"] == 5
    assert sum(r["runs"] for r in d["rows"]) == 30 == d["total_runs"]  # folding loses nothing
    assert d["truncated"] is False


async def test_nothing_is_inferred_from_the_prompt_text(client, session, keyed):
    jid = await job_id(session)
    await client.post("/v1/runs", json=body(prompt="support summary for the billing team, invoice reader"), headers=keyed)
    await session.commit()
    (row,) = (await breakdown(client, keyed))["rows"]
    assert row["feature"] is None and row["label"] == "Unlabelled" and jid


async def test_notes_say_the_labels_are_the_customers_own_and_the_amounts_are_estimates(client, session, keyed):
    jid = await job_id(session)
    await add(session, "proj1", jid, "f", 1)
    notes = " ".join((await breakdown(client, keyed))["notes"])
    assert "not verified identities" in notes and "not invoice-grade" in notes and "not your invoice" in notes and "UTC" in notes


# ---- who may see it, and what bounds it ------------------------------------------------------------------------------------------

async def test_one_project_never_sees_another_projects_labels(client, session, keyed):
    _, other_key = await create_project(session, "proj2")
    other = {"X-API-Key": other_key}
    await client.post("/v1/jobs", json=JOB, headers=other)
    await add(session, "proj1", await job_id(session), "mine_only", 3)
    await add(session, "proj2", await job_id(session, "proj2"), "theirs_only", 2)
    assert [r["label"] for r in (await breakdown(client, keyed))["rows"]] == ["mine_only"]
    assert [r["label"] for r in (await breakdown(client, other))["rows"]] == ["theirs_only"]


async def test_the_period_is_bounded_and_a_missing_key_is_refused(client, keyed):
    assert (await client.get("/v1/insights/features?days=0", headers=keyed)).status_code == 422
    assert (await client.get("/v1/insights/features?days=366", headers=keyed)).status_code == 422
    assert (await client.get("/v1/insights/features")).status_code == 401


async def test_a_signed_in_viewer_can_read_it_and_a_stranger_gets_nothing(client, session, monkeypatch):
    monkeypatch.setenv("DEV_LOGIN", "true")
    await client.post("/auth/dev/login", json={"email": "owner@example.com"})
    org = (await client.post("/v1/organisations", json={"name": "Acme"})).json()["org_id"]
    made = (await client.post("/v1/projects", json={"name": "App", "organisation_id": org})).json()
    pid = made["project"]["project_id"]
    await client.post("/v1/jobs", json=JOB, headers={"X-API-Key": made["api_key"]})
    await add(session, pid, await job_id(session, pid), "f", 2)
    invite = (await client.post(f"/v1/organisations/{org}/invites", json={"email": "viewer@example.com", "role": "viewer"})).json()["token"]
    await client.post("/auth/logout")
    await client.post("/auth/dev/login", json={"email": "viewer@example.com"})
    await client.post("/v1/invites/accept", json={"token": invite})
    assert (await client.get("/v1/insights/features", headers={"X-Project-Id": pid})).status_code == 200
    await client.post("/auth/logout")
    await client.post("/auth/dev/login", json={"email": "stranger@example.com"})
    assert (await client.get("/v1/insights/features", headers={"X-Project-Id": pid})).status_code == 404
