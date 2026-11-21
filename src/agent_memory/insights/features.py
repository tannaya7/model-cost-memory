"""Cost, calls and quality grouped by the customer's own feature label (runs.feature).

A label such as `support_summary` or `invoice_reader` is chosen by the customer's own app and sent with a call. It is optional. It is NOT a
verified identity and not an invoice-grade chargeback record: anyone holding the project key can send any label. Calls with no label are
shown, as their own row, never hidden or spread over the labelled ones.

Rules this module keeps (the same ones as the cost receipt, so the numbers can be compared):
  - An unknown cost is never zero. A run with no price is counted as unpriced and left out of every sum.
  - Tokens are summed only over runs whose response reported usage. A run with no usage block is counted apart, not as zero tokens.
  - Cost per correct answer is the cost of the PRICED, CHECKED runs divided by the passes among those same runs, so unchecked and unpriced
    runs cannot skew it. It needs an explicit pass/fail check; otherwise it says why it does not exist yet.
  - Nothing here infers a label from prompt text, and nothing is written into the customer's code.
"""

from __future__ import annotations

from dataclasses import asdict
from datetime import UTC, datetime, timedelta

from pydantic import Field
from sqlalchemy import func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from ..models import Run
from ..schemas import CostPerSuccessOut, Model
from .receipt import CURRENCY, cost_per_success

UNLABELLED = "Unlabelled"
OTHER = "Other labels"
MAX_SHOWN = 25  # rows shown; the rest are added together into one "Other labels" row
MAX_GROUPS = 1000  # a project that sends thousands of different labels is read only this far


class FeatureRowOut(Model):
    feature: str | None = Field(description="The label your app sent; null for calls that carried none, and for the folded 'Other labels' row")
    label: str = Field(description="What to show: the label, 'Unlabelled' or 'Other labels'")
    folded_labels: int | None = Field(default=None, description="How many labels an 'Other labels' row stands for")
    runs: int
    passed: int
    failed: int
    unchecked: int = Field(description="Calls with no pass/fail result yet: never counted as passes")
    excluded: int = Field(description="Calls left out of the checks (archived, failed to record, or marked invalid)")
    tokens: int = Field(description="Input, output, cache reads and writes, summed over the calls whose response reported usage")
    no_usage_runs: int = Field(description="Calls whose response carried no usage block: their tokens are unknown, not zero")
    spend_usd: float = Field(description="List-price estimate over the priced calls only")
    unpriced_runs: int = Field(description="Calls with no known price: left out of spend_usd")
    share_of_spend: float | None = Field(description="This row's part of all priced spend in the period; null when there is none")
    cost_per_success: CostPerSuccessOut


class FeatureBreakdownOut(Model):
    currency: str
    timezone: str
    period_start: datetime
    period_end: datetime
    period_days: int
    rows: list[FeatureRowOut]
    total_runs: int
    labelled_runs: int
    labelled_share: float | None = Field(description="Part of the calls that carried a label; null with no calls")
    truncated: bool = Field(description="More distinct labels exist than were read; the smallest are not in any row")
    notes: list[str]


def _num(value) -> float:
    return float(value or 0)


async def feature_breakdown(session: AsyncSession, project_id: str, *, days: int = 30, now: datetime | None = None) -> FeatureBreakdownOut:
    now = now or datetime.now(UTC)
    since = now - timedelta(days=days)
    excluded = or_(Run.state.in_(("ARCHIVED", "INGESTION_FAILED")), Run.invalid_at.is_not(None))
    counted = ~excluded
    priced = Run.cost_usd.is_not(None)
    checked = Run.outcome.in_(("PASS", "FAIL"))
    reports_usage = func.coalesce(Run.usage_shape, "") != "none"
    tokens = Run.tokens_in + Run.tokens_out + Run.cache_read_tokens + Run.cache_write_tokens
    where = [Run.project_id == project_id, Run.run_kind == "PRODUCTION", Run.created_at >= since, Run.created_at <= now]

    spend_total = func.coalesce(func.sum(Run.cost_usd), 0)
    rows = (await session.execute(
        select(
            Run.feature,
            func.count(Run.run_id),
            func.count(Run.run_id).filter(counted & (Run.outcome == "PASS")),
            func.count(Run.run_id).filter(counted & (Run.outcome == "FAIL")),
            func.count(Run.run_id).filter(counted & (Run.outcome == "UNKNOWN")),
            func.count(Run.run_id).filter(excluded),
            func.coalesce(func.sum(tokens).filter(reports_usage), 0),
            func.count(Run.run_id).filter(~reports_usage),
            spend_total,
            func.count(Run.run_id).filter(~priced),
            func.coalesce(func.sum(Run.cost_usd).filter(counted & checked & priced), 0),
            func.count(Run.run_id).filter(counted & checked & priced),
            func.count(Run.run_id).filter(counted & (Run.outcome == "PASS") & priced),
            func.count(Run.run_id).filter(counted & checked & ~priced),
        ).where(*where).group_by(Run.feature).order_by(spend_total.desc(), func.count(Run.run_id).desc(), Run.feature).limit(MAX_GROUPS + 1)
    )).all()
    truncated = len(rows) > MAX_GROUPS
    rows = rows[:MAX_GROUPS]

    def build(feature, label, folded, s) -> FeatureRowOut:
        (n, p, f, u, ex, tok, nousage, spend, unp, cps, cpn, cpp, cpu) = s
        success = cost_per_success(check_kind="LATE_LABEL", config=None, spend=cps, passed=cpp, checked_priced=cpn, checked_unpriced=cpu, unchecked=u)
        success.success_definition = "Each task's own definition of a correct answer (see each task)"
        return FeatureRowOut(
            feature=feature, label=label, folded_labels=folded, runs=n, passed=p, failed=f, unchecked=u, excluded=ex, tokens=int(tok),
            no_usage_runs=nousage, spend_usd=spend, unpriced_runs=unp, share_of_spend=None, cost_per_success=CostPerSuccessOut(**asdict(success)))

    def numbers(row) -> list[float]:
        return [int(row[1]), int(row[2]), int(row[3]), int(row[4]), int(row[5]), int(row[6]), int(row[7]), _num(row[8]), int(row[9]),
                _num(row[10]), int(row[11]), int(row[12]), int(row[13])]

    shown, rest = [], []
    for row in rows:
        (shown if row[0] is None or len(shown) < MAX_SHOWN else rest).append(row)
    # The unlabelled row is always shown; the labelled rows shown are the first ones by spend, the rest are added together below.
    out = [build(r[0], r[0] if r[0] is not None else UNLABELLED, None, numbers(r)) for r in shown]
    if rest:
        sums = [sum(col) for col in zip(*(numbers(r) for r in rest), strict=True)]
        out.append(build(None, OTHER, len(rest), sums))
    total_spend = sum(r.spend_usd for r in out)
    for r in out:
        r.share_of_spend = (r.spend_usd / total_spend) if total_spend > 0 else None
    total_runs = sum(r.runs for r in out)
    labelled_runs = sum(r.runs for r in out if r.feature is not None or r.label == OTHER)
    return FeatureBreakdownOut(
        currency=CURRENCY, timezone="UTC", period_start=since, period_end=now, period_days=days, rows=out,
        total_runs=total_runs, labelled_runs=labelled_runs, labelled_share=(labelled_runs / total_runs) if total_runs else None,
        truncated=truncated,
        notes=[
            "Labels come from your own app. They are not verified identities and not invoice-grade chargeback records: anyone with a "
            "project key can send any label.",
            "Calls that carried no label are shown as 'Unlabelled'. They are not spread over the labelled features.",
            "Amounts are US dollars at public list prices, an estimate from recorded calls and not your invoice. Calls with no known "
            "price are left out of the spend and counted as unpriced.",
            "Cost per correct answer uses only calls that were both checked and priced. It needs a pass/fail check on the task.",
            "Days are counted in UTC.",
        ],
    )
