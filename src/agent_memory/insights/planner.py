"""Cost scenario planner: what a task might cost at traffic levels YOU type in, worked out from its own recorded calls.

It is a calculator, not a forecast. It never calls a provider, never replays anything, never changes a setting and never says what traffic will be.

Method (plain words, and exactly what the code does):
  1. Take the task's own recorded production calls in the chosen window. Nothing from other tasks is mixed in to make the sample bigger.
  2. Use only calls that were calculated here from reported usage and a dated list price (price status PRICED, with the price version kept). Calls
     with no usage block, no matching price, a caller-supplied cost, a price-changing label this product cannot price, or an impossible usage split are
     left out of the estimate, counted, and shown with the reason. An unknown cost is never replaced by zero or by an average.
  3. For each used call the cost is split, with the price version it was priced under, into an input side (input, cached reads and writes) and an output
     side (output, reasoning included). That lets "inputs 20% larger" scale only the part it applies to. This is an approximation: it assumes cache
     reads and writes grow with the input.
  4. A scenario is: tasks per period (you type it) x attempts per task (1 + your retry rate) x the average cost of one recorded attempt, with your
     size changes applied. The average is the mean of the used calls.
  5. Range. The total of many future calls varies, and the average of a small sample is itself uncertain. Treating future calls as drawn like the recorded
     ones and independent of each other, the standard deviation of the total is  sd = sqrt(M * s^2 * (1 + M / n))  where M is the number of attempts, n the
     number of used calls and s their sample standard deviation. The range shown is the estimate plus and minus 1.28 x sd (low end never below zero). No
     percentage is claimed: call sizes are usually skewed, so the real spread can be wider, and the page says so when the data are very uneven.
  6. Honest minimums (documented, tested): fewer than MIN_FOR_ESTIMATE used calls -> "Not enough comparable data", no number. From MIN_FOR_ESTIMATE to
     MIN_FOR_RANGE - 1 calls -> one estimate with no range (a range from so few calls would be false precision). MIN_FOR_RANGE (30) is the usual point
     where an average of a skewed sample starts to behave; it is a convention, not a guarantee.
  7. Optional visible filter: leave out far-out calls (above Q3 + 3 x IQR of the per-call cost: Tukey's "far out" fence), only with at least
     MIN_FOR_FENCE calls. The result shows how many were left out and the estimate both ways.

Quality sits beside cost with its sample counts and the configured check. Cost per correct answer follows the cost-receipt rule (priced and checked
calls only, over their own passes). A model with no recorded calls on this task is shown as "Not tested on this workload": no cost, no quality.
Pure reads of the project's own runs.
"""

from __future__ import annotations

import math
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from typing import Any

from pydantic import Field
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from ..costing import compute_cost
from ..models import Job, PriceVersion, Run
from ..pricing import version_to_price
from ..schemas import Model
from .receipt import CostPerSuccess, cost_per_success, success_definition

MIN_FOR_ESTIMATE = 5
MIN_FOR_RANGE = 30
MIN_FOR_FENCE = 8
Z = 1.28
MAX_RUNS_READ = 20_000
MAX_CALLS_PER_SCENARIO = 1_000_000_000
IMPOSSIBLE_FLAGS = {"REASONING_EXCEEDS_OUTPUT", "CACHE_1H_EXCEEDS_WRITE", "UNRECOGNISED_USAGE"}
DISCLAIMER = ("This is a scenario worked out from your own recorded calls and the numbers you typed. It is not a bill, a promise or a guaranteed "
              "forecast. Costs are list-price estimates; your provider's invoice is the only charge that counts.")


class CostPerSuccessOut(Model):
    value_usd: float | None
    spend_usd: float
    passed: int
    checked_priced_runs: int
    checked_unpriced_runs: int
    unchecked_runs: int
    reason: str | None
    formula: str


class VersionUsedOut(Model):
    version_id: str
    effective_from: datetime
    effective_to: datetime | None
    source_url: str | None
    checked_at: datetime | None
    runs: int


class ScenarioOut(Model):
    tasks_per_period: int
    attempts: float = Field(description="tasks x (1 + retry rate)")
    estimate_usd: float | None
    low_usd: float | None
    high_usd: float | None
    per_task_usd: float | None
    range_note: str | None


class ModelPlan(Model):
    model: str
    provider: str | None
    observed_calls: int
    used_calls: int
    left_out: dict[str, int] = Field(description="Calls not used in the estimate, by reason")
    filtered_out: int = Field(description="Used calls removed by the visible far-out filter")
    first_call: datetime | None
    last_call: datetime | None
    mean_call_usd: float | None
    mean_call_unfiltered_usd: float | None
    median_call_usd: float | None
    p90_call_usd: float | None
    max_call_usd: float | None
    mean_input_side_usd: float | None
    mean_output_side_usd: float | None
    mean_tokens_in: float | None
    mean_tokens_out: float | None
    uneven: bool = Field(description="Call costs are very uneven, so the range may understate the real spread")
    status: str = Field(description="ESTIMATE | ESTIMATE_NO_RANGE | NOT_ENOUGH_DATA")
    status_text: str
    scenarios: list[ScenarioOut]
    passed: int
    failed: int
    unchecked: int
    excluded: int
    cost_per_success: CostPerSuccessOut
    versions_used: list[VersionUsedOut]
    flagged_included: int = Field(description="Used calls that carry a doubtful-total flag but were kept")


class AssumptionOut(Model):
    name: str
    value: str
    source: str


class PlannerOut(Model):
    job: str
    check_kind: str
    success_definition: str
    currency: str
    period_label: str
    period_start: datetime
    period_end: datetime
    period_days: int
    timezone: str
    truncated: bool
    assumptions: list[AssumptionOut]
    observed_retry_rate: float | None = Field(description="Measured extra attempts per task from your task ids; null when you send none")
    models: list[ModelPlan]
    not_tested: list[str] = Field(description="Models recorded elsewhere in this project but not on this task")
    notes: list[str]
    disclaimer: str


def quantile(sorted_values: list[float], q: float) -> float:
    """Linear-interpolated quantile of an ascending list (the usual 'type 7' definition)."""
    if len(sorted_values) == 1:
        return sorted_values[0]
    pos = (len(sorted_values) - 1) * q
    lo = math.floor(pos)
    hi = min(lo + 1, len(sorted_values) - 1)
    return sorted_values[lo] + (sorted_values[hi] - sorted_values[lo]) * (pos - lo)


def far_out_limit(costs: list[float]) -> float | None:
    """Tukey's far-out fence Q3 + 3 x IQR, or None when there are too few calls to say."""
    if len(costs) < MIN_FOR_FENCE:
        return None
    s = sorted(costs)
    q1, q3 = quantile(s, 0.25), quantile(s, 0.75)
    return q3 + 3 * (q3 - q1)


def project(sides: list[tuple[float, float]], *, tasks: int, retry_rate: float, input_change: float, output_change: float) -> ScenarioOut:
    """One scenario from the used calls' (input side, output side) costs. Pure and deterministic."""
    attempts = tasks * (1 + retry_rate)
    n = len(sides)
    if n < MIN_FOR_ESTIMATE:
        return ScenarioOut(tasks_per_period=tasks, attempts=attempts, estimate_usd=None, low_usd=None, high_usd=None, per_task_usd=None,
                           range_note=None)
    costs = [i * (1 + input_change) + o * (1 + output_change) for i, o in sides]
    mean = math.fsum(costs) / n
    estimate = attempts * mean
    if n < MIN_FOR_RANGE:
        return ScenarioOut(tasks_per_period=tasks, attempts=attempts, estimate_usd=estimate, low_usd=None, high_usd=None,
                           per_task_usd=estimate / tasks,
                           range_note=f"A range needs at least {MIN_FOR_RANGE} comparable calls; you have {n}, so only one estimate is shown.")
    var = math.fsum((c - mean) ** 2 for c in costs) / (n - 1)
    sd = math.sqrt(attempts * var * (1 + attempts / n))
    return ScenarioOut(tasks_per_period=tasks, attempts=attempts, estimate_usd=estimate, low_usd=max(0.0, estimate - Z * sd), high_usd=estimate + Z * sd,
                       per_task_usd=estimate / tasks, range_note=None)


def _f(d: Decimal | None) -> float:
    return float(d or 0)


async def plan(session: AsyncSession, project_id: str, *, job: str, days: int = 30, calls: list[int] | None = None, retry_rate: float = 0.0,
               input_change_pct: float = 0.0, output_change_pct: float = 0.0, exclude_far_out: bool = False, period: str = "month",
               now: datetime | None = None) -> PlannerOut:
    now = now or datetime.now(UTC)
    since = now - timedelta(days=days)
    calls = calls or [1_000, 10_000, 100_000]
    jobrow = (await session.execute(select(Job).where(Job.project_id == project_id, Job.name == job))).scalar_one_or_none()
    if jobrow is None:
        raise LookupError(job)
    base = [Run.project_id == project_id, Run.job_id == jobrow.job_id, Run.run_kind == "PRODUCTION", Run.created_at >= since, Run.created_at <= now,
            Run.invalid_at.is_(None), Run.state.not_in(("ARCHIVED", "INGESTION_FAILED"))]
    rows = (await session.execute(
        select(Run.model, Run.provider, Run.created_at, Run.tokens_in, Run.tokens_out, Run.cache_read_tokens, Run.cache_write_tokens,
               Run.cache_write_1h_tokens, Run.price_status, Run.price_version_id, Run.price_factor, Run.cost_usd, Run.usage_shape, Run.outcome,
               Run.data_flags, Run.trace_id)
        .where(*base).order_by(Run.created_at.desc()).limit(MAX_RUNS_READ + 1))).all()
    truncated = len(rows) > MAX_RUNS_READ
    rows = rows[:MAX_RUNS_READ]

    version_ids = {r.price_version_id for r in rows if r.price_version_id is not None}
    versions = {v.version_id: v for v in (await session.execute(select(PriceVersion).where(PriceVersion.version_id.in_(version_ids)))).scalars()} \
        if version_ids else {}

    by_model: dict[tuple[str, str | None], list[Any]] = {}
    for r in rows:
        by_model.setdefault((r.model, r.provider), []).append(r)

    ie, oe = input_change_pct / 100.0, output_change_pct / 100.0
    models: list[ModelPlan] = []
    for (name, provider), runs in sorted(by_model.items(), key=lambda kv: -len(kv[1])):
        left: dict[str, int] = {}

        def leave(reason: str, left: dict[str, int] = left) -> None:
            left[reason] = left.get(reason, 0) + 1

        used: list[tuple[float, float, Any]] = []
        flagged_kept = 0
        checked_unpriced = 0
        for r in runs:
            flags = set(r.data_flags or [])
            if r.usage_shape == "none" or r.price_status == "NO_USAGE":
                leave("The response carried no usage block (tokens unknown)")
            elif r.price_status == "CALLER_COST":
                leave("Cost was sent by your app, so it cannot be split or rescaled")
            elif r.price_status == "PARTLY_PRICED":
                leave("The response named a price-changing label this product cannot price")
            elif r.cost_usd is None or r.price_version_id is None or r.price_status != "PRICED":
                leave("No dated list price matched, so the cost is unknown")
            elif flags & IMPOSSIBLE_FLAGS:
                leave("Usage was impossible or unreadable (see Data coverage)")
            else:
                v = versions.get(r.price_version_id)
                if v is None:
                    leave("The price version is no longer available")
                    continue
                price = version_to_price(v, name)
                factor = r.price_factor or Decimal(1)
                inside = compute_cost(price, r.tokens_in, 0, r.cache_read_tokens, r.cache_write_tokens, r.cache_write_1h_tokens or 0, factor)
                outside = compute_cost(price, 0, r.tokens_out, 0, 0, 0, factor)
                used.append((_f(inside), _f(outside), r))
                if flags:
                    flagged_kept += 1
                continue
            if r.outcome in ("PASS", "FAIL"):
                checked_unpriced += 1

        full_costs = [i + o for i, o, _ in used]
        limit = far_out_limit(full_costs) if exclude_far_out else None
        kept = [(i, o, r) for i, o, r in used if limit is None or (i + o) <= limit]
        filtered = len(used) - len(kept)
        sides = [(i, o) for i, o, _ in kept]
        kept_costs = [i + o for i, o in sides]
        s = sorted(kept_costs)
        mean = math.fsum(kept_costs) / len(kept_costs) if kept_costs else None
        mean_all = math.fsum(full_costs) / len(full_costs) if full_costs else None
        median = quantile(s, 0.5) if s else None
        p90 = quantile(s, 0.9) if s else None
        uneven = bool(s) and len(s) >= MIN_FOR_FENCE and median is not None and median > 0 and (p90 > 3 * median or s[-1] > 10 * median)

        scenarios = [project(sides, tasks=t, retry_rate=retry_rate, input_change=ie, output_change=oe) for t in calls]
        n_used = len(sides)
        status = "NOT_ENOUGH_DATA" if n_used < MIN_FOR_ESTIMATE else ("ESTIMATE_NO_RANGE" if n_used < MIN_FOR_RANGE else "ESTIMATE")
        status_text = {
            "NOT_ENOUGH_DATA": f"Not enough comparable data: {n_used} usable call(s); at least {MIN_FOR_ESTIMATE} are needed for an estimate.",
            "ESTIMATE_NO_RANGE": f"{n_used} usable calls: one estimate, no range (a range needs {MIN_FOR_RANGE}).",
            "ESTIMATE": f"{n_used} usable calls: an estimate with a range.",
        }[status]

        # quality, among the calls this estimate stands on (priced and checked), over their own passes
        priced_checked = [r for _, _, r in kept if r.outcome in ("PASS", "FAIL")]
        spend = math.fsum(_f(r.cost_usd) for r in priced_checked)
        passed_priced = sum(1 for r in priced_checked if r.outcome == "PASS")
        unchecked_n = sum(1 for r in runs if r.outcome == "UNKNOWN")
        cps: CostPerSuccess = cost_per_success(
            check_kind=jobrow.check_kind, config=jobrow.check_config, spend=spend, passed=passed_priced, checked_priced=len(priced_checked),
            checked_unpriced=checked_unpriced + filtered, unchecked=unchecked_n)

        vc: dict[Any, int] = {}
        for _, _, r in kept:
            vc[r.price_version_id] = vc.get(r.price_version_id, 0) + 1
        versions_used = [VersionUsedOut(version_id=str(k), effective_from=versions[k].effective_from, effective_to=versions[k].effective_to,
                                        source_url=versions[k].source_url, checked_at=versions[k].checked_at, runs=c)
                         for k, c in sorted(vc.items(), key=lambda kv: versions[kv[0]].effective_from)]
        n_in = [r.tokens_in + r.cache_read_tokens + r.cache_write_tokens for _, _, r in kept]
        models.append(ModelPlan(
            model=name, provider=provider, observed_calls=len(runs), used_calls=n_used, left_out=left, filtered_out=filtered,
            first_call=min(r.created_at for r in runs), last_call=max(r.created_at for r in runs),
            mean_call_usd=mean, mean_call_unfiltered_usd=mean_all, median_call_usd=median, p90_call_usd=p90, max_call_usd=s[-1] if s else None,
            mean_input_side_usd=math.fsum(i for i, _ in sides) / n_used if n_used else None,
            mean_output_side_usd=math.fsum(o for _, o in sides) / n_used if n_used else None,
            mean_tokens_in=math.fsum(n_in) / n_used if n_used else None,
            mean_tokens_out=math.fsum(r.tokens_out for _, _, r in kept) / n_used if n_used else None,
            uneven=uneven, status=status, status_text=status_text, scenarios=scenarios,
            passed=sum(1 for r in runs if r.outcome == "PASS"), failed=sum(1 for r in runs if r.outcome == "FAIL"), unchecked=unchecked_n,
            excluded=sum(left.values()) + filtered,
            cost_per_success=CostPerSuccessOut(value_usd=cps.value_usd, spend_usd=cps.spend_usd, passed=cps.passed,
                                               checked_priced_runs=cps.checked_priced_runs, checked_unpriced_runs=cps.checked_unpriced_runs,
                                               unchecked_runs=cps.unchecked_runs, reason=cps.reason, formula=cps.formula),
            versions_used=versions_used, flagged_included=flagged_kept))

    # the same project's other tasks: models recorded there but never on this task are listed as not tested here, with nothing invented for them
    here = {m for m, _ in by_model}
    others = (await session.execute(select(func.distinct(Run.model)).where(
        Run.project_id == project_id, Run.run_kind == "PRODUCTION", Run.created_at >= since, Run.created_at <= now, Run.job_id != jobrow.job_id))
    ).scalars().all()
    not_tested = sorted(m for m in others if m not in here)

    traced: dict[str, int] = {}
    for r in rows:
        if r.trace_id:
            traced[r.trace_id] = traced.get(r.trace_id, 0) + 1
    observed_retry = (sum(c - 1 for c in traced.values()) / len(traced)) if traced else None

    return PlannerOut(
        job=job, check_kind=jobrow.check_kind, success_definition=success_definition(jobrow.check_kind, jobrow.check_config), currency="USD",
        period_label=period, period_start=since, period_end=now, period_days=days, timezone="UTC", truncated=truncated,
        assumptions=[
            AssumptionOut(name="Tasks per " + period, value=", ".join(f"{c:,}" for c in calls), source="You entered this"),
            AssumptionOut(name="Retry rate (extra attempts per task)", value=f"{retry_rate:g}", source="You entered this"),
            AssumptionOut(name="Input size change", value=f"{input_change_pct:+g}%", source="You entered this"),
            AssumptionOut(name="Output size change", value=f"{output_change_pct:+g}%", source="You entered this"),
            AssumptionOut(name="Far-out calls left out", value="yes" if exclude_far_out else "no", source="You chose this"),
            AssumptionOut(name="Calls and prices", value=f"Recorded calls for this task, {days} days to {now:%Y-%m-%d} (UTC), list prices of the day",
                          source="Measured from your history"),
        ],
        observed_retry_rate=observed_retry, models=models, not_tested=not_tested,
        notes=[
            "Measured history and your assumptions are kept apart: nothing about your future traffic, adoption or quality is guessed.",
            "Calls that could not be priced are left out of the estimate and counted; they are never treated as free or as average.",
            "Each model's estimate uses only that model's own calls on this task.",
            "A model with no recorded calls on this task shows 'Not tested on this workload': no cost and no quality is invented for it.",
            "Batch, region and cache effects are included only as far as the stored price version and its verified modifier record them.",
        ] + (["The task has more calls than can be read at once; the most recent ones are used."] if truncated else []),
        disclaimer=DISCLAIMER,
    )
