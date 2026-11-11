"""The sync worker against a real Postgres: claiming, embedding, retries, failure and idempotency."""

import asyncio
import uuid

import pytest
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import async_sessionmaker

from agent_memory.config import Settings
from agent_memory.embeddings import CachedEmbedder, HashingEmbedder
from agent_memory.models import Job, OutboxRow, Project, Run
from agent_memory.pipeline.sync_worker import claim_batch, run_forever, run_once
from agent_memory.storage.vector_store import PgVectorClient

SETTINGS = Settings(outbox_batch_size=8, outbox_max_retries=3)


@pytest.fixture
def sessions(engine):
    return async_sessionmaker(engine, expire_on_commit=False)


@pytest.fixture
async def seed(session):
    """Insert runs (each with a PENDING UPSERT outbox row) and return their ids."""
    session.add(Project(project_id="demo", api_key_hash="x"))
    await session.flush()
    job = Job(project_id="demo", name="j", check_kind="LATE_LABEL", check_config={})
    session.add(job)
    await session.flush()

    async def make(n, op="UPSERT"):
        ids = []
        for i in range(n):
            run_id = uuid.uuid4()
            session.add(Run(run_id=run_id, job_id=job.job_id, project_id="demo", prompt=f"prompt number {i} {run_id}",
                            prompt_hash=str(run_id), model="m", model_version="v", state="CHECKED", outcome="PASS"))
            ids.append(run_id)
        await session.flush()
        for run_id in ids:
            session.add(OutboxRow(run_id=run_id, op=op, payload={"run_id": str(run_id)}))
        await session.commit()
        return ids

    return make


class Failing:
    name, dim = "failing", 384

    def __init__(self, times):
        self.times = times
        self.calls = 0

    def embed(self, texts):
        self.calls += 1
        if self.calls <= self.times:
            raise RuntimeError("model unavailable")
        return HashingEmbedder().embed(texts)


class Counting:
    name, dim = "counting", 384

    def __init__(self):
        self.embedded = 0

    def embed(self, texts):
        self.embedded += len(texts)
        return HashingEmbedder().embed(texts)


async def states(session):
    runs = (await session.execute(select(Run.run_id, Run.state, Run.embedding))).all()
    rows = (await session.execute(select(OutboxRow.run_id, OutboxRow.status, OutboxRow.retry_count, OutboxRow.last_error))).all()
    return runs, rows


async def test_a_recorded_run_becomes_searchable_and_indexed(sessions, session, seed):
    ids = await seed(3)
    stats = await run_once(sessions, HashingEmbedder(), SETTINGS)
    assert (stats.claimed, stats.done, stats.failed) == (3, 3, 0)
    session.expunge_all()
    runs, rows = await states(session)
    assert {s for _, s, _ in runs} == {"INDEXED"} and all(e is not None for _, _, e in runs)
    assert {s for _, s, _, _ in rows} == {"DONE"}
    prompt = (await session.get(Run, ids[0])).prompt
    hits = await PgVectorClient(session).search(HashingEmbedder().embed([prompt])[0], project_id="demo", top_k=1)
    assert hits[0].run_id == ids[0]


async def test_an_empty_queue_is_a_quiet_no_op(sessions):
    stats = await run_once(sessions, HashingEmbedder(), SETTINGS)
    assert stats.claimed == 0


async def test_two_workers_never_take_the_same_row(sessions, session, seed):
    await seed(24)
    embedder = Counting()
    batches = await asyncio.gather(*[run_once(sessions, embedder, SETTINGS) for _ in range(4)])
    for _ in range(3):  # drain whatever the first round left
        await run_once(sessions, embedder, SETTINGS)
    assert sum(b.claimed for b in batches) <= 24 and embedder.embedded == 24  # each prompt embedded exactly once
    _, rows = await states(session)
    assert len(rows) == 24 and {s for _, s, _, _ in rows} == {"DONE"}


async def test_claiming_marks_rows_processing_and_other_workers_skip_them(sessions, seed):
    await seed(4)
    async with sessions() as a, sessions() as b:
        first = await claim_batch(a, 3)
        second = await claim_batch(b, 3)
    assert len(first) == 3 and len(second) == 1  # the three claimed rows are invisible to the second worker


async def test_a_failure_is_retried_with_backoff_then_succeeds(sessions, session, seed):
    await seed(2)
    embedder = Failing(times=1)
    stats = await run_once(sessions, embedder, SETTINGS)
    assert (stats.retried, stats.done) == (2, 0)
    _, rows = await states(session)
    assert {(s, n) for _, s, n, _ in rows} == {("PENDING", 1)} and "model unavailable" in rows[0][3]

    assert (await run_once(sessions, embedder, SETTINGS)).claimed == 0  # backing off: not ready yet
    await session.execute(text("UPDATE outbox SET updated_at = now() - interval '1 hour'"))
    await session.commit()
    stats = await run_once(sessions, embedder, SETTINGS)
    assert (stats.done, stats.failed) == (2, 0)
    _, rows = await states(session)
    assert {s for _, s, _, _ in rows} == {"DONE"}


async def test_after_max_retries_the_row_fails_and_the_run_is_marked_but_kept(sessions, session, seed):
    (run_id,) = await seed(1)
    embedder = Failing(times=99)
    for attempt in range(3):
        await session.execute(text("UPDATE outbox SET updated_at = now() - interval '1 hour'"))
        await session.commit()
        stats = await run_once(sessions, embedder, SETTINGS)
        assert stats.claimed == 1, attempt
    assert (stats.failed, stats.retried) == (1, 0)
    session.expunge_all()
    row = (await session.execute(select(OutboxRow))).scalar_one()
    assert row.status == "FAILED" and row.retry_count == 3
    assert (await session.get(Run, run_id)).state == "INGESTION_FAILED"  # the run still exists
    await session.execute(text("UPDATE outbox SET updated_at = now() - interval '1 hour'"))
    await session.commit()
    assert (await run_once(sessions, embedder, SETTINGS)).claimed == 0  # FAILED rows are never picked up again


async def test_processing_the_same_run_twice_is_harmless(sessions, session, seed):
    (run_id,) = await seed(1)
    session.add(OutboxRow(run_id=run_id, op="UPSERT", payload={}))  # a second receipt for the same run
    await session.commit()
    await run_once(sessions, HashingEmbedder(), SETTINGS)
    session.expunge_all()
    runs, rows = await states(session)
    assert len(runs) == 1 and runs[0][1] == "INDEXED" and {s for _, s, _, _ in rows} == {"DONE"}


async def test_invalidate_removes_the_vector_and_unknown_ops_are_left_alone(sessions, session, seed):
    (run_id,) = await seed(1)
    await run_once(sessions, HashingEmbedder(), SETTINGS)
    session.add(OutboxRow(run_id=run_id, op="INVALIDATE", payload={}))
    session.add(OutboxRow(run_id=run_id, op="RETEST", payload={}))
    await session.commit()
    stats = await run_once(sessions, HashingEmbedder(), SETTINGS)
    assert stats.claimed == 1  # only the INVALIDATE row
    session.expunge_all()
    assert (await session.get(Run, run_id)).embedding is None
    pending = (await session.execute(select(OutboxRow.op).where(OutboxRow.status == "PENDING"))).scalars().all()
    assert pending == ["RETEST"]


async def test_a_row_whose_run_is_gone_fails_cleanly(sessions, session, seed):
    await seed(1)
    session.add(OutboxRow(run_id=None, op="UPSERT", payload={}))
    await session.commit()
    stats = await run_once(sessions, HashingEmbedder(), SETTINGS)
    assert stats.done == 1 and stats.retried == 1  # the real run indexes; the orphan row is retried, not lost


async def test_the_cached_embedder_saves_work_for_repeated_prompts(sessions, session, seed):
    await seed(1)
    inner = Counting()
    embedder = CachedEmbedder(inner)
    session.add(Run(run_id=uuid.uuid4(), job_id=(await session.execute(select(Job.job_id))).scalar_one(), project_id="demo",
                    prompt="the very same prompt", prompt_hash="a", model="m", model_version="v"))
    session.add(Run(run_id=uuid.uuid4(), job_id=(await session.execute(select(Job.job_id))).scalar_one(), project_id="demo",
                    prompt="the very same prompt", prompt_hash="a", model="m", model_version="v"))
    await session.flush()
    for run in (await session.execute(select(Run.run_id).where(Run.prompt == "the very same prompt"))).scalars().all():
        session.add(OutboxRow(run_id=run, op="UPSERT", payload={}))
    await session.commit()
    await run_once(sessions, embedder, SETTINGS)
    assert inner.embedded == 2  # one distinct prompt from seed(1) plus the repeated prompt once


async def test_run_forever_drains_the_queue_and_stops_on_request(sessions, session, seed):
    await seed(10)
    stop = asyncio.Event()
    task = asyncio.create_task(run_forever(sessions, HashingEmbedder(), SETTINGS, poll_interval=0.05, stop=stop))
    for _ in range(100):
        await asyncio.sleep(0.05)
        count = (await session.execute(text("SELECT count(*) FROM outbox WHERE status = 'DONE'"))).scalar_one()
        if count == 10:
            break
    stop.set()
    total = await asyncio.wait_for(task, timeout=5)
    assert total.done == 10 and count == 10
