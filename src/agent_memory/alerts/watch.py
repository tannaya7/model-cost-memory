"""Scheduled watchers that raise project-level alerts: token bursts, monthly budget, model retirement.

Alerts hang off a job (alerts.job_id), so each one is attached to the job that explains it: the job that
used the most tokens in a burst, spent the most this month, or ran the retiring model. Every watcher
only raises alerts; none of them blocks, throttles or changes anything. Wording is plain and carries
figures only, never prompt text.

Constants marked "our choice" are not from a provider or a vendor doc; they are judgements to tune.
"""

from __future__ import annotations

from collections import defaultdict
from datetime import UTC, date, datetime, timedelta
from decimal import Decimal

from sqlalchemy import Float, cast, func, literal, select
from sqlalchemy.ext.asyncio import AsyncSession

from ..catalog.lifecycle import lifecycles, most_used
from ..models import Alert, Job, ModelNotice, NoticeSource, Project, Run
from ..insights.projection import WINDOW_DAYS, month_projection
from ..options import split_option
from ..versions import normalize
from .burst import detect_token_burst
from .service import raise_alert

# Token burst. Every number here is our choice: the research verified only that a heads-up with a volume
# floor is wanted, not the values.
BURST_WINDOW_MINUTES = 60  # the measurement window: one hour of recorded calls
BURST_BASELINE_WINDOWS = 24  # compared with the average hour of the 24 hours before it
BURST_FACTOR = 3.0  # the latest hour must be more than 3x the usual hour
MIN_BURST_TOKENS = 50_000  # the volume floor: an hour under this many tokens is never reported, however quiet before
# A usage heads-up, not a forecast of provider throttling. It sees hour-long totals of the calls this app recorded. It
# cannot see a provider's rate limits or the second-by-second token bucket a provider may apply, and no provider signal
# is read here, so a short spike that a provider limits is not something it promises to notice.
BURST_RULE = (f"A usage heads-up: the last {BURST_WINDOW_MINUTES} minutes of recorded calls used more than {BURST_FACTOR:g}x the "
              f"average hour of the {BURST_BASELINE_WINDOWS} hours before, and at least {MIN_BURST_TOKENS:,} tokens. "
              "It is not a prediction that your provider will limit you.")
SUPPRESS = timedelta(hours=24)  # LiteLLM's budget-alert TTL is 86,400 s; we use 24 hours for all three kinds

# Budget. 85% and 95% of actual spend with 24-hour dedupe is LiteLLM's documented behaviour.
BUDGET_LEVELS = (85, 95)
# The forecast rules (7 full days, at least 5 with spend, paused after 48 hours of silence) live in insights/projection.py.

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
             "window_minutes": BURST_WINDOW_MINUTES, "baseline_windows": BURST_BASELINE_WINDOWS,
             "factor": BURST_FACTOR, "floor_tokens": MIN_BURST_TOKENS, "heads_up": True,
             "summary": f"Usage heads-up: your AI calls used {verdict.latest_tokens:,} tokens in the last hour, against "
                        f"about {usual:,} in a usual hour (the average of the 24 hours before). The AI task that used "
                        f"the most was {job.name} ({top_tokens:,} tokens). This compares your own recorded usage; it is "
                        f"not a prediction that your provider will limit you, and it cannot see short provider-side limits."},
            now=now)
        if alert:
            raised.append(alert)
    await session.commit()
    return raised


# ---------------------------------------------------------------- monthly budget

async def _unpriced(session: AsyncSession, project_id: str, start: datetime, end: datetime) -> int:
    """Production calls this month whose cost is unknown: they are in no spend figure, and a budget alert says so."""
    return int((await session.execute(
        select(func.count(Run.run_id))
        .where(Run.project_id == project_id, Run.run_kind == "PRODUCTION", Run.cost_usd.is_(None),
               Run.created_at >= start, Run.created_at < end)
    )).scalar_one())


def basis_note(unpriced: int, mode: str = "per_use") -> str:
    """How a budget figure was worked out, in a sentence the alert carries (so a figure is never read as the bill).
    For a project that pays per use AND by subscription, the figure also covers calls the subscription pays for."""
    gap = (f" {unpriced:,} call{'s' if unpriced != 1 else ''} with no known price {'are' if unpriced != 1 else 'is'} "
           "not counted.") if unpriced else ""
    mixed = (" It includes calls a subscription may cover, at list price, so it can be higher than what you are "
             "billed per use.") if mode == "both" else ""
    return f" This is an estimate from recorded calls at public list prices, not your bill.{mixed}{gap}"


def _money(x: Decimal | float) -> str:
    return f"${float(x):,.2f}"


async def check_budgets(session: AsyncSession, *, now: datetime | None = None) -> list[Alert]:
    """Soft alerts only: nothing is ever blocked, throttled or changed. Two separate kinds of alert:

    ACTUAL  one per threshold the owner chose (default 85% and 95%) of the budget, when spend that has already happened
            crosses it. The highest threshold crossed fires once per month for that budget; a higher one fires later.
    PROJECTED  a forecast, not a fact: raised once a month when even the LOW end of the forecast range is above the
            budget, and only if the owner left that warning on. No forecast is made on a short or sparse history.

    The month and its days are in the project's own timezone. A change of budget starts fresh (the budget is part of
    the dedupe key). Subscription projects have no dollar alerts. Alerts always appear in the app; where they are also
    sent is decided by the owner (notifier.deliver_pending)."""
    now = now or datetime.now(UTC)
    raised: list[Alert] = []
    projects = (await session.execute(select(Project).where(
        Project.monthly_budget_usd.is_not(None), Project.billing_mode != "subscription"))).scalars().all()
    # A subscription pays a flat fee, so a dollar spending limit means nothing there: the limit is kept, no alert fires.
    for project in projects:
        budget = Decimal(project.monthly_budget_usd)
        proj = await month_projection(session, project, now)
        start = proj.period_start
        spent = proj.actual_usd
        top = (await session.execute(
            select(Run.job_id).where(Run.project_id == project.project_id, Run.run_kind == "PRODUCTION",
                                     Run.cost_usd.is_not(None), Run.created_at >= start, Run.created_at <= now)
            .group_by(Run.job_id).order_by(func.sum(Run.cost_usd).desc()).limit(1)
        )).scalar_one_or_none()
        if top is None:
            continue  # no priced spend this month, nothing to say
        job = await session.get(Job, top)
        percent = spent / budget * 100
        note = basis_note(proj.unpriced_runs, project.billing_mode or "per_use")
        where = f"in {proj.month} ({proj.timezone})"
        levels = sorted(project.budget_alert_levels if project.budget_alert_levels is not None else BUDGET_LEVELS)
        crossed = [lv for lv in levels if percent >= lv]
        stamp = f"{budget:f}"  # a new budget re-arms the thresholds
        if crossed:
            level = max(crossed)
            key = f"BUDGET|{level}|{proj.month}|{stamp}"  # once per level per month and budget, resolved or not
            if not await _alerted(session, project.project_id, "BUDGET", start, key):
                alert = await raise_alert(
                    session, job, "BUDGET", key,
                    {"level": str(level), "kind": "actual", "month": proj.month, "timezone": proj.timezone,
                     "budget_usd": float(budget), "spent_usd": float(spent), "currency": proj.currency,
                     "unpriced_runs": proj.unpriced_runs,
                     "summary": f"You have used {int(percent)}% of your {_money(budget)} monthly AI budget "
                                f"({_money(spent)} spent so far {where}). This is spend that has already happened. "
                                f"Nothing is blocked; this is a heads-up, and the newest calls may not be counted "
                                f"yet.{note}"},
                    now=now)
                if alert:
                    raised.append(alert)
        if project.budget_alert_projected is not False and proj.state == "ok" and proj.vs_budget == "over":
            key = f"BUDGET|PROJECTED|{proj.month}|{stamp}"
            if not await _alerted(session, project.project_id, "BUDGET", start, key):  # once a month
                alert = await raise_alert(
                    session, job, "BUDGET", key,
                    {"level": "PROJECTED", "kind": "projected", "month": proj.month, "timezone": proj.timezone,
                     "budget_usd": float(budget), "spent_usd": float(spent), "currency": proj.currency,
                     "projected_usd": float(proj.projected_likely_usd),
                     "projected_low_usd": float(proj.projected_low_usd), "projected_high_usd": float(proj.projected_high_usd),
                     "unpriced_runs": proj.unpriced_runs,
                     "summary": f"This is a forecast, not spend that has happened. At the pace of the last "
                                f"{WINDOW_DAYS} full days, {proj.month} ({proj.timezone}) is heading for "
                                f"{_money(proj.projected_low_usd)} to {_money(proj.projected_high_usd)} (likely "
                                f"{_money(proj.projected_likely_usd)}), even the low end over your {_money(budget)} budget "
                                f"({_money(spent)} spent so far). Nothing is blocked.{note}"},
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


async def _has_official_notice(session: AsyncSession, model: str) -> bool:
    """Is there a listed notice for this exact model on a provider page that has been read successfully?"""
    return (await session.execute(
        select(ModelNotice.notice_id).join(NoticeSource, NoticeSource.source_id == ModelNotice.source_id)
        .where(ModelNotice.model == model, ModelNotice.listed.is_(True), NoticeSource.last_ok_at.is_not(None)).limit(1)
    )).first() is not None


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
        if await _has_official_notice(session, name):
            continue  # the provider's own page says something about it: that notice is the one to read
        when = life.shutdown_date.isoformat() if life.shutdown_date else "retired"
        key = f"MODEL_RETIRING|{name}|{when}"
        if await _alerted(session, project_id, "MODEL_RETIRING", None, key):
            continue
        job = await session.get(Job, max(entry["jobs"], key=entry["jobs"].get))
        if life.status == "RETIRED":
            text = (f"{name} has been retired by its provider"
                    + (f" (shutdown date: {_day(life.shutdown_date)})" if life.shutdown_date else "")
                    + f". Your AI task {job.name} ran it in the last {RECENT_USE_DAYS} days. "
                      "This comes from a public price list (a third-party list, not the provider's own notice): "
                      "check your provider's own page. Nothing is changed for you.")
        else:
            text = (f"{name} is being retired, not before {_day(life.shutdown_date)}. Your AI task {job.name} "
                    f"ran it in the last {RECENT_USE_DAYS} days. This comes from a public price list (a third-party list, "
                    "not the provider's own notice): check your provider's own page for the exact date. Nothing is changed for you.")
        alert = await raise_alert(
            session, job, "MODEL_RETIRING", key,
            {"model": name, "status": life.status,
             "shutdown_date": life.shutdown_date.isoformat() if life.shutdown_date else None,
             "date_is_earliest_possible": True, "summary": text}, now=now)
        if alert:
            raised.append(alert)
    await session.commit()
    return raised
