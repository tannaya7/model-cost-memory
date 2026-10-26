"""Recommendation cache (technical plan 3.9): holds the <500 ms target under repeat polling.

Entries live for 5 minutes and are keyed by the job and a fingerprint of its runs (how many, how
many checked, archived or invalidated, and the newest), so a new run or a late label is reflected on
the next request instead of after the TTL. The fingerprint is one indexed aggregate query; the
engine's full read happens only on a miss. Catalog changes and decay are covered by the TTL.
"""

from __future__ import annotations

from datetime import datetime

from cachetools import TTLCache
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from ..config import Settings, get_settings
from ..models import Job, Recommendation, Run
from .engine import JobRecommendation, recommend

TTL_SECONDS = 300
_cache: TTLCache = TTLCache(maxsize=2048, ttl=TTL_SECONDS)


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
    if hit is None:
        hit = _cache[key] = await recommend(session, job, settings=settings)
    return hit


def clear() -> None:
    _cache.clear()
