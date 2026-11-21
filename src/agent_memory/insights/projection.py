"""The month-end spend forecast: actual spend and the projection are kept apart, and the projection says when it
will not make one.

One function builds it, so the budget alerts and the web app can never disagree.

Rules (all visible to the user as `RULE`):
  - Spend is the list-price cost of PRODUCTION calls this app recorded, in US dollars. Calls with no known price are
    counted separately (`unpriced_runs`) and are in no sum.
  - The month is the calendar month in the project's timezone (default UTC), from its first moment to the first
    moment of the next month. A day is a calendar day in that timezone.
  - The forecast is the spend so far plus, for each day still to come (the rest of today included, as a fraction),
    the spend per day over the last 7 FULL days. The range uses the lowest and the highest of those 7 days; the
    "likely" figure uses their mean. It is a plain empirical range, not a statistical interval.
  - There is no forecast (state "not_enough_history") until 7 full days have passed since the first priced call,
    and then only if at least 5 of the last 7 full days had priced spend (a sparse history makes the pace unreliable).
  - The forecast is paused (state "paused") while no call at all has been recorded for 48 hours: the recent pace would
    be wrong and the app would be guessing.
  - A "projected over budget" warning needs the LOW end of the range to be above the budget.

Nothing here blocks, throttles or changes anything.
"""

from __future__ import annotations

import calendar
from dataclasses import dataclass, field
from datetime import UTC, date, datetime, time, timedelta
from decimal import Decimal
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError, available_timezones

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from ..models import Project, Run

CURRENCY = "USD"
WINDOW_DAYS = 7  # full days whose pace the forecast uses
MIN_HISTORY_DAYS = 7  # full days since the first priced call before any forecast
MIN_ACTIVE_DAYS = 5  # of the last 7 full days, at least this many need priced spend
STALE_AFTER = timedelta(hours=48)  # no recorded call at all for this long: the forecast is paused

RULE = (
    "Forecast = spend so far this month + the spend per day over the last 7 full days, for each day left. "
    "The range uses your lowest and highest of those 7 days. There is no forecast until 7 full days have passed since "
    "your first priced call, and it needs priced spend on at least 5 of the last 7 days. It pauses if no call has been "
    "recorded for 48 hours. A projected-over warning needs even the low end of the range to be above your budget."
)
DATA_NOTE = (
    "Spend is counted from calls this app has recorded, at public list prices. A call counts once your app has sent it, "
    "so the newest calls, and any delay on your provider's own billing, can be missing. Budget alerts are checked every hour."
)


def zone(name: str | None) -> ZoneInfo:
    """The named IANA timezone, or UTC when it is missing or unknown."""
    try:
        return ZoneInfo(name or "UTC")
    except (ZoneInfoNotFoundError, ValueError, OSError):
        return ZoneInfo("UTC")


def is_timezone(name: str) -> bool:
    return name in available_timezones()


@dataclass
class MonthWindow:
    start: datetime  # first instant of the month, UTC
    end: datetime  # first instant of the next month, UTC
    first_day: date  # local calendar dates
    last_day: date
    days_in_month: int
    day_of_month: int  # today, local
    today: date
    label: str  # "2028-02"


def month_window(now: datetime, tz: ZoneInfo) -> MonthWindow:
    """The calendar month `now` falls in, in `tz`: its first instant, the first instant of the next month (both as UTC)
    and the local dates. Leap years and months of 28 to 31 days come from the calendar."""
    local = now.astimezone(tz)
    y, m = local.year, local.month
    days = calendar.monthrange(y, m)[1]
    ny, nm = (y + 1, 1) if m == 12 else (y, m + 1)
    start = datetime(y, m, 1, tzinfo=tz).astimezone(UTC)
    end = datetime(ny, nm, 1, tzinfo=tz).astimezone(UTC)
    return MonthWindow(start=start, end=end, first_day=date(y, m, 1), last_day=date(y, m, days), days_in_month=days,
                       day_of_month=local.day, today=local.date(), label=f"{y:04d}-{m:02d}")


def day_bounds(day: date, tz: ZoneInfo) -> tuple[datetime, datetime]:
    """[start, end) of a local calendar day, as UTC instants (a day with a clock change is 23 or 25 hours long)."""
    start = datetime.combine(day, time(0), tzinfo=tz).astimezone(UTC)
    end = datetime.combine(day + timedelta(days=1), time(0), tzinfo=tz).astimezone(UTC)
    return start, end


@dataclass
class Projection:
    state: str  # "ok" | "not_enough_history" | "paused" | "no_spend"
    reason: str | None  # why there is no forecast: "too_new" | "sparse" | "no_recent_calls"
    currency: str
    timezone: str
    month: str
    period_start: datetime
    period_end: datetime
    first_day: date
    last_day: date
    days_in_month: int
    day_of_month: int
    days_left: float
    actual_usd: Decimal  # what has been spent so far: a fact about recorded calls
    unpriced_runs: int  # calls this month with no known cost: in no figure
    projected_low_usd: Decimal | None = None  # a forecast: kept apart from actual_usd
    projected_likely_usd: Decimal | None = None
    projected_high_usd: Decimal | None = None
    history_days: int = 0  # full days since the first priced call
    active_days: int = 0  # of the last 7 full days, those with priced spend
    recent_days: list[tuple[date, Decimal]] = field(default_factory=list)
    data_through: datetime | None = None  # when the newest call was recorded
    budget_usd: Decimal | None = None
    used_share: float | None = None  # actual / budget
    vs_budget: str | None = None  # "over" (even the low end is above) | "may_go_over" | "under"
    rule: str = RULE
    data_note: str = DATA_NOTE


def build_projection(
    *, now: datetime, tz_name: str | None, month_spend: Decimal, unpriced_runs: int, daily_spend: dict[date, Decimal],
    first_priced_day: date | None, newest_call_at: datetime | None, budget: Decimal | None = None,
) -> Projection:
    """The projection from already-loaded figures (pure: no database, no clock). `daily_spend` maps local dates to
    priced spend; only the last 7 full days before today are read from it."""
    tz = zone(tz_name)
    win = month_window(now, tz)
    days = [win.today - timedelta(days=k) for k in range(1, WINDOW_DAYS + 1)]
    recent = [(d, daily_spend.get(d, Decimal(0))) for d in days]
    active = sum(1 for _, v in recent if v > 0)
    history = (win.today - first_priced_day).days if first_priced_day else 0
    left = max(0.0, (win.end - now).total_seconds() / 86400)
    p = Projection(
        state="ok", reason=None, currency=CURRENCY, timezone=str(tz), month=win.label, period_start=win.start,
        period_end=win.end, first_day=win.first_day, last_day=win.last_day, days_in_month=win.days_in_month,
        day_of_month=win.day_of_month, days_left=round(left, 4), actual_usd=month_spend, unpriced_runs=unpriced_runs,
        history_days=history, active_days=active, recent_days=recent, data_through=newest_call_at, budget_usd=budget,
        used_share=float(month_spend / budget) if budget else None,
    )
    if first_priced_day is None and month_spend == 0:
        p.state = "no_spend"
        return p
    if first_priced_day is None or history < MIN_HISTORY_DAYS:
        p.state, p.reason = "not_enough_history", "too_new"
        return p
    if newest_call_at is not None and now - newest_call_at > STALE_AFTER:
        p.state, p.reason = "paused", "no_recent_calls"
        return p
    if active < MIN_ACTIVE_DAYS:
        p.state, p.reason = "not_enough_history", "sparse"
        return p
    values = [v for _, v in recent]
    rate_low, rate_high = min(values), max(values)
    rate_mean = sum(values, Decimal(0)) / Decimal(WINDOW_DAYS)
    gap = Decimal(str(left))
    p.projected_low_usd = (month_spend + rate_low * gap).quantize(Decimal("0.01"))
    p.projected_likely_usd = (month_spend + rate_mean * gap).quantize(Decimal("0.01"))
    p.projected_high_usd = (month_spend + rate_high * gap).quantize(Decimal("0.01"))
    if budget:
        p.vs_budget = ("over" if p.projected_low_usd > budget
                       else "may_go_over" if p.projected_high_usd > budget else "under")
    return p


async def month_projection(session: AsyncSession, project: Project, now: datetime | None = None) -> Projection:
    """Load a project's figures and build its projection. Production calls only; the same runs the Overview counts."""
    now = now or datetime.now(UTC)
    tz = zone(project.budget_timezone)
    win = month_window(now, tz)
    scope = (Run.project_id == project.project_id, Run.run_kind == "PRODUCTION")

    month_spend = Decimal((await session.execute(
        select(func.coalesce(func.sum(Run.cost_usd), 0))
        .where(*scope, Run.cost_usd.is_not(None), Run.created_at >= win.start, Run.created_at <= now))).scalar_one())
    unpriced = int((await session.execute(
        select(func.count(Run.run_id)).where(*scope, Run.cost_usd.is_(None), Run.created_at >= win.start,
                                             Run.created_at <= now))).scalar_one())

    # One sum per local day, over exact UTC instants worked out here (so a day with a clock change is 23 or 25 hours
    # long, and the database needs no timezone data of its own).
    days = [win.today - timedelta(days=k) for k in range(1, WINDOW_DAYS + 1)]
    bounds = [day_bounds(d, tz) for d in days]
    sums = (await session.execute(
        select(*[func.coalesce(func.sum(Run.cost_usd).filter(Run.created_at >= lo, Run.created_at < hi), 0)
                 for lo, hi in bounds])
        .where(*scope, Run.cost_usd.is_not(None), Run.created_at >= bounds[-1][0], Run.created_at < bounds[0][1])
    )).one()
    daily = {d: Decimal(s) for d, s in zip(days, sums, strict=True)}
    first = (await session.execute(select(func.min(Run.created_at)).where(*scope, Run.cost_usd.is_not(None)))).scalar_one()
    newest = (await session.execute(select(func.max(Run.created_at)).where(*scope))).scalar_one()
    return build_projection(
        now=now, tz_name=project.budget_timezone, month_spend=month_spend, unpriced_runs=unpriced, daily_spend=daily,
        first_priced_day=first.astimezone(tz).date() if first else None, newest_call_at=newest,
        budget=Decimal(project.monthly_budget_usd) if project.monthly_budget_usd is not None else None)
