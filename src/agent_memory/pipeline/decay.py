"""DecayMaintenanceJob: keeps every run's importance and stability current and archives faded runs.

For each run it works out (a) its importance from the measured outcome and cost against the job's
average, (b) whether its model version has been superseded, and (c) the resulting stability S. A run
whose freshness R(t) has fallen below the archive threshold is marked ARCHIVED. Nothing is deleted:
archived runs stay queryable, they just stop counting towards recommendations.

Which version is "current" is decided from what production actually uses: within one job and one
model family (see versions.py) the version of the most recent PRODUCTION run is current and every
other version is superseded. Re-test runs never decide this, since a candidate model being tried out
has not replaced anything. A rollback to an older version makes that version current again.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import UTC, datetime

from sqlalchemy import bindparam, func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from ..config import Settings, get_settings
from ..models import Job, Run
from ..versions import family, normalize
from .scoring import age_days, freshness, importance, is_archived, stability_days

log = logging.getLogger("agent_memory.decay")

ARCHIVABLE_STATES = ("CAPTURED", "CHECKED", "INDEXED", "CONSOLIDATED")
CHUNK = 1000


@dataclass
class DecayStats:
    scored: int = 0
    superseded: int = 0
    archived: int = 0


def family_key(model: str, model_version: str) -> str:
    return family(model_version or model)


async def current_versions(session: AsyncSession, job_id=None) -> dict[tuple, str]:
    """For every (job, model family), or only one job's: the version production is using now."""
    query = select(Run.job_id, Run.model, Run.model_version, Run.run_kind, func.max(Run.created_at))
    if job_id is not None:
        query = query.where(Run.job_id == job_id)
    rows = (
        await session.execute(query.group_by(Run.job_id, Run.model, Run.model_version, Run.run_kind))
    ).all()
    best: dict[tuple, tuple[tuple, str]] = {}
    for job_id, model, version, kind, last_seen in rows:
        key = (job_id, family_key(model, version))
        rank = (kind == "PRODUCTION", last_seen)  # production beats other kinds; then the latest wins
        if key not in best or rank > best[key][0]:
            best[key] = (rank, normalize(version))
    return {key: version for key, (_, version) in best.items()}


async def recompute(
    session: AsyncSession, *, now: datetime | None = None, settings: Settings | None = None,
    project_id: str | None = None,
) -> DecayStats:
    """Re-score every run that is not archived yet (optionally one project's), and archive the ones that
    have faded.

    `now` can be set to any moment, which is how the simulated-time harness replays weeks in minutes.
    """
    settings = settings or get_settings()
    now = now or datetime.now(UTC)
    stats = DecayStats()
    jobs = (
        await session.execute(select(Job.job_id).where(*([Job.project_id == project_id] if project_id else [])))
    ).scalars().all()
    # One job at a time, CHUNK runs at a time: memory stays bounded however many runs accumulate.
    for job_id in jobs:
        await _recompute_job(session, job_id, now, settings, stats)
    if stats.archived:
        log.info("decay: scored %d runs, archived %d", stats.scored, stats.archived)
    return stats


async def _recompute_job(session: AsyncSession, job_id, now: datetime, settings: Settings, stats: DecayStats) -> None:
    mean_cost = float(
        (await session.execute(select(func.avg(Run.cost_usd)).where(Run.job_id == job_id))).scalar() or 0
    )
    current = await current_versions(session, job_id)
    table = Run.__table__
    statement = (
        update(table).where(table.c.run_id == bindparam("b_id"))
        .values(importance_score=bindparam("b_imp"), stability=bindparam("b_stab"), state=bindparam("b_state"))
    )
    after = None
    while True:
        query = (
            select(Run.run_id, Run.job_id, Run.project_id, Run.model, Run.model_version, Run.outcome, Run.cost_usd,
                   Run.created_at, Run.state)
            .where(Run.job_id == job_id, Run.state != "ARCHIVED").order_by(Run.run_id).limit(CHUNK)
        )
        if after is not None:
            query = query.where(Run.run_id > after)
        runs = (await session.execute(query)).all()
        if not runs:
            break
        after = runs[-1].run_id
        updates = [_score(run, current, mean_cost, now, settings, stats) for run in runs]
        await session.execute(statement, updates)
        await session.commit()


def _score(run, current: dict, mean_cost: float, now: datetime, settings: Settings, stats: DecayStats) -> dict:
    """One run's importance, stability and state, as bind parameters for the batched UPDATE."""
    version = normalize(run.model_version)
    # An unrecognised version is treated as current (TIP 3.7), so one odd row never stops the pass.
    superseded = version != current.get((run.job_id, family_key(run.model, run.model_version)), version)
    imp = importance(run.outcome, float(run.cost_usd or 0), mean_cost)
    stab = stability_days(
        imp, superseded=superseded, base_days=settings.decay_base_days,
        superseded_factor=settings.version_factor_superseded,
    )
    weight = freshness(age_days(run.created_at, now), stab)
    archive = is_archived(weight, settings.archive_below_weight) and run.state in ARCHIVABLE_STATES
    stats.scored += 1
    stats.superseded += superseded
    stats.archived += archive
    if archive:
        log.info(
            "run archived",
            extra={"run_id": str(run.run_id), "job_id": str(run.job_id), "project_id": run.project_id,
                   "from_state": run.state, "to_state": "ARCHIVED", "weight": round(weight, 4),
                   "age_days": round(age_days(run.created_at, now), 1), "superseded": superseded},
        )
    return {"b_id": run.run_id, "b_imp": imp, "b_stab": stab, "b_state": "ARCHIVED" if archive else run.state}
