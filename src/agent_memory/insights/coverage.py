"""Usage coverage and data quality: how complete and reliable the records MCM actually has are.

What this measures, and what it cannot:
  - It measures the records this product RECEIVED: what a recorder sent in. It says nothing about calls that never reached it. There is no
    independent count of the app's real calls, so there is no "100% complete" figure and none is shown.
  - A "logical task" is one run id group: the calls that share a trace id count as one task, and every call with no trace id counts as its
    own task. A call is one physical attempt. Several attempts in one task are shown, never merged into one price or one usage figure.
  - Every share names its denominator. A category that does not apply to a provider is not shown as zero.
  - Nothing is dropped silently: a doubtful call stays in the counts and is listed under the reason it is doubtful, with examples (ids,
    model, provider and time only: never prompt text, tool arguments or secrets).

Pure reads of the project's own runs. Nothing here calls a provider or changes a record.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

from pydantic import Field
from sqlalchemy import and_, case, distinct, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from ..data_quality import LABELS as FLAG_LABELS
from ..models import IngestDuplicate, Job, Run
from ..schemas import Model
from ..usage_ledger import INCLUSION
from .receipt import BASIS_LABELS

EXAMPLES = 5  # examples shown per cause


class Example(Model):
    run_id: str
    model: str
    provider: str | None
    created_at: datetime


class Share(Model):
    runs: int
    share: float | None = Field(description="runs divided by its denominator; null when the denominator is zero")


class BasisRow(Model):
    status: str
    label: str
    runs: int


class Cause(Model):
    code: str
    label: str
    runs: int
    examples: list[Example]


class ProviderRow(Model):
    provider: str | None
    usage_shape: str | None
    runs: int
    field_notes: dict[str, str] = Field(description="What this provider's usage fields mean here (included in or additional to others)")


class CoverageOut(Model):
    period_start: datetime
    period_end: datetime
    period_days: int
    timezone: str
    filters: dict[str, str | None]
    scope: str
    logical_tasks: int
    attempts: int = Field(description="Physical API attempts recorded in the period (denominator for most shares below)")
    tasks_with_several_attempts: int
    extra_attempts: int = Field(description="Attempts beyond the first in tasks that made several")
    excluded_attempts: int = Field(description="Archived, failed-to-record or invalid attempts: counted here and left out of the quality counts")
    usage_reported: Share
    no_usage_block: Share
    usage_layout_unknown: Share
    model_known: Share
    model_unknown: Share
    priced: Share = Field(description="Calculated from reported usage and a dated list price (including partly priced)")
    caller_cost: Share = Field(description="Cost sent by the app itself, not calculated here")
    unpriced: Share = Field(description="No cost: unknown, never zero")
    checked: Share = Field(description="Passed or failed an explicit check")
    unchecked: Share = Field(description="No pass/fail result yet")
    passed: int
    failed: int
    flagged: Share = Field(description="Attempts with at least one data-quality flag")
    duplicates_ignored: int | None = Field(description="Re-sent copies of an already-recorded call that were ignored; null when a filter makes it unavailable")
    duplicates_note: str
    basis: list[BasisRow]
    causes: list[Cause]
    providers: list[ProviderRow]
    cannot_measure: list[str]
    notes: list[str]


def _share(runs: int, denominator: int) -> Share:
    return Share(runs=runs, share=(runs / denominator) if denominator else None)


async def coverage(session: AsyncSession, project_id: str, *, days: int = 30, provider: str | None = None, model: str | None = None,
                   job: str | None = None, now: datetime | None = None) -> CoverageOut:
    now = now or datetime.now(UTC)
    since = now - timedelta(days=days)
    where = [Run.project_id == project_id, Run.run_kind == "PRODUCTION", Run.created_at >= since, Run.created_at <= now]
    if provider:
        where.append(func.lower(Run.provider) == provider.strip().lower())
    if model:
        where.append(Run.model == model)
    if job:
        where.append(Run.job_id == select(Job.job_id).where(Job.project_id == project_id, Job.name == job).scalar_subquery())

    excluded = or_(Run.state.in_(("ARCHIVED", "INGESTION_FAILED")), Run.invalid_at.is_not(None))
    counted = ~excluded
    # calculated here from usage and a dated list price: has a cost, and the cost was not the caller's own
    priced_ok = Run.cost_usd.is_not(None) & (Run.price_status.is_(None) | (Run.price_status != "CALLER_COST"))
    caller = Run.price_status == "CALLER_COST"
    no_cost = Run.cost_usd.is_(None)
    reported = Run.usage_shape.is_not(None) & (Run.usage_shape != "none")
    unknown_model = or_(Run.model == "", func.lower(Run.model) == "unknown")

    row = (await session.execute(select(
        func.count(Run.run_id),
        func.count(Run.run_id).filter(excluded),
        func.count(Run.run_id).filter(reported),
        func.count(Run.run_id).filter(Run.usage_shape == "none"),
        func.count(Run.run_id).filter(Run.usage_shape.is_(None)),
        func.count(Run.run_id).filter(unknown_model),
        func.count(Run.run_id).filter(priced_ok),
        func.count(Run.run_id).filter(caller & Run.cost_usd.is_not(None)),
        func.count(Run.run_id).filter(no_cost),
        func.count(Run.run_id).filter(counted & Run.outcome.in_(("PASS", "FAIL"))),
        func.count(Run.run_id).filter(counted & (Run.outcome == "UNKNOWN")),
        func.count(Run.run_id).filter(counted & (Run.outcome == "PASS")),
        func.count(Run.run_id).filter(counted & (Run.outcome == "FAIL")),
        func.count(Run.run_id).filter(Run.data_flags.is_not(None)),
        func.count(distinct(Run.trace_id)),
        func.count(Run.run_id).filter(Run.trace_id.is_(None)),
    ).where(*where))).one()
    (n, n_excluded, n_reported, n_nousage, n_nolayout, n_unknown_model, n_priced, n_caller, n_nocost, n_checked, n_unchecked, n_pass, n_fail,
     n_flagged, n_traces, n_untraced) = (int(v) for v in row)

    grouped = (await session.execute(
        select(Run.trace_id, func.count().label("c")).where(*where, Run.trace_id.is_not(None)).group_by(Run.trace_id).having(func.count() > 1)
    )).all()
    n_several = len(grouped)
    n_extra = sum(int(c) - 1 for _, c in grouped)

    basis_case = case(
        (Run.cost_usd.is_not(None) & Run.price_status.is_(None), "LEGACY"),
        (Run.cost_usd.is_not(None), Run.price_status),
        (Run.price_status.is_(None), "UNPRICED_UNSPECIFIED"),
        else_=Run.price_status,
    )
    counts = {k: int(c) for k, c in (await session.execute(select(basis_case.label("b"), func.count()).where(*where).group_by("b"))).all()}
    basis = [BasisRow(status=k, label=BASIS_LABELS[k], runs=counts[k]) for k in BASIS_LABELS if k in counts]
    basis += [BasisRow(status=k, label="Not priced, reason not recorded", runs=v) for k, v in counts.items() if k not in BASIS_LABELS]

    async def examples(condition) -> list[Example]:
        rows = (await session.execute(
            select(Run.run_id, Run.model, Run.provider, Run.created_at).where(*where, condition).order_by(Run.created_at.desc()).limit(EXAMPLES))).all()
        return [Example(run_id=str(r), model=m, provider=p, created_at=t) for r, m, p, t in rows]

    causes: list[Cause] = []

    async def add(code: str, label: str, condition, count: int) -> None:
        if count > 0:
            causes.append(Cause(code=code, label=label, runs=count, examples=await examples(condition)))

    await add("NO_USAGE_BLOCK", "The response carried no usage block, so its tokens and cost are unknown", Run.usage_shape == "none", n_nousage)
    unpriced_with_usage = and_(reported, no_cost)
    n_uwp = int((await session.execute(select(func.count()).where(*where, unpriced_with_usage))).scalar_one())
    await add("USAGE_WITHOUT_PRICE", "Usage was reported but no list price matched, so there is no cost", unpriced_with_usage, n_uwp)
    await add("PARTLY_PRICED", "Priced, but the response named a price-changing label this product cannot price", Run.price_status == "PARTLY_PRICED",
              counts.get("PARTLY_PRICED", 0))
    await add("UNKNOWN_MODEL", "The model identity is missing or unknown", unknown_model, n_unknown_model)
    flag_counts = (await session.execute(
        select(func.unnest(Run.data_flags).label("flag")).where(*where, Run.data_flags.is_not(None)).subquery().select()
    )).scalars().all()
    for code in sorted(set(flag_counts)):
        await add(code, FLAG_LABELS.get(code, code), Run.data_flags.contains([code]), flag_counts.count(code))

    shapes = (await session.execute(
        select(Run.provider, Run.usage_shape, func.count()).where(*where).group_by(Run.provider, Run.usage_shape).order_by(func.count().desc()).limit(30))).all()
    providers = [ProviderRow(provider=p, usage_shape=s, runs=int(c), field_notes=dict(INCLUSION.get(s or "", {}))) for p, s, c in shapes]

    filtered = bool(provider or model or job)
    dup: int | None = None
    if not filtered:
        dup = int((await session.execute(select(func.coalesce(func.sum(IngestDuplicate.duplicates), 0)).where(
            IngestDuplicate.project_id == project_id, IngestDuplicate.day >= since.date(), IngestDuplicate.day <= now.date()))).scalar_one())
    tasks = n_traces + n_untraced
    attempts_counted = n - n_excluded
    cannot = [
        "Calls that never reached Model & Cost Memory. There is no independent count of your app's real calls, so they cannot be detected, and "
        "no figure here claims your usage is complete.",
        "Provider-confirmed billed charges. Costs here are calculated from the usage a response reported and a dated list price; none is a settled charge.",
        "Late or out-of-order delivery. Your app's own clock is not recorded, so a call that arrived late looks the same as one that arrived on time.",
        "Whether a streamed response ever delivered its final usage. A call whose usage never arrived appears only as 'no usage block'.",
    ]
    if n_traces == 0 and n > 0:
        cannot.append("Retries versus separate tasks: your app sends no task ids, so every attempt is counted as its own task.")
    return CoverageOut(
        period_start=since, period_end=now, period_days=days, timezone="UTC",
        filters={"provider": provider, "model": model, "job": job},
        scope="Coverage of the records Model & Cost Memory received. It does not measure calls that never reached it.",
        logical_tasks=tasks, attempts=n, tasks_with_several_attempts=n_several, extra_attempts=n_extra, excluded_attempts=n_excluded,
        usage_reported=_share(n_reported, n), no_usage_block=_share(n_nousage, n), usage_layout_unknown=_share(n_nolayout, n),
        model_known=_share(n - n_unknown_model, n), model_unknown=_share(n_unknown_model, n),
        priced=_share(n_priced, n), caller_cost=_share(n_caller, n), unpriced=_share(n_nocost, n),
        checked=_share(n_checked, attempts_counted), unchecked=_share(n_unchecked, attempts_counted), passed=n_pass, failed=n_fail,
        flagged=_share(n_flagged, n),
        duplicates_ignored=dup,
        duplicates_note=("Counted per project and day: re-sent copies of an already-recorded call, ignored so they are not double-counted."
                         if dup is not None else "Not available with a provider, model or task filter: duplicates are counted for the whole project."),
        basis=basis, causes=causes, providers=providers, cannot_measure=cannot,
        notes=[
            "Every share says what it is a share of: attempts, or attempts counted in the checks (excluded ones left out).",
            "A category that does not apply to a provider is not shown as zero. Providers report different usage fields and they are not equivalent.",
            "Nothing is dropped silently. A doubtful call stays in every total and is listed under the reason it is doubtful.",
            "Days are counted in UTC.",
        ],
    )
