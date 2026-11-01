"""OutboxJanitor: keeps the outbox queue healthy.

- A worker that crashes after claiming rows leaves them PROCESSING forever. Rows claimed more than
  `outbox_stuck_minutes` ago are handed back (PENDING). Each hand-back counts as a retry, so a "poison"
  row that keeps killing workers ends up FAILED instead of looping for ever.
- Finished (DONE) rows are deleted after a retention window, so the table does not grow without bound.
  The outbox is a queue, not evidence: runs and recommendations are never deleted.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass

from sqlalchemy import text, update
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from ..config import Settings, get_settings
from ..models import Run
from . import flow

log = logging.getLogger("agent_memory.janitor")


@dataclass
class JanitorStats:
    requeued: int = 0
    failed: int = 0
    purged: int = 0


async def requeue_stuck(session: AsyncSession, *, minutes: int, max_retries: int) -> tuple[int, int]:
    """Hand back rows a dead worker left PROCESSING. Returns (requeued, failed)."""
    rows = (
        await session.execute(
            text(
                """
                UPDATE outbox SET retry_count = retry_count + 1, claimed_at = NULL, updated_at = now(),
                       last_error = 'a worker stopped before finishing this row',
                       status = CASE WHEN retry_count + 1 >= :max THEN 'FAILED' ELSE 'PENDING' END
                WHERE status = 'PROCESSING' AND claimed_at < now() - make_interval(mins => :minutes)
                RETURNING run_id, status
                """
            ),
            {"max": max_retries, "minutes": minutes},
        )
    ).all()
    failed_runs = [r.run_id for r in rows if r.status == "FAILED" and r.run_id is not None]
    if failed_runs:
        await session.execute(update(Run).where(Run.run_id.in_(failed_runs)).values(state="INGESTION_FAILED"))
    await session.commit()
    failed = sum(1 for r in rows if r.status == "FAILED")
    return len(rows) - failed, failed


async def purge_done(session: AsyncSession, *, days: int) -> int:
    """Delete DONE rows older than `days`. Returns how many were removed."""
    result = await session.execute(
        text("DELETE FROM outbox WHERE status = 'DONE' AND updated_at < now() - make_interval(days => :days)"),
        {"days": days},
    )
    await session.commit()
    return result.rowcount


async def run_janitor(sessions: async_sessionmaker[AsyncSession], settings: Settings | None = None) -> JanitorStats:
    settings = settings or get_settings()
    async with sessions() as session:
        requeued, failed = await requeue_stuck(
            session, minutes=settings.outbox_stuck_minutes, max_retries=settings.outbox_max_retries
        )
        purged = await purge_done(session, days=settings.outbox_done_retention_days)
        await flow.purge(session)  # the live view's trail; a day is plenty
    if requeued or failed or purged:
        log.info("outbox janitor: %d requeued, %d failed, %d purged", requeued, failed, purged)
    async with sessions() as session:
        health = await outbox_health(session, stuck_minutes=settings.outbox_stuck_minutes)
    if not health.healthy:
        log.warning("outbox is not healthy", extra={
            "pending": health.pending, "failed": health.failed, "stuck": health.stuck,
            "oldest_pending_seconds": health.oldest_pending_seconds, "max_retry_count": health.max_retry_count})
    return JanitorStats(requeued=requeued, failed=failed, purged=purged)


@dataclass
class OutboxHealth:
    pending: int
    processing: int
    done: int
    failed: int
    stuck: int  # PROCESSING for longer than the stuck timeout: a worker probably died
    oldest_pending_seconds: float | None  # how long the waiting queue head has been waiting
    max_retry_count: int  # the most-retried row that is still alive

    @property
    def healthy(self) -> bool:
        """No failed or stuck rows, and nothing waiting for more than five minutes."""
        return self.failed == 0 and self.stuck == 0 and (self.oldest_pending_seconds or 0.0) < 300


async def outbox_health(session: AsyncSession, *, stuck_minutes: int = 10) -> OutboxHealth:
    """Answer "is the sync worker healthy?" with one query over the outbox's status columns."""
    row = (
        await session.execute(
            text(
                """
                SELECT count(*) FILTER (WHERE status = 'PENDING')    AS pending,
                       count(*) FILTER (WHERE status = 'PROCESSING') AS processing,
                       count(*) FILTER (WHERE status = 'DONE')       AS done,
                       count(*) FILTER (WHERE status = 'FAILED')     AS failed,
                       count(*) FILTER (WHERE status = 'PROCESSING'
                                          AND claimed_at < now() - make_interval(mins => :minutes)) AS stuck,
                       EXTRACT(EPOCH FROM now() - min(created_at) FILTER (WHERE status = 'PENDING')) AS oldest,
                       COALESCE(max(retry_count) FILTER (WHERE status IN ('PENDING', 'PROCESSING')), 0) AS max_retry
                FROM outbox
                """
            ),
            {"minutes": stuck_minutes},
        )
    ).one()
    return OutboxHealth(
        pending=row.pending, processing=row.processing, done=row.done, failed=row.failed, stuck=row.stuck,
        oldest_pending_seconds=float(row.oldest) if row.oldest is not None else None, max_retry_count=row.max_retry,
    )
