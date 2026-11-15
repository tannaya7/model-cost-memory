"""Scheduled watchers that raise project-level alerts: token bursts, monthly budget, model retirement.

Alerts hang off a job (alerts.job_id), so each one is attached to the job that explains it: the job that
used the most tokens in a burst, spent the most this month, or ran the retiring model. Every watcher
only raises alerts; none of them blocks, throttles or changes anything. Wording is plain and carries
figures only, never prompt text.

Constants marked "our choice" are not from a provider or a vendor doc; they are judgements to tune.
"""

from __future__ import annotations

import calendar
from collections import defaultdict
from datetime import UTC, date, datetime, timedelta
from decimal import Decimal

from sqlalchemy import Float, cast, func, literal, select
from sqlalchemy.ext.asyncio import AsyncSession

from ..catalog.lifecycle import lifecycles, most_used
from ..models import Alert, Job, Project, Run
from ..options import split_option
from ..versions import normalize
from .burst import detect_token_burst
from .service import raise_alert

# Token burst. Every number here is our choice: the research verified only that a heads-up with a volume
# floor is wanted, not the values.
BURST_WINDOW_MINUTES = 60
BURST_BASELINE_WINDOWS = 24
BURST_FACTOR = 3.0  # the latest hour must be more than 3x the usual hour
MIN_BURST_TOKENS = 50_000  # our choice: an hour under this many tokens is never a burst, however quiet before
SUPPRESS = timedelta(hours=24)  # LiteLLM's budget-alert TTL is 86,400 s; we use 24 hours for all three kinds

# Budget. 85% and 95% of actual spend with 24-hour dedupe is LiteLLM's documented behaviour.
BUDGET_LEVELS = (85, 95)
PROJECTION_DAYS = 7  # our choice: average of the last 7 full days; needs 7 days of data (AWS: no forecast on short history)

# Retirement. 60 days ahead and 30 days of recent use are our choices (60 echoes Anthropic's minimum notice).
RETIRING_WITHIN_DAYS = 60
RECENT_USE_DAYS = 30


def _tokens():
    return Run.tokens_in + Run.tokens_out + Run.cache_read_tokens + Run.cache_write_tokens


async def _alerted(
    session: AsyncSession, project_id: str, kind: str, since: datetime | None, key: str | None = None
) -> bool:
    """Was an alert of this kind (and dedupe key, if given) raised for the project since `since`, resolved or not?"""
    q = (select(Alert.alert_id).join(Job, Job.job_id == Alert.job_id)
         .where(Job.project_id == project_id, Alert.kind == kind).limit(1))
    if since is not None:
        q = q.where(Alert.created_at >= since)
    if key is not None:
        q = q.where(Alert.dedupe_key == key)
    return (await session.execute(q)).first() is not None


# ---------------------------------------------------------------- token burst

async def check_token_bursts(session: AsyncSession, *, now: datetime | None = None) -> list[Alert]:
    """Per project: tokens in the last hour against the usual hour of the 24 before it."""
    now = now or datetime.now(UTC)
    window = timedelta(minutes=BURST_WINDOW_MINUTES)
    since = now - (BURST_BASELINE_WINDOWS + 1) * window
    # window 0 is (now - 1h, now]; each window becomes one point at its middle for detect_token_burst
    age = func.extract("epoch", literal(now, Run.created_at.type) - Run.created_at)
    index = func.floor(cast(age, Float) / window.total_seconds()).label("w")
    rows = (await session.execute(
        select(Run.project_id, Run.job_id, index, func.sum(_tokens()))
        .where(Run.run_kind == "PRODUCTION", Run.created_at > since, Run.created_at <= now)
        .group_by(Run.project_id, Run.job_id, index)
    )).all()
    per_project: dict[str, dict[int, int]] = defaultdict(lambda: defaultdict(int))
    latest_by_job: dict[str, dict] = defaultdict(dict)
    for project_id, job_id, w, total in rows:
        per_project[project_id][int(w)] += int(total)
        if int(w) == 0:
            latest_by_job[project_id][job_id] = int(total)
    raised: list[Alert] = []
    for project_id, windows in per_project.items():
        points = [(now - (w + 0.5) * window, t) for w, t in windows.items()]
        verdict = detect_token_burst(points, now, BURST_WINDOW_MINUTES, BURST_FACTOR, BURST_BASELINE_WINDOWS)
        if not verdict.is_burst or verdict.latest_tokens < MIN_BURST_TOKENS:
            continue
        if await _alerted(session, project_id, "TOKEN_BURST", now - SUPPRESS):
            continue
        top_job_id, top_tokens = max(latest_by_job[project_id].items(), key=lambda kv: kv[1])
        job = await session.get(Job, top_job_id)
        usual = round(verdict.baseline_tokens)
        alert = await raise_alert(
            session, job, "TOKEN_BURST", f"TOKEN_BURST|{now:%Y-%m-%dT%H}",
            {"tokens_last_hour": verdict.latest_tokens, "usual_tokens_per_hour": usual,
             "top_job": job.name, "top_job_tokens": top_tokens,
             "summary": f"Your AI calls used {verdict.latest_tokens:,} tokens in the last hour, against about "
                        f"{usual:,} in a usual hour. The AI task that used the most was {job.name} "
                        f"({top_tokens:,} tokens)."},
            now=now)
        if alert:
            raised.append(alert)
    await session.commit()
    return raised


# ---------------------------------------------------------------- monthly budget

def month_bounds(now: datetime) -> tuple[datetime, datetime]:
    start = now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
    return start, start + timedelta(days=calendar.monthrange(now.year, now.month)[1])


async def _spend(session: AsyncSession, project_id: str, start: datetime, end: datetime) -> Decimal:
    """Priced spend of the app's own calls (re-test calls are ours, counted by the trial cap) in [start, end). Unpriced runs (cost NULL) are not counted, never treated as free."""
    return Decimal((await session.execute(
        select(func.coalesce(func.sum(Run.cost_usd), 0))
        .where(Run.project_id == project_id, Run.run_kind != "RETEST", Run.cost_usd.is_not(None),
               Run.created_at >= start, Run.created_at < end)
    )).scalar_one())


async def _projected(
    session: AsyncSession, project_id: str, spent: Decimal, now: datetime, end: datetime
) -> Decimal | None:
    """Spent so far plus the last 7 full UTC days' average per day for each remaining day; None without 7 days of data."""
    today = now.replace(hour=0, minute=0, second=0, microsecond=0)
    first = (await session.execute(
        select(func.min(Run.created_at)).where(Run.project_id == project_id, Run.run_kind != "RETEST",
                                               Run.cost_usd.is_not(None))
    )).scalar_one()
    if first is None or first > today - timedelta(days=PROJECTION_DAYS):
        return None  # under 7 days of data: no forecast (our choice, after AWS's no-forecast-on-short-history rule)
    week = await _spend(session, project_id, today - timedelta(days=PROJECTION_DAYS), today)
    remaining_days = Decimal(str((end - now).total_seconds() / 86400))
    return spent + week / PROJECTION_DAYS * remaining_days


async def check_budgets(session: AsyncSession, *, now: datetime | None = None) -> list[Alert]:
    """Soft alerts only. The highest of 85%/95% crossed fires once per level per month; a projected-over
    alert fires once per month. The job runs daily, so no kind repeats within 24 hours except a higher level."""
    now = now or datetime.now(UTC)
    start, end = month_bounds(now)
    month = f"{now:%Y-%m}"
    raised: list[Alert] = []
    projects = (await session.execute(select(Project).where(Project.monthly_budget_usd.is_not(None)))).scalars().all()
    for project in projects:
        budget = Decimal(project.monthly_budget_usd)
        spent = await _spend(session, project.project_id, start, now + timedelta(microseconds=1))
        top = (await session.execute(
            select(Run.job_id).where(Run.project_id == project.project_id, Run.run_kind != "RETEST",
                                     Run.cost_usd.is_not(None), Run.created_at >= start)
            .group_by(Run.job_id).order_by(func.sum(Run.cost_usd).desc()).limit(1)
        )).scalar_one_or_none()
        if top is None:
            continue  # no priced spend this month, nothing to say
        job = await session.get(Job, top)
        percent = spent / budget * 100
        crossed = [lv for lv in BUDGET_LEVELS if percent >= lv]
        if crossed:
            level = max(crossed)
            key = f"BUDGET|{level}|{month}"  # once per level per month, whether or not it was resolved
            if not await _alerted(session, project.project_id, "BUDGET", start, key):
                alert = await raise_alert(
                    session, job, "BUDGET", key,
                    {"level": str(level), "month": month, "budget_usd": float(budget), "spent_usd": float(spent),
                     "summary": f"You have used {float(percent):.0f}% of your ${float(budget):,.2f} monthly AI "
                                f"budget (${float(spent):,.2f} so far this month). Nothing is blocked; this is "
                                f"a heads-up, and provider cost data can lag a little."},
                    now=now)
                if alert:
                    raised.append(alert)
        projected = await _projected(session, project.project_id, spent, now, end)
        if projected is not None and projected > budget:
            key = f"BUDGET|PROJECTED|{month}"
            if not await _alerted(session, project.project_id, "BUDGET", start, key):  # once a month
                alert = await raise_alert(
                    session, job, "BUDGET", key,
                    {"level": "PROJECTED", "month": month, "budget_usd": float(budget), "spent_usd": float(spent),
                     "projected_usd": float(projected),
                     "summary": f"At the pace of the last {PROJECTION_DAYS} days, this month's AI spend is "
                                f"heading for about ${float(projected):,.2f}, over your ${float(budget):,.2f} "
                                f"budget (${float(spent):,.2f} so far). Nothing is blocked."},
                    now=now)
                if alert:
                    raised.append(alert)
    await session.commit()
    return raised


# ---------------------------------------------------------------- trial budget

async def check_trial_budgets(session: AsyncSession, *, now: datetime | None = None) -> list[Alert]:
    """TRIAL_BUDGET: the monthly budget for trials on a new model (projects.retest_monthly_cap_usd, spent
    as RETEST runs, see retest.runner.spent_this_month) is 85% or 95% used. Once per level per month."""
    from ..retest.runner import month_start, spent_this_month
    now = now or datetime.now(UTC)
    start = month_start(now)
    month = f"{now:%Y-%m}"
    raised: list[Alert] = []
    for project in (await session.execute(select(Project).where(Project.retest_monthly_cap_usd > 0))).scalars():
        cap = Decimal(project.retest_monthly_cap_usd)
        spent = await spent_this_month(session, project.project_id, now)
        crossed = [lv for lv in BUDGET_LEVELS if spent / cap * 100 >= lv]
        if not crossed:
            continue
        level = max(crossed)
        key = f"TRIAL_BUDGET|{level}|{month}"
        if await _alerted(session, project.project_id, "TRIAL_BUDGET", start, key):
            continue
        job = (await session.execute(
            select(Job).join(Run, Run.job_id == Job.job_id)
            .where(Run.project_id == project.project_id, Run.run_kind == "RETEST", Run.created_at >= start)
            .group_by(Job.job_id).order_by(func.sum(Run.cost_usd).desc().nulls_last()).limit(1))).scalar_one_or_none()
        if job is None:
            continue
        alert = await raise_alert(
            session, job, "TRIAL_BUDGET", key,
            {"level": str(level), "month": month, "cap_usd": float(cap), "spent_usd": float(spent),
             "summary": f"You have used {float(spent / cap * 100):.0f}% of this month's ${float(cap):,.2f} budget "
                        f"for trials on a new model (${float(spent):,.2f} so far). Trials stop when it is used up; "
                        f"you can raise it in Settings."},
            now=now)
        if alert:
            raised.append(alert)
    await session.commit()
    return raised


# ---------------------------------------------------------------- model retirement

def _day(d: date) -> str:
    return f"{d:%d %b %Y}"


async def check_retirements(session: AsyncSession, *, now: datetime | None = None) -> list[Alert]:
    """MODEL_RETIRING for a project when a model it ran in the last 30 days is retired or has a shutdown
    date within 60 days; once per model and shutdown date. Dates read "not before": Google's table dates
    are "the earliest possible" and providers differ, so we never promise a date. The catalog stores no
    replacement model, so none is named."""
    now = now or datetime.now(UTC)
    today = now.date()
    rows = (await session.execute(
        select(Run.project_id, Run.job_id, Run.model, Run.provider, func.count())
        .where(Run.run_kind == "PRODUCTION", Run.created_at >= now - timedelta(days=RECENT_USE_DAYS))
        .group_by(Run.project_id, Run.job_id, Run.model, Run.provider)
    )).all()
    uses: dict[tuple[str, str], dict] = defaultdict(lambda: {"jobs": defaultdict(int), "providers": []})
    for project_id, job_id, model, provider, n in rows:
        entry = uses[(project_id, normalize(split_option(model)[0]))]
        entry["jobs"][job_id] += n
        entry["providers"] += [provider] * n
    raised: list[Alert] = []
    for (project_id, name), entry in uses.items():
        life = (await lifecycles(session, {name: most_used(entry["providers"])}, today=today))[name]
        soon = life.shutdown_date is not None and life.shutdown_date <= today + timedelta(days=RETIRING_WITHIN_DAYS)
        if not (life.status == "RETIRED" or (life.status == "DEPRECATED" and soon)):
            continue
        when = life.shutdown_date.isoformat() if life.shutdown_date else "retired"
        key = f"MODEL_RETIRING|{name}|{when}"
        if await _alerted(session, project_id, "MODEL_RETIRING", None, key):
            continue
        job = await session.get(Job, max(entry["jobs"], key=entry["jobs"].get))
        if life.status == "RETIRED":
            text = (f"{name} has been retired by its provider"
                    + (f" (shutdown date: {_day(life.shutdown_date)})" if life.shutdown_date else "")
                    + f". Your AI task {job.name} ran it in the last {RECENT_USE_DAYS} days. "
                      "Check your provider's notice and plan a move to another model.")
        else:
            text = (f"{name} is being retired, not before {_day(life.shutdown_date)}. Your AI task {job.name} "
                    f"ran it in the last {RECENT_USE_DAYS} days. Check your provider's notice for the exact date.")
        alert = await raise_alert(
            session, job, "MODEL_RETIRING", key,
            {"model": name, "status": life.status,
             "shutdown_date": life.shutdown_date.isoformat() if life.shutdown_date else None,
             "date_is_earliest_possible": True, "summary": text}, now=now)
        if alert:
            raised.append(alert)
    await session.commit()
    return raised
