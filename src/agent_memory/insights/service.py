"""InsightsService: spend by job, cost per success per model, pass rate by input-size band and
by prompt_version. Groupings and statistics only. Weeks 7 and 9.

Spend counts PRODUCTION runs only: that is what the application paid for. Re-test spend is reported
by the re-test runner against its own cap (Week 10).
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from ..models import Job, Run


@dataclass
class JobSpend:
    job: str
    runs: int
    spend_usd: float
    share: float  # of the project's spend in the window, 0..1


async def spend_by_job(
    session: AsyncSession, project_id: str, *, days: int = 30, now: datetime | None = None
) -> list[JobSpend]:
    """Every job in the project, most expensive first, over the last `days` days."""
    since = (now or datetime.now(UTC)) - timedelta(days=days)
    rows = (
        await session.execute(
            select(Job.name, func.count(Run.run_id), func.coalesce(func.sum(Run.cost_usd), 0))
            .select_from(Job)
            .outerjoin(Run, (Run.job_id == Job.job_id) & (Run.run_kind == "PRODUCTION") & (Run.created_at >= since))
            .where(Job.project_id == project_id)
            .group_by(Job.name)
        )
    ).all()
    total = sum(float(spend) for _, _, spend in rows)
    spends = [
        JobSpend(job=name, runs=runs, spend_usd=float(spend), share=float(spend) / total if total else 0.0)
        for name, runs, spend in rows
    ]
    return sorted(spends, key=lambda s: (-s.spend_usd, s.job))
