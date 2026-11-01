"""Consolidator: turns many runs into one stored recommendation per job (semantic memory).

On each pass it asks the engine for the job's verdict as of `now`. When the verdict or the
recommended model changed, it writes a new recommendation with every run behind it in
`consolidated_from`, and supersedes the previous one: the old row gets `invalid_at`,
`superseded_by_id` and a reason, and is never overwritten or deleted. The runs it rests on move
from INDEXED to CONSOLIDATED. An unchanged verdict writes nothing, so the history only records
changes.

Why it changed:
    MODEL_UPGRADE      the same model family, a newer version
    MODEL_RETIRED      the recommended model was retired by its provider
    EVIDENCE_DECAYED   the evidence faded below the floor (the verdict became INSUFFICIENT_EVIDENCE)
    REGRESSION         a version change made results worse (set by the regression sweep)
    NEW_EVIDENCE       anything else: new runs, labels or re-tests changed the answer
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import UTC, datetime

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from ..config import Settings, get_settings
from . import flow
from ..models import Job, Recommendation, Run
from ..recommend.engine import JobRecommendation, recommend
from ..versions import same_family

log = logging.getLogger("agent_memory.consolidation")


@dataclass
class ConsolidationStats:
    jobs: int = 0
    written: int = 0
    superseded: int = 0


def _reason(old: Recommendation, new_verdict: str, new_model: str, new_version: str, retired: bool) -> str:
    if new_verdict == "INSUFFICIENT_EVIDENCE" and old.verdict != "INSUFFICIENT_EVIDENCE":
        return "EVIDENCE_DECAYED"
    if retired:
        return "MODEL_RETIRED"
    if old.model and same_family(old.model, new_model) and old.model_version != new_version:
        return "MODEL_UPGRADE"
    return "NEW_EVIDENCE"


async def current_recommendation(session: AsyncSession, job_id) -> Recommendation | None:
    return (
        await session.execute(
            select(Recommendation).where(Recommendation.job_id == job_id, Recommendation.invalid_at.is_(None))
            .with_for_update()
        )
    ).scalar_one_or_none()


async def store(
    session: AsyncSession, job: Job, result: JobRecommendation, *, now: datetime, reason: str | None = None,
    force: bool = False,
) -> Recommendation | None:
    """Write the verdict if it changed (or `force`, e.g. after a regression), superseding the previous one.
    Returns the new row, or None."""
    d = result.decision
    chosen = d.recommended or d.current
    model, version = (chosen.model, chosen.model_version) if chosen else ("", "")
    old = await current_recommendation(session, job.job_id)
    unchanged = old is not None and (old.verdict, old.model, old.model_version) == (d.verdict, model, version)
    if unchanged and not force:
        return None

    new = Recommendation(
        job_id=job.job_id, model=model, model_version=version, verdict=d.verdict,
        weighted_pass_rate=chosen.sample.pass_rate if chosen and chosen.sample else None,
        mean_cost_usd=chosen.mean_cost_usd if chosen else None,
        n_runs=len(result.run_ids), evidence_weight=result.evidence_weight,
        consolidated_from=list(result.run_ids), current_model=d.current.model if d.current else None,
        valid_at=now,
    )
    session.add(new)
    await session.flush()
    if old is not None:
        old_retired = next((m.status == "RETIRED" for m in d.models if m.model == old.model), False)
        old.invalid_at = now
        old.superseded_by_id = new.recommendation_id
        old.supersession_reason = reason or _reason(old, d.verdict, model, version, old_retired)
    if result.run_ids:
        await session.execute(
            update(Run).where(Run.run_id.in_(result.run_ids), Run.state == "INDEXED").values(state="CONSOLIDATED")
        )
    flow.emit(session, job.project_id, "consolidate",
              f"[{job.name}] Recommendation is now {d.verdict}" + (f": {model}" if model else ""),
              data={"job": job.name, "verdict": d.verdict, "model": model, "n_runs": len(result.run_ids)})
    log.info(
        "recommendation stored",
        extra={"job_id": str(job.job_id), "project_id": job.project_id, "verdict": d.verdict, "model": model,
               "n_runs": len(result.run_ids), "evidence_weight": round(result.evidence_weight, 2),
               "supersedes": str(old.recommendation_id) if old else None,
               "reason": old.supersession_reason if old else None},
    )
    return new


async def consolidate_job(
    session: AsyncSession, job: Job, *, now: datetime | None = None, settings: Settings | None = None,
    reason: str | None = None, force: bool = False,
) -> Recommendation | None:
    now = now or datetime.now(UTC)
    result = await recommend(session, job, now=now, settings=settings or get_settings())
    new = await store(session, job, result, now=now, reason=reason, force=force)
    await session.commit()
    return new


async def consolidate_all(
    session: AsyncSession, *, now: datetime | None = None, settings: Settings | None = None
) -> ConsolidationStats:
    """One pass over every job. `now` can be any moment, for the simulated-time harness."""
    now = now or datetime.now(UTC)
    stats = ConsolidationStats()
    for job in (await session.execute(select(Job).order_by(Job.project_id, Job.name))).scalars().all():
        stats.jobs += 1
        had = await current_recommendation(session, job.job_id)
        new = await consolidate_job(session, job, now=now, settings=settings)
        if new is not None:
            stats.written += 1
            stats.superseded += had is not None
    return stats
