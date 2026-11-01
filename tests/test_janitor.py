"""The outbox janitor and the scheduler that runs it (embedded Postgres)."""

import uuid

import pytest
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import async_sessionmaker

from agent_memory.config import Settings
from agent_memory.embeddings import HashingEmbedder
from agent_memory.models import Job, OutboxRow, Project, Run
from agent_memory.pipeline.janitor import purge_done, requeue_stuck, run_janitor
from agent_memory.pipeline.sync_worker import claim_batch, run_once
from agent_memory.scheduler import build_scheduler

SETTINGS = Settings(outbox_batch_size=8, outbox_max_retries=3, outbox_stuck_minutes=10, outbox_done_retention_days=7)


@pytest.fixture
def sessions(engine):
    return async_sessionmaker(engine, expire_on_commit=False)


@pytest.fixture
async def seed(session):
    session.add(Project(project_id="demo", api_key_hash="x"))
    await session.flush()
    job = Job(project_id="demo", name="j", check_kind="LATE_LABEL", check_config={})
    session.add(job)
    await session.flush()

    async def make(n):
        ids = []
        for i in range(n):
            run_id = uuid.uuid4()
            session.add(Run(run_id=run_id, job_id=job.job_id, project_id="demo", prompt=f"p{i} {run_id}",
                            prompt_hash=str(run_id), model="m", model_version="v", state="CHECKED"))
            ids.append(run_id)
        await session.flush()
        for run_id in ids:
            session.add(OutboxRow(run_id=run_id, op="UPSERT", payload={}))
        await session.commit()
        return ids

    return make


async def age(session, column, minutes):
    await session.execute(text(f"UPDATE outbox SET {column} = now() - make_interval(mins => :m)"), {"m": minutes})
    await session.commit()


async def test_rows_left_by_a_crashed_worker_are_handed_back_and_then_processed_once(sessions, session, seed):
    ids = await seed(3)
    async with sessions() as dying_worker:
        assert len(await claim_batch(dying_worker, 8)) == 3  # claims everything, then "crashes"
    assert (await run_once(sessions, HashingEmbedder(), SETTINGS)).claimed == 0  # stuck: nobody can take them

    async with sessions() as s:
        assert await requeue_stuck(s, minutes=10, max_retries=3) == (0, 0)  # too recent to be called stuck
    await age(session, "claimed_at", 30)
    async with sessions() as s:
        assert await requeue_stuck(s, minutes=10, max_retries=3) == (3, 0)
    await age(session, "updated_at", 60)  # skip the retry backoff for the test

    stats = await run_once(sessions, HashingEmbedder(), SETTINGS)
    assert (stats.claimed, stats.done) == (3, 3)
    session.expunge_all()
    runs = (await session.execute(select(Run.state, Run.embedding))).all()
    assert len(runs) == 3 and {s for s, _ in runs} == {"INDEXED"} and all(e is not None for _, e in runs)
    assert len(ids) == 3


async def test_a_poison_row_that_keeps_killing_workers_ends_up_failed(sessions, session, seed):
    (run_id,) = await seed(1)
    for expected_failed in (0, 0, 1):
        async with sessions() as w:
            await claim_batch(w, 8)
        await age(session, "claimed_at", 30)
        async with sessions() as s:
            _, failed = await requeue_stuck(s, minutes=10, max_retries=3)
        assert failed == expected_failed
        await age(session, "updated_at", 60)
    session.expunge_all()
    assert (await session.execute(select(OutboxRow.status))).scalar_one() == "FAILED"
    assert (await session.get(Run, run_id)).state == "INGESTION_FAILED"


async def test_only_old_finished_rows_are_purged(sessions, session, seed):
    await seed(4)
    await session.execute(text("UPDATE outbox SET status = 'DONE'"))
    await session.execute(text(
        "UPDATE outbox SET updated_at = now() - interval '30 days' WHERE outbox_id IN "
        "(SELECT outbox_id FROM outbox ORDER BY outbox_id LIMIT 2)"))
    session.add(OutboxRow(run_id=None, op="UPSERT", payload={}))  # a PENDING row, however old, is never purged
    await session.commit()
    await session.execute(text("UPDATE outbox SET updated_at = now() - interval '30 days' WHERE status = 'PENDING'"))
    await session.commit()
    async with sessions() as s:
        assert await purge_done(s, days=7) == 2
    remaining = (await session.execute(select(OutboxRow.status))).scalars().all()
    assert sorted(remaining) == ["DONE", "DONE", "PENDING"]


async def test_run_janitor_reports_what_it_did(sessions, session, seed):
    await seed(2)
    async with sessions() as w:
        await claim_batch(w, 8)
    await age(session, "claimed_at", 30)
    stats = await run_janitor(sessions, SETTINGS)
    assert (stats.requeued, stats.failed, stats.purged) == (2, 0, 0)
    assert (await run_janitor(sessions, SETTINGS)).requeued == 0


async def test_the_scheduler_runs_the_janitor_every_minute(sessions):
    scheduler = build_scheduler(sessions, SETTINGS)
    job = scheduler.get_job("outbox-janitor")
    assert job is not None and job.trigger.interval.total_seconds() == 60
    assert job.max_instances == 1
