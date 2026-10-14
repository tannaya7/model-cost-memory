"""Sync worker: drains the outbox, embeds each run's prompt and stores the vector.

The outbox table is the queue. Rows are claimed with `SELECT ... FOR UPDATE SKIP LOCKED`, so any
number of workers can run at once without taking the same row. Every write is keyed by `run_id`,
so a retry, a crash halfway or two workers racing never produce a duplicate or a half-written run.

A row that fails is retried with exponential backoff and jitter (1 s, 2 s, 4 s ... capped), and after
`outbox_max_retries` attempts it becomes FAILED and its run INGESTION_FAILED; the run itself is kept.
A worker that crashes leaves its rows PROCESSING; the janitor (pipeline/janitor.py) hands them back.

Run it with:  python -m agent_memory.pipeline.sync_worker
"""

from __future__ import annotations

import asyncio
import logging
import signal
import uuid
from dataclasses import dataclass

from sqlalchemy import func, select, text, update
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from ..config import Settings, get_settings, load_dotenv_file
from ..embeddings import Embedder, get_embedder
from ..models import OutboxRow, Run
from ..storage.vector_store import PgVectorClient

log = logging.getLogger("agent_memory.sync_worker")

HANDLED_OPS = ("UPSERT", "INVALIDATE")
BACKOFF_BASE_SECONDS = 1.0
BACKOFF_CAP_SECONDS = 300.0

CLAIM_SQL = text(
    """
    UPDATE outbox SET status = 'PROCESSING', claimed_at = now(), updated_at = now()
    WHERE outbox_id IN (
        SELECT outbox_id FROM outbox
        WHERE status = 'PENDING'
          AND op = ANY(:ops)
          AND (retry_count = 0
               OR updated_at + LEAST(POWER(2, retry_count) * :base, :cap) * (1 + random() * 0.2)
                              * interval '1 second' <= now())
        ORDER BY created_at
        LIMIT :limit
        FOR UPDATE SKIP LOCKED
    )
    RETURNING outbox_id, run_id, op, retry_count
    """
)


@dataclass
class Stats:
    claimed: int = 0
    done: int = 0
    retried: int = 0
    failed: int = 0

    def __iadd__(self, other: Stats) -> Stats:
        self.claimed += other.claimed
        self.done += other.done
        self.retried += other.retried
        self.failed += other.failed
        return self


async def claim_batch(session: AsyncSession, limit: int) -> list[tuple[uuid.UUID, uuid.UUID | None, str, int]]:
    """Take up to `limit` ready rows (marked PROCESSING) and commit, so other workers see the claim."""
    rows = (
        await session.execute(
            CLAIM_SQL, {"ops": list(HANDLED_OPS), "base": BACKOFF_BASE_SECONDS, "cap": BACKOFF_CAP_SECONDS, "limit": limit}
        )
    ).all()
    await session.commit()
    return [(r.outbox_id, r.run_id, r.op, r.retry_count) for r in rows]


async def _fail_row(session: AsyncSession, outbox_id: uuid.UUID, run_id: uuid.UUID | None, error: str, max_retries: int) -> bool:
    """Record a failure. Returns True when the row is now FAILED (out of retries)."""
    row = (
        await session.execute(
            text(
                """
                UPDATE outbox SET retry_count = retry_count + 1, last_error = :error, claimed_at = NULL,
                       updated_at = now(),
                       status = CASE WHEN retry_count + 1 >= :max THEN 'FAILED' ELSE 'PENDING' END
                WHERE outbox_id = :id RETURNING status
                """
            ),
            {"error": error[:500], "max": max_retries, "id": outbox_id},
        )
    ).scalar_one()
    if row == "FAILED" and run_id is not None:
        await session.execute(update(Run).where(Run.run_id == run_id).values(state="INGESTION_FAILED"))
    await session.commit()
    return row == "FAILED"


async def run_once(
    sessions: async_sessionmaker[AsyncSession], embedder: Embedder, settings: Settings | None = None
) -> Stats:
    """Claim one batch and process it. Safe to call from many workers at the same time."""
    settings = settings or get_settings()
    stats = Stats()
    async with sessions() as session:
        claimed = await claim_batch(session, settings.outbox_batch_size)
        stats.claimed = len(claimed)
        if not claimed:
            return stats

        run_ids = [rid for _, rid, _, _ in claimed if rid is not None]
        prompts = {
            r.run_id: r.prompt
            for r in (await session.execute(select(Run.run_id, Run.prompt).where(Run.run_id.in_(run_ids)))).all()
        }
        upserts = [(oid, rid) for oid, rid, op, _ in claimed if op == "UPSERT" and rid in prompts]
        vectors: dict[uuid.UUID, list[float]] = {}
        batch_error: str | None = None
        if upserts:
            try:
                embedded = await asyncio.to_thread(embedder.embed, [prompts[rid] for _, rid in upserts])
                vectors = {rid: vec for (_, rid), vec in zip(upserts, embedded, strict=True)}
            except Exception as exc:  # the whole batch is retried; nothing was written
                log.warning("embedding failed for a batch of %d: %s", len(upserts), exc)
                batch_error = f"embedding failed: {exc}"

        store = PgVectorClient(session)
        for outbox_id, run_id, op, _ in claimed:
            try:
                if run_id is None or (op == "UPSERT" and run_id not in prompts):
                    raise LookupError("the run no longer exists")
                if op == "UPSERT":
                    if batch_error:
                        raise RuntimeError(batch_error)
                    await store.upsert(run_id, vectors[run_id])
                    await session.execute(
                        update(Run).where(Run.run_id == run_id, Run.state.in_(("CAPTURED", "CHECKED"))).values(state="INDEXED")
                    )
                else:  # INVALIDATE: the run should no longer be searchable
                    await store.delete(run_id)
                await session.execute(
                    update(OutboxRow).where(OutboxRow.outbox_id == outbox_id).values(status="DONE", last_error=None, updated_at=func.now())
                )
                await session.commit()
                stats.done += 1
            except Exception as exc:
                await session.rollback()
                if await _fail_row(session, outbox_id, run_id, str(exc), settings.outbox_max_retries):
                    stats.failed += 1
                else:
                    stats.retried += 1
    return stats


async def run_forever(
    sessions: async_sessionmaker[AsyncSession],
    embedder: Embedder,
    settings: Settings | None = None,
    *,
    poll_interval: float = 1.0,
    stop: asyncio.Event | None = None,
) -> Stats:
    """Process batches until `stop` is set, sleeping only when the queue is empty."""
    settings = settings or get_settings()
    stop = stop or asyncio.Event()
    total = Stats()
    while not stop.is_set():
        try:
            batch = await run_once(sessions, embedder, settings)
        except Exception:  # a database blip must not kill the worker
            log.exception("sync worker iteration failed; will retry")
            batch = Stats()
        total += batch
        if batch.claimed == 0:
            try:
                await asyncio.wait_for(stop.wait(), timeout=poll_interval)
            except TimeoutError:
                pass
    return total


async def _main() -> None:
    from ..db import dispose_engine, session_factory

    load_dotenv_file()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
    stop = asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            loop.add_signal_handler(sig, stop.set)
        except NotImplementedError:  # Windows: Ctrl+C raises KeyboardInterrupt instead
            pass
    embedder = get_embedder()
    log.info("sync worker started (embedder: %s)", embedder.name)
    try:
        total = await run_forever(session_factory(), embedder, stop=stop)
    finally:
        await dispose_engine()
    log.info("sync worker stopped: %s", total)


if __name__ == "__main__":
    try:
        asyncio.run(_main())
    except KeyboardInterrupt:
        pass
