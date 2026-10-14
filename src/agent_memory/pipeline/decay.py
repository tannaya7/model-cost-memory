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
from ..models import Run
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


async def current_versions(session: AsyncSession) -> dict[tuple, str]:
    """For every (job, model family): the version production is using now."""
    rows = (
        await session.execute(
            select(Run.job_id, Run.model, Run.model_version, Run.run_kind, func.max(Run.created_at))
            .group_by(Run.job_id, Run.model, Run.model_version, Run.run_kind)
        )
    ).all()
    best: dict[tuple, tuple[tuple, str]] = {}
    for job_id, model, version, kind, last_seen in rows:
        key = (job_id, family_key(model, version))
        rank = (kind == "PRODUCTION", last_seen)  # production beats other kinds; then the latest wins
        if key not in best or rank > best[key][0]:
            best[key] = (rank, normalize(version))
    return {key: version for key, (_, version) in best.items()}


async def recompute(
    session: AsyncSession, *, now: datetime | None = None, settings: Settings | None = None
) -> DecayStats:
    """Re-score every run that is not archived yet, and archive the ones that have faded.

    `now` can be set to any moment, which is how the simulated-time harness replays weeks in minutes.
    """
    settings = settings or get_settings()
    now = now or datetime.now(UTC)
    stats = DecayStats()

    mean_cost = {
        job_id: float(avg or 0)
        for job_id, avg in (await session.execute(select(Run.job_id, func.avg(Run.cost_usd)).group_by(Run.job_id))).all()
    }
    current = await current_versions(session)

    runs = (
        await session.execute(
            select(Run.run_id, Run.job_id, Run.model, Run.model_version, Run.outcome, Run.cost_usd, Run.created_at, Run.state)
            .where(Run.state != "ARCHIVED")
        )
    ).all()

    updates = []
    for run in runs:
        superseded = normalize(run.model_version) != current[(run.job_id, family_key(run.model, run.model_version))]
        imp = importance(run.outcome, float(run.cost_usd), mean_cost.get(run.job_id, 0.0))
        stab = stability_days(
            imp, superseded=superseded, base_days=settings.decay_base_days,
            superseded_factor=settings.version_factor_superseded,
        )
        weight = freshness(age_days(run.created_at, now), stab)
        archive = is_archived(weight, settings.archive_below_weight) and run.state in ARCHIVABLE_STATES
        updates.append({"b_id": run.run_id, "b_imp": imp, "b_stab": stab, "b_state": "ARCHIVED" if archive else run.state})
        stats.scored += 1
        stats.superseded += superseded
        stats.archived += archive

    table = Run.__table__
    statement = (
        update(table).where(table.c.run_id == bindparam("b_id"))
        .values(importance_score=bindparam("b_imp"), stability=bindparam("b_stab"), state=bindparam("b_state"))
    )
    for start in range(0, len(updates), CHUNK):
        await session.execute(statement, updates[start : start + CHUNK])
    await session.commit()
    if stats.archived:
        log.info("decay: scored %d runs, archived %d", stats.scored, stats.archived)
    return stats
