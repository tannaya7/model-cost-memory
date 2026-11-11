"""The mentor's review of PRs #3-#5: each finding, pinned by a test. Names and prices are made up."""

import time
import uuid
from datetime import UTC, datetime, timedelta

import httpx
import pytest
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import create_async_engine
from sqlalchemy.pool import NullPool

from agent_memory import recorder
from agent_memory.config import Settings, normalize_database_url
from agent_memory.db import make_engine
from agent_memory.embeddings import MODEL_REVISION, MiniLMEmbedder
from agent_memory.models import Job, OutboxRow, Run
from agent_memory.pipeline import decay
from agent_memory.pipeline.janitor import fail_unhandled
from agent_memory.projects import create_project
from agent_memory.scheduler import become_leader


@pytest.fixture
async def project(session):
    _, key = await create_project(session, "review")
    job = Job(project_id="review", name="invoice", check_kind="ANSWER_KEY", check_config={"fields": ["total"]})
    session.add(job)
    await session.commit()
    return {"X-API-Key": key}, job


def run(job, model, cost, *, outcome="PASS", age=0.0, version=None):
    return Run(run_id=uuid.uuid4(), job_id=job.job_id, project_id="review", prompt="p", prompt_hash="h",
               model=model, model_version=version or f"{model}-2026-09", outcome=outcome, cost_usd=cost,
               state="INDEXED", created_at=datetime.now(UTC) - timedelta(days=age))


# 1. An unpriced model must not look free.
async def test_an_unpriced_run_stores_no_cost_and_never_wins_on_cost(client, session, project):
    headers, job = project
    sent = await client.post("/v1/runs", headers=headers, json={
        "run_id": str(uuid.uuid4()), "job": "invoice", "prompt": "Invoice 1?", "model": "mystery-model",
        "model_version": "mystery-model-1", "output": '{"total": 1}', "expected": {"total": 1}})
    assert sent.status_code == 202
    stored = (await session.execute(select(Run))).scalar_one()
    assert stored.cost_usd is None  # unknown, not $0
    detail = (await client.get(f"/v1/runs/{stored.run_id}", headers=headers)).json()
    assert detail["cost_usd"] is None

    session.add_all([run(job, "big", 0.03) for _ in range(400)] + [run(job, "mystery-model", None) for _ in range(400)])
    await session.commit()
    body = (await client.get("/v1/jobs/invoice/recommendation", headers=headers)).json()
    mystery = next(m for m in body["models"] if m["model"] == "mystery-model")
    assert mystery["mean_cost_usd"] is None and not mystery["eligible"]
    assert body["recommended"]["model"] == "big"


async def test_a_partly_priced_model_is_averaged_over_its_priced_runs_only(client, session, project):
    headers, job = project
    session.add_all([run(job, "mid", 0.01) for _ in range(200)] + [run(job, "mid", None) for _ in range(200)])
    await session.commit()
    mid = (await client.get("/v1/jobs/invoice/recommendation", headers=headers)).json()["models"][0]
    assert mid["mean_cost_usd"] == pytest.approx(0.01)  # not 0.005: unknown is not zero


async def test_spend_reports_the_runs_it_could_not_price(client, session, project):
    headers, job = project
    session.add_all([run(job, "big", 0.03) for _ in range(10)] + [run(job, "mystery", None) for _ in range(4)])
    await session.commit()
    [row] = (await client.get("/v1/insights/spend", headers=headers)).json()
    assert (row["runs"], row["spend_usd"], row["unpriced_runs"]) == (14, pytest.approx(0.30), 4)


# 2 and 3. Decay works one job and one chunk at a time, and an odd row never stops the pass.
async def test_decay_pages_through_runs_and_fails_soft_on_an_unrecognised_version(session, project, monkeypatch):
    _, job = project
    session.add_all([run(job, "big", 0.03, age=1) for _ in range(25)])
    await session.commit()
    monkeypatch.setattr(decay, "CHUNK", 10)  # three pages

    real = decay.current_versions

    async def missing_one(s, job_id=None):  # as if the two queries disagreed about a version
        versions = await real(s, job_id)
        versions.pop(next(iter(versions)))
        return versions

    monkeypatch.setattr(decay, "current_versions", missing_one)
    stats = await decay.recompute(session, now=datetime.now(UTC))
    assert stats.scored == 25 and stats.superseded == 0  # treated as current, no KeyError


# 4. The connection pool is bounded.
def test_the_engine_pool_is_bounded_by_settings(monkeypatch):
    monkeypatch.setenv("DATABASE_URL", "postgresql://u:p@localhost/db")
    monkeypatch.setenv("DB_POOL_SIZE", "4")
    monkeypatch.setenv("DB_MAX_OVERFLOW", "1")
    engine = make_engine()
    assert (engine.pool.size(), engine.pool._max_overflow) == (4, 1)
    assert Settings().db_pool_size + Settings().db_max_overflow == 5  # 4 processes x 5 = 20 connections


# 6. Only one scheduler runs jobs.
async def test_only_one_scheduler_holds_the_leader_lock(migrated_url):
    url = normalize_database_url(migrated_url)
    first_engine = create_async_engine(url, poolclass=NullPool)
    second_engine = create_async_engine(url, poolclass=NullPool)
    leader = await become_leader(first_engine, wait=False)
    assert leader is not None
    assert await become_leader(second_engine, wait=False) is None  # standby
    await leader.close()  # the leader stops: its lock goes with its connection
    successor = await become_leader(second_engine, wait=False)
    assert successor is not None
    await successor.close()
    await first_engine.dispose()
    await second_engine.dispose()


# 7, 8 and 10. The SDK's sender.
def test_an_unreachable_api_opens_the_breaker_so_runs_are_dropped_at_once():
    calls = []

    def down(request):
        calls.append(request)
        raise httpx.ConnectError("refused")

    sender = recorder.Sender("http://api.invalid", "k", transport=httpx.MockTransport(down), retries=2,
                             backoff=0.0, breaker_threshold=3, breaker_cooldown=60)
    for _ in range(10):
        sender.submit({"run_id": str(uuid.uuid4())})
    assert sender.flush(5.0)
    assert len(calls) == 3 * 2  # three runs tried (twice each), then the breaker opened
    assert sender.dropped == 10
    sender.close()


def test_the_breaker_closes_again_after_its_cooldown():
    state = {"up": False}

    def flaky(request):
        if not state["up"]:
            raise httpx.ConnectError("refused")
        return httpx.Response(202, json={"run_id": "x", "status": "accepted"})

    sender = recorder.Sender("http://api.test", "k", transport=httpx.MockTransport(flaky), retries=1,
                             backoff=0.0, breaker_threshold=1, breaker_cooldown=0.05)
    sender.submit({"run_id": "a"})
    sender.flush(2.0)
    state["up"] = True
    time.sleep(0.1)
    sender.submit({"run_id": "b"})
    sender.flush(2.0)
    assert sender.sent == 1
    sender.close()


def test_exit_closes_the_default_sender(monkeypatch):
    registered = []
    monkeypatch.setattr(recorder, "_default_sender", None)
    monkeypatch.setattr(recorder.atexit, "register", registered.append)
    sender = recorder.default_sender()
    assert sender.close in registered and sender.flush not in registered
    sender.close()


# 11. An outbox op nobody handles fails instead of waiting for ever.
async def test_an_unhandled_outbox_op_is_failed_with_a_reason(session, project):
    _, job = project
    r = run(job, "big", 0.03)
    session.add(r)
    await session.flush()
    session.add(OutboxRow(run_id=r.run_id, op="RETEST", payload={}))
    await session.commit()
    assert await fail_unhandled(session) == 1
    row = (await session.execute(select(OutboxRow))).scalar_one()
    assert row.status == "FAILED" and "no worker handles op RETEST" in row.last_error


# 13. The embedder's name changes with its weights.
def test_the_minilm_name_carries_the_pinned_revision():
    assert MiniLMEmbedder.name == f"minilm@{MODEL_REVISION[:12]}"


# 15. The index on the growing runs table is built without locking it.
async def test_the_retest_index_on_runs_exists(session):
    found = (await session.execute(text("SELECT 1 FROM pg_indexes WHERE indexname = 'idx_runs_retest'"))).first()
    assert found is not None
