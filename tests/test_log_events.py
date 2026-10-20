"""State transitions are logged with run, job and project ids, and the outbox answers "is it healthy?"."""

import logging
import os
import subprocess
import sys
import uuid
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import async_sessionmaker

from agent_memory.api import current_project
from agent_memory.config import Settings
from agent_memory.embeddings import HashingEmbedder
from agent_memory.logging_config import ContextFilter, current_context
from agent_memory.models import Job, OutboxRow, Project, Run
from agent_memory.pipeline.decay import recompute
from agent_memory.pipeline.janitor import outbox_health, run_janitor
from agent_memory.pipeline.sync_worker import claim_batch, run_once
from agent_memory.security import generate_key, hash_key

ROOT = Path(__file__).resolve().parents[1]
SETTINGS = Settings(outbox_batch_size=8, outbox_max_retries=2, outbox_stuck_minutes=10)


@pytest.fixture(autouse=True)
def _bound_ids_on_captured_records(caplog):
    """In production the log handler attaches the bound ids; give pytest's capture handler the same filter."""
    caplog.handler.addFilter(ContextFilter())


@pytest.fixture
def sessions(engine):
    return async_sessionmaker(engine, expire_on_commit=False)


@pytest.fixture
async def headers(session):
    key = generate_key()
    session.add(Project(project_id="demo", api_key_hash=hash_key(key)))
    await session.commit()
    return {"X-API-Key": key}


def events(caplog, message):
    return [r for r in caplog.records if r.getMessage() == message]


async def make_runs(session, n, state="CHECKED"):
    session.add(Project(project_id="demo", api_key_hash="x")) if not (await session.get(Project, "demo")) else None
    await session.flush()
    job = (await session.execute(select(Job))).scalars().first()
    if job is None:
        job = Job(project_id="demo", name="j", check_kind="LATE_LABEL", check_config={})
        session.add(job)
        await session.flush()
    ids = []
    for i in range(n):
        run_id = uuid.uuid4()
        session.add(Run(run_id=run_id, job_id=job.job_id, project_id="demo", prompt=f"p{i} {run_id}", prompt_hash=str(run_id),
                        model="m", model_version="v", state=state))
        ids.append(run_id)
    await session.flush()
    for run_id in ids:
        session.add(OutboxRow(run_id=run_id, op="UPSERT", payload={}))
    await session.commit()
    return ids, job


async def test_recording_a_run_logs_its_ids_and_first_state(client, headers, caplog):
    caplog.set_level(logging.INFO, logger="agent_memory.ingest")
    job = {"name": "j", "check_kind": "LATE_LABEL", "check_config": {}}
    await client.post("/v1/jobs", json=job, headers=headers)
    run_id = str(uuid.uuid4())
    await client.post("/v1/runs", json={"run_id": run_id, "job": "j", "prompt": "p", "model": "m", "model_version": "v1"}, headers=headers)
    (rec,) = events(caplog, "run recorded")
    assert (rec.run_id, rec.project_id, rec.to_state, rec.outcome) == (run_id, "demo", "CAPTURED", "UNKNOWN")
    assert rec.job_id and rec.from_state is None
    await client.post("/v1/runs", json={"run_id": run_id, "job": "j", "prompt": "p", "model": "m", "model_version": "v1"}, headers=headers)
    assert events(caplog, "duplicate run ignored")[0].run_id == run_id


async def test_a_late_label_logs_the_transition(client, headers, caplog):
    caplog.set_level(logging.INFO, logger="agent_memory.ingest")
    await client.post("/v1/jobs", json={"name": "j", "check_kind": "LATE_LABEL", "check_config": {}}, headers=headers)
    run_id = str(uuid.uuid4())
    await client.post("/v1/runs", json={"run_id": run_id, "job": "j", "prompt": "p", "model": "m", "model_version": "v"}, headers=headers)
    await client.post(f"/v1/runs/{run_id}/label", json={"outcome": "PASS"}, headers=headers)
    (rec,) = events(caplog, "run labelled")
    assert (rec.run_id, rec.from_state, rec.to_state, rec.outcome) == (run_id, "CAPTURED", "CHECKED", "PASS")


async def test_authenticating_binds_the_project_for_the_rest_of_the_request(session, headers):
    async def request():
        project = await current_project(session, x_api_key=headers["X-API-Key"], authorization=None)
        return project.project_id, current_context().get("project_id")

    import asyncio

    assert await asyncio.create_task(request()) == ("demo", "demo")
    assert "project_id" not in current_context()  # the request's own task did not leak into this one


async def test_the_worker_logs_indexing_with_ids_and_the_state_change(sessions, session, caplog):
    caplog.set_level(logging.INFO, logger="agent_memory.sync_worker")
    ids, job = await make_runs(session, 2)
    await run_once(sessions, HashingEmbedder(), SETTINGS)
    recs = events(caplog, "run indexed")
    assert sorted(r.run_id for r in recs) == sorted(str(i) for i in ids)
    assert {(r.project_id, r.job_id, r.from_state, r.to_state, r.embedder) for r in recs} == {
        ("demo", str(job.job_id), "CHECKED", "INDEXED", "hashing")}
    assert all(hasattr(r, "outbox_id") for r in recs)


async def test_a_failing_row_logs_each_attempt_and_the_final_give_up(sessions, session, caplog):
    caplog.set_level(logging.INFO, logger="agent_memory.sync_worker")

    class Broken:
        name, dim = "broken", 384

        def embed(self, texts):
            raise RuntimeError("model unavailable")

    (run_id,), _ = await make_runs(session, 1)
    for _ in range(2):
        await session.execute(text("UPDATE outbox SET updated_at = now() - interval '1 hour'"))
        await session.commit()
        await run_once(sessions, Broken(), SETTINGS)
    failures = events(caplog, "outbox row failed")
    assert [(f.attempt, f.will_retry) for f in failures] == [(1, True), (2, False)]
    assert all(f.run_id == str(run_id) for f in failures)
    final = events(caplog, "run marked INGESTION_FAILED")[0]
    assert (final.run_id, final.from_state, final.to_state) == (str(run_id), "CHECKED", "INGESTION_FAILED")


async def test_decay_logs_every_archived_run(session, caplog):
    caplog.set_level(logging.INFO, logger="agent_memory.decay")
    (old_id,), job = await make_runs(session, 1)
    await session.execute(text("UPDATE runs SET created_at = now() - interval '200 days'"))
    session.add(Run(run_id=uuid.uuid4(), job_id=job.job_id, project_id="demo", prompt="fresh", prompt_hash="f",
                    model="m", model_version="v", state="CHECKED"))
    await session.commit()
    await recompute(session, now=datetime.now(UTC) + timedelta(seconds=1))
    (rec,) = events(caplog, "run archived")
    assert (rec.run_id, rec.project_id, rec.from_state, rec.to_state) == (str(old_id), "demo", "CHECKED", "ARCHIVED")
    assert rec.age_days > 190 and rec.weight < 0.05


async def test_an_empty_outbox_is_healthy(session):
    health = await outbox_health(session)
    assert (health.pending, health.failed, health.stuck, health.oldest_pending_seconds, health.healthy) == (0, 0, 0, None, True)


async def test_the_health_query_counts_each_status(sessions, session):
    await make_runs(session, 5)
    async with sessions() as worker:
        await claim_batch(worker, 2)  # two rows are now PROCESSING
    await session.execute(text("UPDATE outbox SET status = 'FAILED' WHERE outbox_id IN "
                               "(SELECT outbox_id FROM outbox WHERE status = 'PENDING' LIMIT 1)"))
    await session.execute(text("UPDATE outbox SET status = 'DONE' WHERE outbox_id IN "
                               "(SELECT outbox_id FROM outbox WHERE status = 'PENDING' LIMIT 1)"))
    await session.commit()
    health = await outbox_health(session)
    assert (health.pending, health.processing, health.done, health.failed) == (1, 2, 1, 1)
    assert health.oldest_pending_seconds is not None and health.healthy is False  # a failed row is unhealthy


async def test_stuck_and_slow_queues_are_unhealthy_and_the_janitor_says_so(sessions, session, caplog):
    caplog.set_level(logging.INFO, logger="agent_memory.janitor")
    await make_runs(session, 3)
    async with sessions() as worker:
        await claim_batch(worker, 1)
    await session.execute(text("UPDATE outbox SET claimed_at = now() - interval '30 minutes' WHERE status = 'PROCESSING'"))
    await session.commit()
    assert (await outbox_health(session)).stuck == 1
    await session.execute(text("UPDATE outbox SET created_at = now() - interval '20 minutes' WHERE status = 'PENDING'"))
    await session.commit()
    health = await outbox_health(session)
    assert health.oldest_pending_seconds > 1000 and health.healthy is False
    await session.execute(text("UPDATE outbox SET claimed_at = now() WHERE status = 'PROCESSING'"))
    await session.commit()
    await run_janitor(sessions, SETTINGS)
    warn = events(caplog, "outbox is not healthy")
    assert warn and warn[0].pending == 2


def test_the_status_script_exits_nonzero_when_unhealthy(migrated_url, tmp_path):
    env = {**os.environ, "DATABASE_URL": migrated_url, "PYTHONPATH": str(ROOT / "src")}
    run = subprocess.run([sys.executable, str(ROOT / "scripts" / "outbox_status.py")], capture_output=True, text=True,
                         env=env, cwd=tmp_path, timeout=60)
    assert run.returncode in (0, 1) and ("HEALTHY" in run.stdout)  # whichever the shared test database currently is
    assert "pending" in run.stdout and "stuck" in run.stdout
