"""Defining jobs and recording runs through the API (embedded Postgres)."""

import uuid
from decimal import Decimal

import pytest
from sqlalchemy import select, text

from agent_memory.ingest import prompt_hash
from agent_memory.models import CatalogEntry, OutboxRow, Project, Run
from agent_memory.security import generate_key, hash_key


@pytest.fixture
async def project(session):
    key = generate_key()
    session.add(Project(project_id="demo", api_key_hash=hash_key(key)))
    await session.commit()
    return {"X-API-Key": key}


JOB = {"name": "invoice-extract", "check_kind": "ANSWER_KEY", "check_config": {"fields": ["vendor", "total"]}}


def run_body(**over):
    body = {
        "run_id": str(uuid.uuid4()), "job": "invoice-extract", "prompt": "Extract the total.",
        "model": "mini", "model_version": "2026-09", "tokens_in": 800, "tokens_out": 100,
        "output": '{"total": 12.5}', "latency_ms": 420,
    }
    return {**body, **over}


async def test_a_job_can_be_created_and_listed(client, project):
    created = await client.post("/v1/jobs", json=JOB, headers=project)
    assert created.status_code == 201
    assert created.json()["name"] == "invoice-extract" and created.json()["run_count"] == 0
    listed = (await client.get("/v1/jobs", headers=project)).json()
    assert [j["name"] for j in listed] == ["invoice-extract"]


async def test_a_duplicate_job_name_is_a_conflict(client, project):
    assert (await client.post("/v1/jobs", json=JOB, headers=project)).status_code == 201
    assert (await client.post("/v1/jobs", json=JOB, headers=project)).status_code == 409


@pytest.mark.parametrize(
    "bad",
    [
        {"name": "x", "check_kind": "ANSWER_KEY", "check_config": {}},
        {"name": "x", "check_kind": "SCHEMA", "check_config": {"schema": {"type": "not-a-type"}}},
        {"name": "x", "check_kind": "TEST_COMMAND", "check_config": {"command": "pytest"}},
        {"name": "bad name", "check_kind": "LATE_LABEL", "check_config": {}},
    ],
)
async def test_invalid_job_definitions_are_rejected(client, project, bad):
    assert (await client.post("/v1/jobs", json=bad, headers=project)).status_code == 422


async def test_a_run_is_accepted_and_stored_with_its_outbox_row(client, project, session):
    await client.post("/v1/jobs", json=JOB, headers=project)
    body = run_body()
    r = await client.post("/v1/runs", json=body, headers=project)
    assert r.status_code == 202 and r.json() == {"run_id": body["run_id"], "status": "accepted"}

    stored = (await session.execute(select(Run))).scalar_one()
    assert str(stored.run_id) == body["run_id"]
    assert stored.outcome == "UNKNOWN" and stored.state == "CAPTURED"  # outcomes arrive in Week 4
    assert stored.prompt_hash == prompt_hash("Extract the total.")
    outbox = (await session.execute(select(OutboxRow))).scalar_one()
    assert outbox.run_id == stored.run_id and outbox.status == "PENDING" and outbox.op == "UPSERT"


async def test_a_retried_send_is_a_duplicate_and_changes_nothing(client, project, session):
    await client.post("/v1/jobs", json=JOB, headers=project)
    body = run_body()
    assert (await client.post("/v1/runs", json=body, headers=project)).json()["status"] == "accepted"
    again = await client.post("/v1/runs", json={**body, "tokens_out": 9999}, headers=project)
    assert again.status_code == 202 and again.json()["status"] == "duplicate"
    assert (await session.execute(text("SELECT count(*) FROM runs"))).scalar_one() == 1
    assert (await session.execute(text("SELECT count(*) FROM outbox"))).scalar_one() == 1
    assert (await session.execute(select(Run.tokens_out))).scalar_one() == 100  # the first send wins


async def test_an_unknown_job_is_a_404_and_is_never_auto_created(client, project):
    r = await client.post("/v1/runs", json=run_body(job="nope"), headers=project)
    assert r.status_code == 404 and "POST /v1/jobs" in r.json()["detail"]
    assert (await client.get("/v1/jobs", headers=project)).json() == []


async def test_the_outcome_cannot_be_supplied_by_the_client(client, project, session):
    await client.post("/v1/jobs", json=JOB, headers=project)
    await client.post("/v1/runs", json=run_body(outcome="PASS", state="INDEXED"), headers=project)
    stored = (await session.execute(select(Run))).scalar_one()
    assert stored.outcome == "UNKNOWN" and stored.state == "CAPTURED"


@pytest.mark.parametrize(
    "bad",
    [
        {"prompt": ""},
        {"prompt": "x" * (256 * 1024 + 1)},
        {"tokens_in": -1},
        {"tokens_out": 10**9},
        {"cost_usd": -0.5},
        {"prompt_version": "v" * 65},
        {"tool_calls": [{}] * 101},
        {"run_id": "not-a-uuid"},
    ],
)
async def test_invalid_runs_are_rejected_before_any_write(client, project, session, bad):
    await client.post("/v1/jobs", json=JOB, headers=project)
    assert (await client.post("/v1/runs", json=run_body(**bad), headers=project)).status_code == 422
    assert (await session.execute(text("SELECT count(*) FROM runs"))).scalar_one() == 0


async def test_cost_comes_from_the_catalog_price_when_there_is_one(client, project, session):
    session.add(CatalogEntry(model="mini", model_version="2026-09", provider="acme",
                             price_in_per_mtok=Decimal("3"), price_out_per_mtok=Decimal("15")))
    await session.commit()
    await client.post("/v1/jobs", json=JOB, headers=project)
    body = run_body(tokens_in=2000, tokens_out=500, cache_read_tokens=1000, cost_usd=99)
    await client.post("/v1/runs", json=body, headers=project)
    cost = (await session.execute(select(Run.cost_usd))).scalar_one()
    assert cost == Decimal("0.013800")  # (2000x3 + 500x15 + 1000x0.3) per million; the client cost of 99 is ignored


async def test_cost_falls_back_to_the_sender_then_to_zero_without_a_price(client, project, session):
    await client.post("/v1/jobs", json=JOB, headers=project)
    await client.post("/v1/runs", json=run_body(cost_usd=0.25), headers=project)
    await client.post("/v1/runs", json=run_body(), headers=project)
    costs = sorted((await session.execute(select(Run.cost_usd))).scalars().all())
    assert costs == [Decimal("0.000000"), Decimal("0.250000")]


async def test_runs_need_a_key(client, project):
    assert (await client.post("/v1/runs", json=run_body())).status_code == 401
    assert (await client.post("/v1/jobs", json=JOB)).status_code == 401
