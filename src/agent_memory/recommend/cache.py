"""Recommendation cache (technical plan 3.9): holds the <500 ms target under repeat polling.

Entries live for 5 minutes and are keyed by the job and a fingerprint of its runs (how many, how
many checked, archived or invalidated, and the newest), so a new run or a late label is reflected on
the next request instead of after the TTL. The fingerprint is one indexed aggregate query; the
engine's full read happens only on a miss. Catalog changes and decay are covered by the TTL.

A miss on a large job is slow: the engine reads every counted run once, about 1.4 s for half a million
on a laptop (reports/speed.md). So for a job whose last verdict took longer than SLOW_SECONDS to
compute, a miss returns that verdict at once, if it is at most STALE_SECONDS old, and computes the new
one in the background for the next request. A verdict can then trail the newest runs by up to a minute,
which its `computed_at` shows; decisions it informs play out over days. Small jobs always get a fresh one.
"""

from __future__ import annotations

import asyncio
import logging
import time
from dataclasses import dataclass
from datetime import datetime

from cachetools import TTLCache
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from ..config import Settings, get_settings
from ..models import Job, Recommendation, Run
from .engine import JobRecommendation, recommend

log = logging.getLogger("agent_memory.recommend")

TTL_SECONDS = 300
STALE_SECONDS = 60  # the oldest verdict a slow job is answered with while a newer one is computed
SLOW_SECONDS = 0.25  # how long computing a verdict must take before that is worth it

_cache: TTLCache = TTLCache(maxsize=2048, ttl=TTL_SECONDS)


@dataclass
class _Latest:
    result: JobRecommendation
    computed: float  # time.monotonic() when it was computed
    took: float  # seconds it took


_latest: TTLCache = TTLCache(maxsize=2048, ttl=TTL_SECONDS)  # (job, rules) -> newest verdict
_refreshing: set[tuple] = set()
_tasks: set[asyncio.Task] = set()  # strong references, so a running refresh is not garbage-collected


async def fingerprint(session: AsyncSession, job: Job) -> tuple:
    runs = (
        await session.execute(
            select(
                func.count(), func.count().filter(Run.outcome != "UNKNOWN"), func.count().filter(Run.outcome == "PASS"),
                func.count().filter(Run.state == "ARCHIVED"), func.count().filter(Run.invalid_at.is_not(None)),
                func.max(Run.created_at),
            ).where(Run.job_id == job.job_id)
        )
    ).one()
    stored = (
        await session.execute(select(func.count()).where(Recommendation.job_id == job.job_id))
    ).scalar_one()
    return (*runs, stored)


async def _compute(session: AsyncSession, job: Job, settings: Settings, key: tuple, latest_key: tuple):
    started = time.monotonic()
    result = await recommend(session, job, settings=settings)
    _cache[key] = result
    _latest[latest_key] = _Latest(result, time.monotonic(), time.monotonic() - started)
    return result


async def _refresh(bind, job_id, settings: Settings, key: tuple, latest_key: tuple) -> None:
    """Compute a verdict in the background, with a session of its own (the request's is closed by then)."""
    try:
        async with async_sessionmaker(bind, expire_on_commit=False)() as session:
            job = await session.get(Job, job_id)
            if job is not None:
                await _compute(session, job, settings, key, latest_key)
    except Exception:
        log.exception("background refresh of a recommendation failed", extra={"job_id": str(job_id)})
    finally:
        _refreshing.discard(latest_key)


async def cached_recommend(
    session: AsyncSession, job: Job, *, settings: Settings | None = None, now: datetime | None = None
) -> JobRecommendation:
    settings = settings or get_settings()
    if now is not None:  # an explicit moment (simulation, tests) is never cached
        return await recommend(session, job, now=now, settings=settings)
    rules = (settings.evidence_floor, settings.tolerance_points, settings.confidence_level, settings.decay_base_days,
             settings.version_factor_superseded)
    key = (job.job_id, await fingerprint(session, job), rules)
    hit = _cache.get(key)
    if hit is not None:
        return hit
    latest_key = (job.job_id, rules)
    last = _latest.get(latest_key)
    if last is not None and last.took >= SLOW_SECONDS and time.monotonic() - last.computed <= STALE_SECONDS:
        if latest_key not in _refreshing:
            _refreshing.add(latest_key)
            task = asyncio.create_task(_refresh(session.bind, job.job_id, settings, key, latest_key))
            _tasks.add(task)
            task.add_done_callback(_tasks.discard)
        return last.result
    return await _compute(session, job, settings, key, latest_key)


async def settle() -> None:
    """Wait for background refreshes to finish (tests, and a clean shutdown)."""
    while _tasks:
        await asyncio.gather(*list(_tasks), return_exceptions=True)


def clear() -> None:
    _cache.clear()
    _latest.clear()
