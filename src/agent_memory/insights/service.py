"""InsightsService: spend by job, cost per success per model, pass rate by input-size band and
by prompt_version (technical plan 3.4). Groupings and statistics only: the same data always gives
the same answer, and no model generates any of it.

Spend counts PRODUCTION runs only: that is what the application paid for. Re-test spend is reported
by the re-test runner against its own cap. The breakdowns count every checked run (PASS or FAIL),
each with its run count and 95% interval, so a band with five runs is not read as a verdict.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from ..models import Job, Run
from ..pipeline.decay import family_key
from ..recommend.stats import wilson, z_for

BANDS = (("under 8k", 0, 8_000), ("8k to 32k", 8_000, 32_000), ("over 32k", 32_000, None))


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


@dataclass
class Breakdown:
    model: str
    group: str  # the input-size band or the prompt version
    runs: int
    passed: int
    pass_rate: float
    pass_rate_low: float
    pass_rate_high: float
    mean_cost_usd: float
    cost_per_success_usd: float | None


def _band(tokens_in: int) -> str:
    return next(name for name, low, high in BANDS if tokens_in >= low and (high is None or tokens_in < high))


def _rows(groups: dict, confidence: float) -> list[Breakdown]:
    z = z_for(confidence)
    out = []
    for (model, group), (runs, passed, cost) in sorted(groups.items()):
        rate = passed / runs
        low, high = wilson(rate, runs, z)
        mean = cost / runs
        out.append(Breakdown(model, group, runs, passed, rate, low, high, mean, mean / rate if rate else None))
    return out


async def job_insights(
    session: AsyncSession, job: Job, *, days: int = 90, now: datetime | None = None, confidence: float = 0.95
) -> dict[str, list[Breakdown]]:
    """Per model: overall, by input-size band and by prompt version, over the last `days` days."""
    since = (now or datetime.now(UTC)) - timedelta(days=days)
    rows = (
        await session.execute(
            select(Run.model, Run.model_version, Run.tokens_in, Run.prompt_version, Run.outcome, Run.cost_usd)
            .where(Run.job_id == job.job_id, Run.outcome.in_(("PASS", "FAIL")), Run.invalid_at.is_(None),
                   Run.created_at >= since)
        )
    ).all()
    overall: dict = {}
    by_band: dict = {}
    by_prompt: dict = {}
    for r in rows:
        model = family_key(r.model, r.model_version)
        for groups, group in ((overall, "all"), (by_band, _band(r.tokens_in)),
                              (by_prompt, r.prompt_version or "unversioned")):
            runs, passed, cost = groups.get((model, group), (0, 0, 0.0))
            groups[(model, group)] = (runs + 1, passed + (r.outcome == "PASS"), cost + float(r.cost_usd))
    return {"overall": _rows(overall, confidence), "by_input_size": _rows(by_band, confidence),
            "by_prompt_version": _rows(by_prompt, confidence)}
