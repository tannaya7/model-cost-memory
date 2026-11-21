"""The cost receipt: how a spend figure was worked out, so it can be inspected and not just believed.

For a period of production runs it gives: the currency and period; how many runs passed, failed, were never
checked, or are left out of the checks; which runs are priced and on what basis; which dated price versions
priced them and when each was last checked; how many runs are unpriced and why; and a cost per correct answer
with its formula and the counts it came from.

Rules this module keeps:
  - An unknown cost is never zero. A run with no price is counted as unpriced and left out of every sum.
  - Cost per correct answer is the cost of the PRICED, CHECKED runs divided by the passes among those same
    runs. Numerator and denominator come from the same runs, so unchecked runs and unpriced runs cannot skew it.
    Spend on all runs divided by passes (with unchecked runs inside the spend) is never used.
  - A failed check is "spend on answers that failed their check": it may be a deliberate test, so it is not
    called waste.
  - Amounts are US dollars at public list prices (see pricing.py). They are not an invoice.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from typing import Any

from sqlalchemy import case, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from ..models import Job, PriceVersion, Run

CURRENCY = "USD"

# Why a run does or does not have a cost, in plain words (the keys are runs.price_status).
BASIS_LABELS = {
    "PRICED": "Calculated from the usage the provider reported and a dated list price",
    "PARTLY_PRICED": "Calculated the same way, but the response named a price-changing label this app cannot "
                     "price (so the true cost may differ)",
    "CALLER_COST": "Cost sent by your own app; not calculated here",
    "LEGACY": "Calculated from reported usage and the list price of the day, recorded before price versions "
              "existed (the exact price version is not known)",
    "NO_USAGE": "Not priced: the response carried no usage block, so the tokens are unknown",
    "UNPRICED_UNKNOWN_MODEL": "Not priced: no list price is known for this model name",
    "UNPRICED_NOT_YET_EFFECTIVE": "Not priced: the only known price starts in the future",
    "UNPRICED_EXPIRED": "Not priced: the known price is no longer in force",
    "UNPRICED_UNSPECIFIED": "Not priced: no cost is known (recorded before price versions existed)",
}
UNPRICED_KEYS = ("NO_USAGE", "UNPRICED_UNKNOWN_MODEL", "UNPRICED_NOT_YET_EFFECTIVE", "UNPRICED_EXPIRED",
                 "UNPRICED_UNSPECIFIED")

FORMULA = ("Cost of the priced, checked calls ÷ number of those calls that passed. Unchecked calls and "
           "unpriced calls are left out of both numbers.")


@dataclass
class CostPerSuccess:
    value_usd: float | None
    formula: str
    spend_usd: float  # numerator: cost of the priced, checked runs
    passed: int  # denominator: passes among those same runs
    checked_priced_runs: int
    checked_unpriced_runs: int  # checked runs left out because their cost is unknown
    unchecked_runs: int  # left out: no pass/fail result yet
    reason: str | None  # why value_usd is None
    success_definition: str


@dataclass
class VersionUsed:
    version_id: str
    model: str
    provider: str
    input_per_mtok: float
    output_per_mtok: float
    effective_from: datetime
    effective_to: datetime | None
    source_kind: str
    source_url: str | None
    checked_at: datetime | None
    applicability: str | None
    runs: int
    spend_usd: float


@dataclass
class JobReceipt:
    job: str
    runs: int
    passed: int
    failed: int
    unchecked: int
    excluded: int
    spend_usd: float
    unpriced_runs: int
    cost_per_success: CostPerSuccess


@dataclass
class Receipt:
    currency: str
    timezone: str
    period_start: datetime
    period_end: datetime
    period_days: int
    runs: int
    passed: int
    failed: int
    unchecked: int
    excluded: int
    spend_usd: float
    spend_on_failed_checks_usd: float
    unpriced_runs: int
    unpriced_note: str | None
    partly_priced_runs: int
    basis: list[dict[str, Any]] = field(default_factory=list)
    price_versions: list[VersionUsed] = field(default_factory=list)
    price_versions_checked_at: datetime | None = None
    price_versions_oldest_effective: datetime | None = None
    cost_per_success: CostPerSuccess | None = None
    jobs: list[JobReceipt] = field(default_factory=list)
    notes: list[str] = field(default_factory=list)


def success_definition(check_kind: str, config: dict[str, Any] | None) -> str:
    """What "correct" means for this task, in words, from how its checking is set up."""
    if check_kind == "ANSWER_KEY":
        fields = (config or {}).get("fields")
        named = f" ({', '.join(str(f) for f in fields)})" if isinstance(fields, list) and fields else ""
        return f"The answer matches your answer key{named}"
    if check_kind == "TEST_COMMAND":
        return "The answer passes the test command you set"
    if check_kind == "SCHEMA":
        return "The answer matches the JSON shape you set"
    return "You marked the answer correct"  # LATE_LABEL


def cost_per_success(*, check_kind: str, config: dict[str, Any] | None, spend: float, passed: int,
                     checked_priced: int, checked_unpriced: int, unchecked: int) -> CostPerSuccess:
    """The cost of one correct answer, or None with the reason. All inputs come from the same priced, checked runs
    (except the three counts that say what was left out)."""
    reason: str | None = None
    value: float | None = None
    if checked_priced == 0:
        reason = ("No call has been checked and priced yet" if checked_unpriced == 0
                  else "Every checked call is missing a price, so no cost can be worked out")
    elif passed == 0:
        reason = "None of the checked calls passed, so a cost per correct answer does not exist yet"
    else:
        value = spend / passed
    return CostPerSuccess(value_usd=value, formula=FORMULA, spend_usd=spend, passed=passed,
                          checked_priced_runs=checked_priced, checked_unpriced_runs=checked_unpriced,
                          unchecked_runs=unchecked, reason=reason,
                          success_definition=success_definition(check_kind, config))


def _num(value: Any) -> float:
    return float(value or 0)


async def cost_receipt(session: AsyncSession, project_id: str, *, days: int = 30, job_id=None,
                       now: datetime | None = None) -> Receipt:
    now = now or datetime.now(UTC)
    since = now - timedelta(days=days)
    excluded = or_(Run.state.in_(("ARCHIVED", "INGESTION_FAILED")), Run.invalid_at.is_not(None))
    counted = ~excluded
    priced = Run.cost_usd.is_not(None)
    checked = Run.outcome.in_(("PASS", "FAIL"))
    # The price basis of a run; unpriced reasons stay separate so each can be counted.
    basis = case(
        (priced & (Run.price_status.is_(None)), "LEGACY"),
        (priced, Run.price_status),
        (Run.price_status.is_(None), "UNPRICED_UNSPECIFIED"),
        else_=Run.price_status,
    )
    where = [Run.project_id == project_id, Run.run_kind == "PRODUCTION", Run.created_at >= since, Run.created_at <= now]
    if job_id is not None:
        where.append(Run.job_id == job_id)

    per_job = (await session.execute(
        select(
            Job.name, Job.check_kind, Job.check_config,
            func.count(Run.run_id),
            func.count(Run.run_id).filter(counted & (Run.outcome == "PASS")),
            func.count(Run.run_id).filter(counted & (Run.outcome == "FAIL")),
            func.count(Run.run_id).filter(counted & (Run.outcome == "UNKNOWN")),
            func.count(Run.run_id).filter(excluded),
            func.coalesce(func.sum(Run.cost_usd), 0),
            func.count(Run.run_id).filter(~priced),
            func.coalesce(func.sum(Run.cost_usd).filter(counted & (Run.outcome == "FAIL")), 0),
            func.coalesce(func.sum(Run.cost_usd).filter(counted & checked & priced), 0),
            func.count(Run.run_id).filter(counted & checked & priced),
            func.count(Run.run_id).filter(counted & (Run.outcome == "PASS") & priced),
            func.count(Run.run_id).filter(counted & checked & ~priced),
        ).join(Job, Job.job_id == Run.job_id).where(*where).group_by(Job.job_id, Job.name, Job.check_kind, Job.check_config)
        .order_by(func.coalesce(func.sum(Run.cost_usd), 0).desc(), Job.name)
    )).all()

    jobs: list[JobReceipt] = []
    totals = dict(runs=0, passed=0, failed=0, unchecked=0, excluded=0, spend=0.0, unpriced=0, failed_spend=0.0,
                  cp_spend=0.0, cp_n=0, cp_pass=0, cp_unpriced=0)
    for (name, kind, config, n, p, f, u, ex, spend, unp, fspend, cps, cpn, cpp, cpu) in per_job:
        jobs.append(JobReceipt(
            job=name, runs=int(n), passed=int(p), failed=int(f), unchecked=int(u), excluded=int(ex),
            spend_usd=_num(spend), unpriced_runs=int(unp),
            cost_per_success=cost_per_success(check_kind=kind, config=config, spend=_num(cps), passed=int(cpp),
                                              checked_priced=int(cpn), checked_unpriced=int(cpu), unchecked=int(u))))
        for key, value in (("runs", n), ("passed", p), ("failed", f), ("unchecked", u), ("excluded", ex),
                           ("spend", _num(spend)), ("unpriced", unp), ("failed_spend", _num(fspend)),
                           ("cp_spend", _num(cps)), ("cp_n", cpn), ("cp_pass", cpp), ("cp_unpriced", cpu)):
            totals[key] += value

    basis_rows = (await session.execute(
        select(basis.label("b"), func.count(Run.run_id), func.coalesce(func.sum(Run.cost_usd), 0))
        .where(*where).group_by("b")
    )).all()
    counts = {b: (int(n), _num(s), ) for b, n, s in basis_rows}
    basis_out = [
        {"status": key, "label": BASIS_LABELS[key], "runs": counts[key][0],
         "spend_usd": counts[key][1] if key not in UNPRICED_KEYS else None}  # an unknown is None, never 0
        for key in BASIS_LABELS if key in counts
    ]

    version_rows = (await session.execute(
        select(PriceVersion, func.count(Run.run_id), func.coalesce(func.sum(Run.cost_usd), 0))
        .join(Run, Run.price_version_id == PriceVersion.version_id).where(*where, priced)
        .group_by(PriceVersion.version_id).order_by(func.coalesce(func.sum(Run.cost_usd), 0).desc()).limit(50)
    )).all()
    versions = [
        VersionUsed(version_id=str(v.version_id), model=v.model, provider=v.provider,
                    input_per_mtok=float(v.input_per_mtok), output_per_mtok=float(v.output_per_mtok),
                    effective_from=v.effective_from, effective_to=v.effective_to, source_kind=v.source_kind,
                    source_url=v.source_url, checked_at=v.checked_at, applicability=v.applicability,
                    runs=int(n), spend_usd=_num(s))
        for v, n, s in version_rows
    ]
    checked_stamps = [v.checked_at for v in versions if v.checked_at is not None]
    unpriced = totals["unpriced"]
    receipt = Receipt(
        currency=CURRENCY, timezone="UTC", period_start=since, period_end=now, period_days=days,
        runs=totals["runs"], passed=totals["passed"], failed=totals["failed"], unchecked=totals["unchecked"],
        excluded=totals["excluded"], spend_usd=totals["spend"], spend_on_failed_checks_usd=totals["failed_spend"],
        unpriced_runs=unpriced,
        unpriced_note=(f"{unpriced} unpriced run{'s' if unpriced != 1 else ''} excluded from this total"
                       if unpriced else None),
        partly_priced_runs=counts.get("PARTLY_PRICED", (0, 0.0))[0],
        basis=basis_out, price_versions=versions,
        price_versions_checked_at=min(checked_stamps) if checked_stamps else None,
        price_versions_oldest_effective=min((v.effective_from for v in versions), default=None),
        jobs=jobs,
        notes=[
            "Amounts are US dollars at public list prices. They are an estimate from recorded calls, not your "
            "invoice, and not a negotiated or discounted price.",
            "Days are counted in UTC.",
            "A failed check can be a deliberate test, so spend on failed checks is not called wasted.",
        ],
    )
    if len(jobs) == 1:
        receipt.cost_per_success = jobs[0].cost_per_success
    elif jobs:
        receipt.cost_per_success = cost_per_success(
            check_kind="LATE_LABEL", config=None, spend=totals["cp_spend"], passed=totals["cp_pass"],
            checked_priced=totals["cp_n"], checked_unpriced=totals["cp_unpriced"], unchecked=totals["unchecked"])
        receipt.cost_per_success.success_definition = "Each task's own definition of a correct answer (see each task)"
    return receipt


__all__ = ["BASIS_LABELS", "FORMULA", "Receipt", "cost_per_success", "cost_receipt", "success_definition"]
