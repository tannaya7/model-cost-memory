"""Lineage in Postgres, followed with recursive queries (technical plan 3.2). No graph database.

Two columns carry it: `recommendations.consolidated_from` (a conclusion to the runs behind it) and
`recommendations.superseded_by_id` (a conclusion to the one that replaced it).
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from datetime import datetime

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from ..models import Recommendation

# Start from the job's first recommendation (the one nothing supersedes into) and follow
# superseded_by_id forward: the decision history, oldest first.
_CHAIN = text("""
    WITH RECURSIVE chain AS (
        SELECT r.*, 0 AS depth FROM recommendations r
        WHERE r.job_id = :job_id
          AND NOT EXISTS (SELECT 1 FROM recommendations p WHERE p.superseded_by_id = r.recommendation_id)
        UNION ALL
        SELECT r.*, c.depth + 1 FROM recommendations r JOIN chain c ON r.recommendation_id = c.superseded_by_id
    )
    SELECT recommendation_id FROM chain ORDER BY depth
""")

_VERSIONS = text("""
    SELECT model, model_version, count(*) AS runs, min(created_at) AS first_seen, max(created_at) AS last_seen
    FROM runs WHERE job_id = :job_id
    GROUP BY model, model_version ORDER BY min(created_at)
""")


async def history(session: AsyncSession, job_id: uuid.UUID) -> list[Recommendation]:
    """Every recommendation the job has had, in the order they replaced each other."""
    ids = [row[0] for row in (await session.execute(_CHAIN, {"job_id": job_id})).all()]
    if not ids:
        return []
    rows = {r.recommendation_id: r for r in (
        await session.execute(
            Recommendation.__table__.select().where(Recommendation.recommendation_id.in_(ids))
        )
    ).all()}
    return [rows[i] for i in ids]


async def runs_behind(session: AsyncSession, recommendation_id: uuid.UUID) -> list[uuid.UUID]:
    """The run ids one verdict rests on."""
    row = (await session.execute(
        text("SELECT consolidated_from FROM recommendations WHERE recommendation_id = :rec"),
        {"rec": recommendation_id},
    )).first()
    return list(row[0]) if row else []


@dataclass
class VersionSeen:
    model: str
    model_version: str
    runs: int
    first_seen: datetime
    last_seen: datetime


async def model_versions(session: AsyncSession, job_id: uuid.UUID) -> list[VersionSeen]:
    """Every model version a job has ever run on, first seen first."""
    return [VersionSeen(*row) for row in (await session.execute(_VERSIONS, {"job_id": job_id})).all()]
