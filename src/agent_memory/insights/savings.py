"""The savings tracker: which tasks changed model, and what the change did to cost per correct answer.

Read src/agent_memory/insights/savings_method.py first: it holds the method and says what is and is not claimed. This file finds the
change in a task's own history, gathers the calls in equal windows on each side, and applies the guards that need the database
(prices, prompt versions, cache use, how complete the data is).

Hard rules:
- Analysis only. It never changes a model or a prompt and never writes anything.
- Only production calls the app really made are used. Recommendations, "promising" labels and trials (RETEST runs) are never read.
- A change is something the person did. We detect it from which model made the calls; we never claim we caused it.
- "Realized" and "estimated avoided" are different things and are never added together.
- A flat-plan project gets tokens per correct answer (approximate), never dollars.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import UTC, date, datetime, timedelta
from decimal import Decimal
from typing import Any
from zlib import crc32

import numpy as np
from sqlalchemy import func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from ..models import Job, PriceVersion, Project, Run
from ..options import option_name
from ..pricing import resolve_price
from ..versions import family
from . import savings_method as sm

HISTORY_DAYS = 150
MAX_ROWS = 200_000
VOLUME_NOTE_RATIO = 2.0

ASSUMPTIONS = [
    "The same kinds of calls would have been made on the old model, in the same numbers.",
    "Both periods are priced with the same price table; a price change is not counted as a saving.",
    "Calls that were not checked, have no known cost, or were retried are in the figures as they were recorded.",
    "It is an observed change since you switched. Other things that changed at the same time are not separated out, "
    "except the ones listed under data notes.",
]
NOT_COUNTED = ("Recommendations, 'promising' labels and trials are never counted. Only calls your app actually made on each model are.")
UNIT_WORDS = {"usd": "US dollars at list price (not an invoice)", "tokens": "billed tokens (approximate: models count tokens differently)"}


@dataclass
class _Row:
    at: datetime
    label: str
    model: str
    model_version: str
    provider: str | None
    prompt_version: str | None
    outcome: str
    cost_usd: float | None
    tokens_in: int
    tokens_out: int
    cache_read: int
    cache_write: int
    usage_shape: str | None
    plen: int | None


def _label(model: str, model_version: str | None, effort: str | None) -> str:
    return option_name(family(model_version or model), effort)


_EXCLUDED = or_(Run.state.in_(("ARCHIVED", "INGESTION_FAILED")), Run.invalid_at.is_not(None))


async def _daily_models(session: AsyncSession, job_id, since: datetime) -> dict[date, dict[str, int]]:
    day = func.date_trunc("day", func.timezone("UTC", Run.created_at)).label("day")
    rows = (await session.execute(
        select(day, Run.model, Run.model_version, Run.effort, func.count())
        .where(Run.job_id == job_id, Run.run_kind == "PRODUCTION", Run.created_at >= since, ~_EXCLUDED)
        .group_by(day, Run.model, Run.model_version, Run.effort))).all()
    out: dict[date, dict[str, int]] = {}
    for d, model, version, effort, n in rows:
        key = d.date()
        label = _label(model, version, effort)
        out.setdefault(key, {})
        out[key][label] = out[key].get(label, 0) + int(n)
    return out


async def _fetch(session: AsyncSession, job_id, first: date, last: date) -> list[_Row]:
    lo = datetime(first.year, first.month, first.day, tzinfo=UTC)
    hi = datetime(last.year, last.month, last.day, tzinfo=UTC) + timedelta(days=1)
    rows = (await session.execute(
        select(Run.created_at, Run.model, Run.model_version, Run.provider, Run.effort, Run.prompt_version, Run.outcome,
               Run.cost_usd, Run.tokens_in, Run.tokens_out, Run.cache_read_tokens, Run.cache_write_tokens, Run.usage_shape,
               func.char_length(Run.prompt))
        .where(Run.job_id == job_id, Run.run_kind == "PRODUCTION", Run.created_at >= lo, Run.created_at < hi, ~_EXCLUDED)
        .order_by(Run.created_at).limit(MAX_ROWS))).all()
    return [_Row(r[0], _label(r[1], r[2], r[4]), r[1], r[2], r[3], r[5], r[6], None if r[7] is None else float(r[7]),
                 int(r[8] or 0), int(r[9] or 0), int(r[10] or 0), int(r[11] or 0), r[12], r[13]) for r in rows]


async def _reprice(session: AsyncSession, rows: list[_Row], at: datetime) -> np.ndarray:
    """Every call priced with ONE price table (the list prices in force at `at`). NaN where no price is known or no usage was reported."""
    cache: dict[tuple, Any] = {}
    out = np.full(len(rows), np.nan)
    for i, r in enumerate(rows):
        if r.usage_shape == "none":
            continue
        key = (r.model, r.model_version, r.provider)
        if key not in cache:
            cache[key] = (await resolve_price(session, r.model, r.model_version, r.provider, at=at)).price
        p = cache[key]
        if p is None:
            continue
        out[i] = float(
            (Decimal(r.tokens_in) * p.input_per_mtok + Decimal(r.tokens_out) * p.output_per_mtok
             + Decimal(r.cache_read) * p.cache_read_per_mtok + Decimal(r.cache_write) * p.cache_write_per_mtok) / Decimal(1_000_000))
    return out


def _tokens(rows: list[_Row]) -> np.ndarray:
    out = np.array([r.tokens_in + r.tokens_out + r.cache_read + r.cache_write for r in rows], dtype=float)
    none = np.array([r.usage_shape == "none" for r in rows], dtype=bool)
    out[none] = np.nan
    return out


async def _price_changed(session: AsyncSession, rows: list[_Row], first: date, last: date) -> bool:
    """A list price that was replaced during the periods: the same call would not cost the same at both ends."""
    models = {r.model for r in rows} | {r.model_version for r in rows}
    if not models:
        return False
    lo = datetime(first.year, first.month, first.day, tzinfo=UTC)
    hi = datetime(last.year, last.month, last.day, tzinfo=UTC) + timedelta(days=1)
    n = (await session.execute(select(func.count()).select_from(PriceVersion).where(
        PriceVersion.model.in_(models), PriceVersion.effective_to.is_not(None),
        PriceVersion.effective_to >= lo, PriceVersion.effective_to <= hi))).scalar_one()
    return n > 0


def _calls(rows: list[_Row], cost: np.ndarray) -> sm.Calls:
    checked = np.array([r.outcome in ("PASS", "FAIL") for r in rows], dtype=bool)
    passed = np.array([r.outcome == "PASS" for r in rows], dtype=bool)
    bucket = np.array([sm.bucket_of(r.plen) for r in rows], dtype=int)
    reads = sum(r.cache_read for r in rows)
    total_in = sum(r.tokens_in + r.cache_read + r.cache_write for r in rows)
    cost = np.where(checked, cost, np.nan)  # only checked calls enter cost per correct answer
    by_model: dict[str, int] = {}
    for r in rows:
        by_model[r.label] = by_model.get(r.label, 0) + 1
    return sm.Calls(cost=cost, passed=passed, bucket=bucket, checked=int(checked.sum()),
                    cache_hit_share=(reads / total_in) if total_in else None, calls_total=len(rows), by_model=by_model)


def _purity(calls: sm.Calls, label: str) -> float:
    return calls.by_model.get(label, 0) / calls.calls_total if calls.calls_total else 0.0


def _versions(rows: list[_Row]) -> set[str | None]:
    counts: dict[str | None, int] = {}
    for r in rows:
        counts[r.prompt_version] = counts.get(r.prompt_version, 0) + 1
    return {v for v, n in counts.items() if n / len(rows) >= 0.2} if rows else set()


@dataclass
class Entry:
    job: str
    from_model: str
    to_model: str
    switch_date: date
    status: str = "waiting"
    reason: str | None = None
    reasons: list[str] = field(default_factory=list)
    window: dict | None = None
    realized: dict | None = None
    estimated_avoided: dict | None = None
    data_notes: list[str] = field(default_factory=list)
    progress: dict | None = None
    coverage: dict | None = None


def _round(v: float | None, unit: str) -> float | None:
    return None if v is None else round(v, 6 if unit == "usd" else 1)


async def _entry(session: AsyncSession, job: Job, before: sm.Segment, after: sm.Segment, *, today: date, first_day: date,
                 money: bool) -> Entry:
    unit = "usd" if money else "tokens"
    entry = Entry(job=job.name, from_model=before.model, to_model=after.model, switch_date=after.start)
    win, progress = sm.choose_windows(before, after, today, first_day)
    entry.progress = progress
    if win is None:
        entry.reason = (f"Waiting for 14 comparable days on each side of the change: {progress['days_before']} before, "
                        f"{progress['days_after']} after so far.")
        return entry
    entry.window = {"days": win.days, "before": [win.before_start.isoformat(), win.before_end.isoformat()],
                    "after": [win.after_start.isoformat(), win.after_end.isoformat()]}
    first_fetch = win.longer_before_start or win.before_start
    earlier_start = win.before_start - timedelta(days=win.days)
    earlier_ok = earlier_start >= max(before.start + timedelta(days=1), first_day)
    fetch_from = min(first_fetch, earlier_start) if earlier_ok else first_fetch
    rows = await _fetch(session, job.job_id, fetch_from, win.after_end)
    after_rows = [r for r in rows if win.after_start <= r.at.date() <= win.after_end]
    before_rows = [r for r in rows if win.before_start <= r.at.date() <= win.before_end]
    longer_rows = [r for r in rows if (win.longer_before_start or win.before_start) <= r.at.date() <= win.before_end]
    earlier_rows = [r for r in rows if earlier_start <= r.at.date() < win.before_start] if earlier_ok else []

    # the same list prices for both sides, when a price changed; the billed cost otherwise
    changed = money and await _price_changed(session, rows, fetch_from, win.after_end)
    at = datetime(win.after_end.year, win.after_end.month, win.after_end.day, tzinfo=UTC) + timedelta(days=1)

    async def cost_of(group: list[_Row]) -> np.ndarray:
        if not money:
            return _tokens(group)
        if changed:
            return await _reprice(session, group, at)
        return np.array([np.nan if r.cost_usd is None else r.cost_usd for r in group], dtype=float)

    cb, ca = _calls(before_rows, await cost_of(before_rows)), _calls(after_rows, await cost_of(after_rows))
    entry.coverage = {
        "calls_before": cb.calls_total, "calls_after": ca.calls_total, "checked_before": cb.checked, "checked_after": ca.checked,
        "unchecked_before": cb.calls_total - cb.checked, "unchecked_after": ca.calls_total - ca.checked,
        "without_cost_before": int(cb.checked - cb.priced.sum()), "without_cost_after": int(ca.checked - ca.priced.sum()),
    }
    # data notes: things worth knowing that do not stop the figure
    if cb.cache_hit_share is not None and ca.cache_hit_share is not None and abs(cb.cache_hit_share - ca.cache_hit_share) >= sm.CACHE_SHIFT:
        entry.data_notes.append(f"Cache use changed: {round(cb.cache_hit_share * 100)}% of input was read from the cache before and "
                                f"{round(ca.cache_hit_share * 100)}% after, which moves cost by itself.")
    ratio = (ca.calls_total / cb.calls_total) if cb.calls_total else None
    if ratio and (ratio > VOLUME_NOTE_RATIO or ratio < 1 / VOLUME_NOTE_RATIO):
        entry.data_notes.append(f"The number of calls changed a lot ({cb.calls_total} before, {ca.calls_total} after). "
                                "Cost per correct answer is not affected by volume, but the totals are.")
    if changed:
        entry.data_notes.append("A list price changed during these periods, so both periods are priced with the same price table "
                                "(the prices in force at the end), not with what was billed.")
    if money and (cb.checked - cb.priced.sum()) + (ca.checked - ca.priced.sum()):
        entry.data_notes.append("Calls with no known cost are left out of the figures, not counted as free.")

    # guards that stop a figure
    stop: list[str] = []
    if _purity(cb, before.model) < sm.WINDOW_PURITY or _purity(ca, after.model) < sm.WINDOW_PURITY:
        stop.append("other models made more than 10% of the calls in these periods, so they do not describe one model each")
    vb, va = _versions(before_rows), _versions(after_rows)
    if (vb | va) != {None} and vb != va:
        stop.append("the prompt version changed at the same time, so the change cannot be credited to the model")

    analysis = sm.analyse(
        cb, ca, seed=crc32(f"{job.job_id}|{after.start}|{win.after_end}".encode()),
        baselines={"longer": _calls(longer_rows, await cost_of(longer_rows)) if win.longer_before_start else None,
                   "earlier": _calls(earlier_rows, await cost_of(earlier_rows)) if earlier_rows else None},
    )
    entry.data_notes.extend(analysis.notes)
    if stop or analysis.status == "not_enough_data":
        entry.status = "not_enough_data"
        entry.reasons = stop + analysis.reasons
        entry.reason = entry.reasons[0]
        return entry

    entry.status = analysis.status
    entry.reason = analysis.reason
    entry.realized = {
        "metric": "cost per correct answer", "unit": unit, "unit_words": UNIT_WORDS[unit],
        "before": _round(analysis.cpc_before, unit), "after": _round(analysis.cpc_after, unit),
        "change": _round(analysis.saving, unit), "range_low": _round(analysis.saving_low, unit),
        "range_high": _round(analysis.saving_high, unit),
        "range_note": "90% range. Positive = cheaper per correct answer than before; negative = it went up.",
        "pass_rate_before": round(analysis.pass_before, 4), "pass_rate_after": round(analysis.pass_after, 4),
        "pass_rate_change_low": round(analysis.pass_diff_low, 4), "pass_rate_change_high": round(analysis.pass_diff_high, 4),
        "checked_before": analysis.checked_before, "checked_after": analysis.checked_after,
        "correct_before": analysis.correct_before, "correct_after": analysis.correct_after,
        "price_basis": "re-priced with one price table" if changed else ("billed cost" if money else "billed tokens"),
        "mix_compared": f"{round((analysis.mix_covered or 0) * 100)}% of the later calls were compared like for like by prompt size",
    }
    # the counterfactual: the correct answers given since the change, at the per-answer difference. Estimated, kept apart.
    if analysis.status in ("saving", "no_clear_change", "cost_up"):
        n = (await session.execute(
            select(func.count()).where(Run.job_id == job.job_id, Run.run_kind == "PRODUCTION", Run.outcome == "PASS", ~_EXCLUDED,
                                       Run.created_at >= datetime(after.start.year, after.start.month, after.start.day, tzinfo=UTC) + timedelta(days=1),
                                       Run.created_at < datetime(today.year, today.month, today.day, tzinfo=UTC),
                                       *([Run.created_at < datetime(after.end.year, after.end.month, after.end.day, tzinfo=UTC) + timedelta(days=1)] if after.end else [])))
        ).scalar_one()
        entry.estimated_avoided = {
            "label": "ESTIMATED (a counterfactual, not money you can count)", "unit": unit, "correct_answers": int(n),
            "point": _round(analysis.saving * n, unit), "low": _round(analysis.saving_low * n, unit),
            "high": _round(analysis.saving_high * n, unit),
            "what": ("What the correct answers given since the change would have cost more or less on the old model, "
                     "at the per-answer difference measured above."),
            "assumptions": ASSUMPTIONS,
        }
    return entry


@dataclass
class SavingsResult:
    mode: str
    unit: str
    today: date
    entries: list[Entry]
    jobs_checked: int
    notes: list[str]


async def savings(session: AsyncSession, project: Project, *, today: date | None = None) -> SavingsResult:
    today = today or datetime.now(UTC).date()
    mode = project.billing_mode if project.billing_mode in ("subscription", "both") else "per_use"
    money = mode != "subscription"
    since = datetime(today.year, today.month, today.day, tzinfo=UTC) - timedelta(days=HISTORY_DAYS)
    jobs = (await session.execute(select(Job).where(Job.project_id == project.project_id).order_by(Job.name))).scalars().all()
    entries: list[Entry] = []
    for job in jobs:
        days = await _daily_models(session, job.job_id, since)
        if not days:
            continue
        segments = sm.find_segments(days)
        first_day = min(days)
        for before, after in zip(segments, segments[1:], strict=False):
            entries.append(await _entry(session, job, before, after, today=today, first_day=first_day, money=money))
    notes = [NOT_COUNTED]
    if not money:
        notes.append("Your project is on a flat plan, so this counts tokens per correct answer, not dollars. It is approximate: "
                     "different models count tokens differently.")
    if mode == "both":
        notes.append("Your project mixes pay-per-use and flat-plan calls, so dollars are list prices that may include flat-plan calls.")
    return SavingsResult(mode=mode, unit="usd" if money else "tokens", today=today, entries=entries, jobs_checked=len(jobs), notes=notes)
