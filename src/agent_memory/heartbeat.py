"""Is the scheduler doing its work? Heartbeats, an overdue check, and a message to the operator.

Every scheduled job is wrapped by `tracked`: when it finishes it records `last_ok_at`, and when it fails
it records the error (`scheduler_heartbeats`). The scheduler also records when it took the lead, so a
job that has not had its first turn yet is judged from then, not from the epoch.

`GET /healthz/scheduler` (api.py) answers 503 when any job is overdue: no success within ALLOWANCE times
its interval, and never less than MIN_GRACE. Point a free uptime monitor at it and at `/healthz`, and a
stopped scheduler, a failing price sync or a stuck alert sender is noticed within minutes instead of
when a customer sees stale advice.

With OPERATOR_WEBHOOK_URL set (a Slack, Discord or other incoming webhook), a failing job also posts a
one-line message there, at most once an hour per job, so repeated failures do not flood the channel.
The error text goes to the operator only; the public endpoint shows job names and ages, never errors.
"""

from __future__ import annotations

import functools
import logging
import time
from datetime import UTC, datetime, timedelta

import httpx
from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from .config import Settings, get_settings
from .models import SchedulerHeartbeat

log = logging.getLogger("agent_memory.heartbeat")

# How often each job runs (scheduler.build_scheduler); a job is overdue after ALLOWANCE intervals.
INTERVALS = {
    "outbox-janitor": timedelta(minutes=1),
    "decay": timedelta(hours=1),
    "consolidation": timedelta(minutes=15),
    "regression": timedelta(minutes=15),
    "alert-delivery": timedelta(minutes=1),
    "retests": timedelta(seconds=30),
    "retest-unsure": timedelta(hours=1),
    "catalog-sync": timedelta(days=1),
    "retention": timedelta(days=1),
    "news": timedelta(hours=1),
}
LEADER = "scheduler"  # the row recording when this scheduler took the lead
ALLOWANCE = 3
MIN_GRACE = timedelta(minutes=10)
NOTIFY_EVERY_SECONDS = 3600
MAX_ERROR_CHARS = 500

_last_notified: dict[str, float] = {}


def allowance(job: str) -> timedelta:
    return max(INTERVALS[job] * ALLOWANCE, MIN_GRACE)


async def record(sessions: async_sessionmaker[AsyncSession], job: str, *, error: str | None = None,
                 now: datetime | None = None) -> None:
    """Record a success (error None) or a failure. Never raises: a heartbeat must not break the job."""
    now = now or datetime.now(UTC)
    values = ({"last_ok_at": now} if error is None
              else {"last_error": error[:MAX_ERROR_CHARS], "last_error_at": now})
    try:
        async with sessions() as session:
            await session.execute(insert(SchedulerHeartbeat).values(job=job, **values)
                                  .on_conflict_do_update(index_elements=["job"], set_=values))
            await session.commit()
    except Exception:
        log.exception("could not record the heartbeat", extra={"job": job})


async def notify_operator(settings: Settings, job: str, error: str, *, transport=None) -> bool:
    """Post a one-line message to OPERATOR_WEBHOOK_URL, at most once an hour per job."""
    url = settings.operator_webhook_url
    if not url:
        return False
    now = time.monotonic()
    if now - _last_notified.get(job, -NOTIFY_EVERY_SECONDS) < NOTIFY_EVERY_SECONDS:
        return False
    _last_notified[job] = now
    message = f"Model & Cost Memory: the scheduled job '{job}' failed: {error[:300]}"
    try:
        async with httpx.AsyncClient(timeout=10, transport=transport) as client:
            response = await client.post(url, json={"text": message, "content": message})
            response.raise_for_status()
        return True
    except httpx.HTTPError as exc:
        log.warning("operator webhook failed: %s", type(exc).__name__)
        return False


def tracked(job: str, fn):
    """Wrap a scheduled job (whose first argument is the session factory) so it leaves a heartbeat."""
    if job not in INTERVALS:
        raise ValueError(f"add {job!r} to heartbeat.INTERVALS")

    @functools.wraps(fn)
    async def run(sessions, settings: Settings | None = None, *args, **kwargs):
        try:
            result = await fn(sessions, settings, *args, **kwargs)
        except Exception as exc:
            error = f"{type(exc).__name__}: {exc}"
            log.exception("scheduled job failed", extra={"job": job})
        else:
            if result is not False:
                await record(sessions, job)
                return result
            # A job that handles its own failure says so by returning False (the catalog sync does when
            # the price list cannot be fetched); it is not a success, so it is not a heartbeat.
            error = "did not complete; see the scheduler log"
        await record(sessions, job, error=error)
        await notify_operator(settings or get_settings(), job, error)
        return None  # logged and recorded; raising again would only make APScheduler log it twice

    return run


async def overdue(session: AsyncSession, *, now: datetime | None = None) -> dict[str, float | None]:
    """Jobs with no success inside their allowance: job -> minutes since the last success (None if never).
    Judged from when the scheduler took the lead, so a fresh start is not overdue. No scheduler ever
    started counts as every job overdue."""
    now = now or datetime.now(UTC)
    rows = {r.job: r for r in (await session.execute(select(SchedulerHeartbeat))).scalars()}
    leader = rows.get(LEADER)
    started = leader.last_ok_at if leader else None
    late: dict[str, float | None] = {}
    for job in INTERVALS:
        row = rows.get(job)
        last_ok = row.last_ok_at if row else None
        since = max(t for t in (last_ok, started) if t is not None) if (last_ok or started) else None
        if since is None or now - since > allowance(job):
            late[job] = round((now - last_ok).total_seconds() / 60, 1) if last_ok else None
    return late
