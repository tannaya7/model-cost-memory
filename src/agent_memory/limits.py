"""Usage limits: will a limit run out before it resets, and what to change if it will.

Plans and providers cap use per window: a 5-hour session, a 7-day week, a day's request quota, sometimes
for one model only. A project records the limits it works under (`UsageLimit`). For each one this
module works out, from the project's recorded runs:

- the current window (each ends at `resets_at`, and the next ones follow every `window_hours`);
- how much of it is used, in the limit's own measure: list-price dollars, tokens, or requests. A plan
  that only shows a percentage (PERCENT) is calibrated from the user's report ("80% used at 10:02"):
  the dollars recorded before the report, divided by the share reported, give the size of the whole
  limit, so later runs can be counted against it. That assumes the plan's use went through recorded
  runs; use outside them is not seen;
- the pace: use over the last seventh of a window (a day of a week, about 40 minutes of a 5-hour
  session), or over the elapsed part when less has passed;
- whether, at that pace, it is used up before it resets, and for how long the user would be stuck.

When it would run out, each job using the limit gets a suggestion from the engine's own verdict, so
only options shown to still do that job are named:

- a limit on one model: move the job to the cheapest other option the engine judges good enough (95%
  sure it is within the margin of the best). Its use then leaves this limit entirely, even if it costs
  more elsewhere;
- any other limit: the cheaper option the engine advises moving to (99% sure it is within the margin of
  the model in use). When none is proven, the suggestion says which re-test would tell. A request
  count is not reduced by a cheaper model, so an unscoped request limit gets no model suggestion.

The forecast then says whether following the suggestions makes the limit last until it resets.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta

from sqlalchemy import func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from .config import Settings, get_settings
from .models import Job, Run, UsageLimit
from .options import option_name
from .pipeline.decay import family_key
from .recommend.engine import recommend
from .versions import normalize

LOOKBACK_SHARE = 1 / 7
SUGGEST_FOR_JOBS = 5  # the jobs that use the limit most
OPTION_HISTORY = timedelta(days=30)  # what an option's use per run is averaged over


@dataclass
class Suggestion:
    job: str
    current: str
    suggested: str | None  # None: nothing proven to switch to yet
    share_of_use: float  # of this limit's recent use
    reduction: float  # the share of this job's use the switch saves (1.0: it leaves a one-model limit)
    note: str


@dataclass
class LimitForecast:
    limit: UsageLimit
    window_start: datetime
    resets_at: datetime
    used: float | None  # in the measure's unit (dollars for PERCENT, after calibration)
    size: float | None
    rate_per_hour: float
    hours_to_reset: float
    hours_to_full: float | None  # None: not used up at this pace (no use, or unknown)
    state: str  # OK, AT_RISK, EXHAUSTED, UNKNOWN
    message: str
    suggestions: list[Suggestion] = field(default_factory=list)
    hours_to_full_after: float | None = None  # if every proven suggestion is followed
    lasts_after: bool | None = None

    @property
    def share_used(self) -> float | None:
        return self.used / self.size if self.used is not None and self.size else None


def current_window(limit: UsageLimit, now: datetime) -> tuple[datetime, datetime]:
    """(start, end) of the window `now` falls in."""
    width = timedelta(hours=limit.window_hours)
    end = limit.resets_at
    if end <= now:
        end += width * (math.floor((now - end) / width) + 1)
    return end - width, end


def _amount(measure: str):
    if measure == "TOKENS":
        return func.coalesce(func.sum(Run.tokens_in + Run.tokens_out + Run.cache_read_tokens + Run.cache_write_tokens), 0)
    if measure == "REQUESTS":
        return func.count()
    return func.coalesce(func.sum(Run.cost_usd), 0)  # USD, and PERCENT measured in list-price dollars


def _in_scope(limit: UsageLimit):
    conditions = [Run.project_id == limit.project_id]
    if limit.model:
        scope = normalize(limit.model)
        conditions.append(or_(func.lower(Run.model).like(f"{scope}%"), func.lower(Run.model_version).like(f"{scope}%")))
    return conditions


async def _use(session: AsyncSession, limit: UsageLimit, since: datetime, until: datetime) -> float:
    return float((await session.execute(
        select(_amount(limit.measure)).select_from(Run)
        .where(*_in_scope(limit), Run.created_at > since, Run.created_at <= until)
    )).scalar_one())


def _hours(delta: timedelta) -> float:
    return delta.total_seconds() / 3600


def say_hours(hours: float) -> str:
    if hours < 1:
        return f"{max(round(hours * 60), 1)} min"
    if hours < 48:
        return f"{hours:.0f} h"
    return f"{hours / 24:.1f} days"


async def _option_use_per_run(session: AsyncSession, limit: UsageLimit, job: Job, now: datetime) -> dict[str, float]:
    """Each option's average use of this limit's measure per run, for one job, over the last 30 days."""
    rows = (await session.execute(
        select(Run.model, Run.model_version, Run.effort, _amount(limit.measure), func.count())
        .where(Run.job_id == job.job_id, Run.created_at > now - OPTION_HISTORY, Run.created_at <= now)
        .group_by(Run.model, Run.model_version, Run.effort)
    )).all()
    totals: dict[str, list[float]] = {}
    for model, version, effort, amount, n in rows:
        t = totals.setdefault(option_name(family_key(model, version), effort), [0.0, 0])
        t[0] += float(amount)
        t[1] += n
    return {name: amount / n for name, (amount, n) in totals.items() if n}


async def _suggest(session: AsyncSession, limit: UsageLimit, now: datetime, since: datetime,
                   settings: Settings) -> tuple[list[Suggestion], dict[str, float]]:
    """Suggestions for the jobs that use the limit most, and each job's use over the pace window."""
    by_job = (await session.execute(
        select(Run.job_id, _amount(limit.measure)).where(*_in_scope(limit), Run.created_at > since,
                                                          Run.created_at <= now)
        .group_by(Run.job_id).order_by(_amount(limit.measure).desc()).limit(SUGGEST_FOR_JOBS)
    )).all()
    total = sum(float(use) for _, use in by_job) or 1.0
    scope = normalize(limit.model) if limit.model else None
    suggestions: list[Suggestion] = []
    use_by_job: dict[str, float] = {}
    for job_id, use in by_job:
        job = await session.get(Job, job_id)
        decision = (await recommend(session, job, now=now, settings=settings)).decision
        current = decision.current
        if current is None:
            continue
        use_by_job[job.name] = float(use)
        share = float(use) / total
        if scope:
            others = [m for m in decision.models if m.eligible and not normalize(m.model).startswith(scope)]
            if others:
                pick = min(others, key=lambda m: m.cost_per_success_usd)
                note = (f"{pick.model} does this job well enough (within {settings.tolerance_points * 100:g} points "
                        f"of the best) and does not count against this limit")
                suggestions.append(Suggestion(job.name, current.model, pick.model, share, 1.0, note))
            else:
                suggestions.append(Suggestion(job.name, current.model, None, share, 0.0,
                                              "No other model is shown to do this job well enough yet"))
            continue
        if limit.measure == "REQUESTS":
            continue
        if decision.verdict == "DOWNGRADE" and decision.recommended is not None:
            per_run = await _option_use_per_run(session, limit, job, now)
            now_use, new_use = per_run.get(current.model), per_run.get(decision.recommended.model)
            reduction = max(1 - new_use / now_use, 0.0) if now_use and new_use is not None else 0.0
            note = (f"Shown within {settings.tolerance_points * 100:g} points of {current.model} at "
                    f"{max(settings.switch_confidence, settings.confidence_level):.0%} confidence; it uses "
                    f"{reduction:.0%} less of this limit per run")
            suggestions.append(Suggestion(job.name, current.model, decision.recommended.model, share, reduction, note))
        else:
            cheaper = [m for m in decision.retest_candidates if m != current.model]
            note = (f"No cheaper option is proven for this job yet; a re-test of {', '.join(cheaper)} would tell"
                    if cheaper else "No cheaper option does this job well enough")
            suggestions.append(Suggestion(job.name, current.model, None, share, 0.0, note))
    return suggestions, use_by_job


async def forecast(session: AsyncSession, limit: UsageLimit, *, now: datetime | None = None,
                   settings: Settings | None = None) -> LimitForecast:
    settings = settings or get_settings()
    now = now or datetime.now(UTC)
    start, end = current_window(limit, now)
    hours_to_reset = _hours(end - now)

    if limit.measure == "PERCENT":
        if limit.reported_used is None or limit.reported_at is None:
            return LimitForecast(limit, start, end, None, None, 0.0, hours_to_reset, None, "UNKNOWN",
                                 f"Enter how much of {limit.name} is used, as your plan shows it, to forecast it")
        r_start, _ = current_window(limit, limit.reported_at)
        before = await _use(session, limit, r_start, limit.reported_at)
        reported = float(limit.reported_used)
        if reported <= 0 or before <= 0:
            return LimitForecast(limit, start, end, None, None, 0.0, hours_to_reset, None, "UNKNOWN",
                                 f"No runs were recorded in {limit.name}'s window before your report, so its pace "
                                 "cannot be turned into a share of the limit yet")
        size = before / reported
        used = (reported * size + await _use(session, limit, limit.reported_at, now) if limit.reported_at >= start
                else await _use(session, limit, start, now))
    else:
        size, used = float(limit.size), await _use(session, limit, start, now)

    lookback = min(now - start, timedelta(hours=limit.window_hours) * LOOKBACK_SHARE)
    since = now - lookback
    rate = await _use(session, limit, since, now) / _hours(lookback) if lookback > timedelta(0) else 0.0
    remaining = size - used

    if remaining <= 0:
        state, to_full = "EXHAUSTED", 0.0
        message = f"{limit.name} is used up; it resets in {say_hours(hours_to_reset)}"
    elif rate > 0 and remaining / rate < hours_to_reset:
        state, to_full = "AT_RISK", remaining / rate
        message = (f"At this pace {limit.name} runs out in {say_hours(to_full)}, "
                   f"{say_hours(hours_to_reset - to_full)} before it resets")
    else:
        state, to_full = "OK", (remaining / rate if rate > 0 else None)
        message = f"At this pace {limit.name} lasts until it resets in {say_hours(hours_to_reset)}"
    result = LimitForecast(limit, start, end, used, size, rate, hours_to_reset, to_full, state, message)
    if state == "OK":
        return result

    suggestions, use_by_job = await _suggest(session, limit, now, since, settings)
    result.suggestions = suggestions
    if limit.measure == "REQUESTS" and not limit.model:
        result.message += ". A cheaper model does not reduce a request count: fewer or batched calls would"
        return result
    saved = sum(use_by_job.get(s.job, 0.0) * s.reduction for s in suggestions if s.suggested)
    if saved > 0 and lookback > timedelta(0) and state == "AT_RISK":
        new_rate = max(rate - saved / _hours(lookback), 0.0)
        result.hours_to_full_after = remaining / new_rate if new_rate > 0 else None
        result.lasts_after = new_rate == 0 or remaining / new_rate >= hours_to_reset
        result.message += (". With the suggested changes it lasts until the reset" if result.lasts_after
                           else f". With the suggested changes it lasts {say_hours(result.hours_to_full_after)}")
    return result
