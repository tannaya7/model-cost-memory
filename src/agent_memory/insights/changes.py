"""What changed between two equal periods, and what else happened at the same time (technical plan 3.4, "why did this change?").

Everything here is arithmetic on the project's own PRODUCTION runs, so the same data always gives the same answer and no
model writes any of it. Two kinds of statement are kept apart on purpose:

    observation    a measured difference: calls, tokens, cached share, repeated calls, model mix, task mix, spend. Each has
                   a before, an after, the coverage behind it, and says plainly when a figure is missing.
    context        something the product recorded in the same window (a new prompt version, a new model, a list-price
                   change). It is listed as "happened at the same time". It is only marked `concentrated` when the
                   calls on that version themselves differ in the same direction as the overall change. It is never
                   marked as a cause: a prompt, a model or a price can coincide with a change, and only a controlled
                   test can show it caused one. Changes to the project's own settings and to the customer's code are not
                   recorded, and the answer says so.

Periods are whole UTC days, ending at the start of today (today is partial), the current one against the same number of
days before it. A percentage change is not given when the earlier period has fewer than MIN_CALLS calls.

Spend and token changes are split exactly (the parts add up to the whole):

    calls          (calls now - calls before) x the earlier average per call
    mix            the change from calls moving between models, plus models that are new in this period
    per call       the change in what a call costs (or weighs) on a model that ran in both periods
"""

from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass, field
from datetime import UTC, date, datetime, timedelta

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from ..models import Job, PriceVersion, Run

MIN_CALLS = 20  # under this many calls in a period, a percentage change says nothing
NOTABLE_PCT = 20.0  # a change of at least this many percent (with enough calls) is called notable
NOTABLE_SHARE_POINTS = 5.0  # a model or task whose share of calls moved this many points is listed
CACHE_POINTS = 5.0  # a cached-share move of this many points is notable
CONCENTRATION_MIN_CALLS = 20
DAYS = (7, 14, 30)
TOP_MIX = 5


@dataclass
class Period:
    start: date
    end: date  # exclusive
    days: int
    calls: int = 0
    tokens_in: int = 0
    tokens_out: int = 0
    cache_read: int = 0
    priced_calls: int = 0
    spend_usd: float = 0.0
    with_usage: int = 0
    with_trace: int = 0
    repeats: int = 0
    days_with_calls: int = 0


@dataclass
class Observation:
    key: str
    label: str
    unit: str  # count | tokens | share | usd
    before: float | None
    after: float | None
    change: float | None  # after - before (points for a share)
    change_pct: float | None  # None when the earlier period is too small, or a share
    size: str  # notable | small | unknown
    note: str | None = None


@dataclass
class MixRow:
    name: str
    before_share: float | None
    after_share: float | None
    change_points: float | None
    calls_before: int
    calls_after: int


@dataclass
class Split:
    """A total change split into parts that add up to it."""

    what: str  # spend_usd | tokens
    total_change: float
    from_calls: float
    from_mix: float
    from_per_call: float


@dataclass
class ContextEvent:
    kind: str  # prompt_version | new_model | price_change
    on: date
    label: str
    link: str  # same_time | concentrated: never "caused"
    evidence: str | None
    relates_to: list[str] = field(default_factory=list)


@dataclass
class Changes:
    current: Period
    previous: Period
    comparable: bool
    observations: list[Observation]
    model_mix: list[MixRow]
    task_mix: list[MixRow]
    splits: list[Split]
    events: list[ContextEvent]
    notes: list[str]
    not_recorded: list[str]


NOT_RECORDED = [
    "Changes to this project's settings and to your own code or prompts outside what you tag are not recorded here, so they cannot be listed.",
]


def _pct(before: float, after: float) -> float | None:
    return (after - before) / before * 100.0 if before else None


def _size(before: float, after: float, calls_before: int) -> str:
    if calls_before < MIN_CALLS:
        return "unknown"
    p = _pct(before, after)
    return "notable" if p is not None and abs(p) >= NOTABLE_PCT else "small"


def windows(days: int, today: date) -> tuple[date, date, date]:
    """(previous start, current start, current end): whole days, today left out because it is partial."""
    return today - timedelta(days=2 * days), today - timedelta(days=days), today


def split(prev: dict[str, tuple[int, float]], cur: dict[str, tuple[int, float]], what: str) -> Split | None:
    """Exact price-volume-mix split. Each dict maps a model to (calls, total) in its period. A model with no earlier
    calls has no earlier average, so its whole amount counts as mix and none as per-call."""
    n0, n1 = sum(n for n, _ in prev.values()), sum(n for n, _ in cur.values())
    t0, t1 = sum(t for _, t in prev.values()), sum(t for _, t in cur.values())
    if n0 == 0 or n1 == 0:
        return None
    avg0 = t0 / n0
    from_calls = (n1 - n0) * avg0
    per_call = 0.0
    at_old_rates = 0.0  # this period's calls, valued at each model's earlier average (new models at their own)
    for model, (n, total) in cur.items():
        before = prev.get(model)
        if before and before[0]:
            old_avg = before[1] / before[0]
            per_call += total - n * old_avg
            at_old_rates += n * old_avg
        else:
            at_old_rates += total
    mix = at_old_rates - n1 * avg0
    return Split(what, t1 - t0, from_calls, mix, per_call)


def mix_rows(prev: dict[str, int], cur: dict[str, int]) -> list[MixRow]:
    n0, n1 = sum(prev.values()), sum(cur.values())
    rows = []
    for name in set(prev) | set(cur):
        b = prev.get(name, 0) / n0 * 100 if n0 else None
        a = cur.get(name, 0) / n1 * 100 if n1 else None
        rows.append(MixRow(name, b, a, (a - b) if a is not None and b is not None else None,
                           prev.get(name, 0), cur.get(name, 0)))
    moved = [r for r in rows if r.change_points is not None and abs(r.change_points) >= NOTABLE_SHARE_POINTS]
    return sorted(moved, key=lambda r: (-abs(r.change_points), r.name))[:TOP_MIX]


async def _period(session: AsyncSession, project_id: str, lo: datetime, hi: datetime, p: Period) -> dict:
    """Totals for one period, and the per-model and per-task counts the other views need."""
    base = (Run.project_id == project_id, Run.run_kind == "PRODUCTION", Run.created_at >= lo, Run.created_at < hi,
            Run.state != "INGESTION_FAILED")
    t = (await session.execute(
        select(func.count(), func.coalesce(func.sum(Run.tokens_in), 0), func.coalesce(func.sum(Run.tokens_out), 0),
               func.coalesce(func.sum(Run.cache_read_tokens), 0), func.count().filter(Run.cost_usd.is_not(None)),
               func.coalesce(func.sum(Run.cost_usd), 0),
               func.count().filter(func.coalesce(Run.usage_shape, "") != "none"),
               func.count().filter(Run.trace_id.is_not(None)),
               func.count(func.distinct(func.date_trunc("day", Run.created_at))))
        .where(*base))).one()
    (p.calls, p.tokens_in, p.tokens_out, p.cache_read, p.priced_calls, spend, p.with_usage, p.with_trace,
     p.days_with_calls) = (int(t[0]), int(t[1]), int(t[2]), int(t[3]), int(t[4]), float(t[5]), int(t[6]), int(t[7]), int(t[8]))
    p.spend_usd = spend
    per_model = (await session.execute(
        select(Run.model, func.count(), func.count().filter(Run.cost_usd.is_not(None)),
               func.coalesce(func.sum(Run.cost_usd), 0), func.coalesce(func.sum(Run.tokens_in + Run.tokens_out), 0))
        .where(*base).group_by(Run.model))).all()
    per_task = (await session.execute(
        select(Job.name, func.count()).select_from(Run).join(Job, Job.job_id == Run.job_id).where(*base).group_by(Job.name))).all()
    # Repeats: calls that repeat an earlier call (same prompt) inside the same task trace. Often a retry, but a repeat
    # is all this can show.
    groups = (select(func.count().label("n")).where(*base, Run.trace_id.is_not(None))
              .group_by(Run.trace_id, Run.prompt_hash).subquery())
    p.repeats = int((await session.execute(select(func.coalesce(func.sum(groups.c.n - 1), 0)))).scalar_one())
    return {"model": {m: (int(n), int(pn), float(c), int(tok)) for m, n, pn, c, tok in per_model},
            "task": {name: int(n) for name, n in per_task}}


async def _events(session: AsyncSession, project_id: str, lo: datetime, hi: datetime, models: set[str],
                  money: bool) -> list[ContextEvent]:
    events: list[ContextEvent] = []
    first = (await session.execute(
        select(Run.model, func.min(Run.created_at)).where(Run.project_id == project_id, Run.run_kind == "PRODUCTION")
        .group_by(Run.model).having(func.min(Run.created_at) >= lo, func.min(Run.created_at) < hi))).all()
    for model, at in first:
        events.append(ContextEvent("new_model", at.date(), f"{model} appeared in your calls for the first time",
                                   "same_time", None, ["model_mix", "calls", "spend_usd"] if money else ["model_mix", "calls"]))
    versions = (await session.execute(
        select(Job.name, Run.prompt_version, func.min(Run.created_at)).select_from(Run).join(Job, Job.job_id == Run.job_id)
        .where(Run.project_id == project_id, Run.run_kind == "PRODUCTION", Run.prompt_version.is_not(None))
        .group_by(Job.name, Run.prompt_version).having(func.min(Run.created_at) >= lo, func.min(Run.created_at) < hi))).all()
    for job, version, at in versions:
        events.append(ContextEvent("prompt_version", at.date(), f"Prompt version {version} of {job} appeared",
                                   "same_time", None, ["tokens_in_per_call", "tokens_out_per_call", "cache_share"]))
    if money and models:
        rows = (await session.execute(
            select(PriceVersion).where(func.lower(PriceVersion.model).in_({m.lower() for m in models}))
            .order_by(PriceVersion.model, PriceVersion.provider, PriceVersion.effective_from))).scalars().all()
        last: dict[tuple, PriceVersion] = {}
        for r in rows:
            key = (r.scope, r.model, r.model_version, r.provider)
            old = last.get(key)
            if old is not None and lo <= r.effective_from < hi and (
                    old.input_per_mtok != r.input_per_mtok or old.output_per_mtok != r.output_per_mtok):
                events.append(ContextEvent(
                    "price_change", r.effective_from.date(),
                    f"The list price of {r.model} changed: input ${float(old.input_per_mtok):g} to ${float(r.input_per_mtok):g} "
                    f"and output ${float(old.output_per_mtok):g} to ${float(r.output_per_mtok):g} per million tokens",
                    "same_time", None, ["spend_usd"]))
            last[key] = r
    return sorted(events, key=lambda e: (e.on, e.kind, e.label))


async def _concentration(session: AsyncSession, project_id: str, lo: datetime, hi: datetime, events: list[ContextEvent],
                         overall_in_change: float | None) -> None:
    """Upgrade a prompt-version event to `concentrated` when, in the current period, the calls on that version weigh
    differently from the same task's other calls, in the same direction as the overall change. Still not a cause."""
    if overall_in_change is None or overall_in_change == 0:
        return
    rows = (await session.execute(
        select(Job.name, Run.prompt_version, func.count(), func.avg(Run.tokens_in)).select_from(Run).join(Job, Job.job_id == Run.job_id)
        .where(Run.project_id == project_id, Run.run_kind == "PRODUCTION", Run.created_at >= lo, Run.created_at < hi)
        .group_by(Job.name, Run.prompt_version))).all()
    by_job: dict[str, dict] = defaultdict(dict)
    for job, version, n, avg in rows:
        by_job[job][version] = (int(n), float(avg or 0))
    for e in events:
        if e.kind != "prompt_version":
            continue
        job = e.label.split(" of ", 1)[1].rsplit(" appeared", 1)[0]
        version = e.label.split("Prompt version ", 1)[1].split(" of ", 1)[0]
        groups = by_job.get(job, {})
        mine = groups.get(version)
        others = [(n, a) for v, (n, a) in groups.items() if v != version]
        n_o = sum(n for n, _ in others)
        if not mine or mine[0] < CONCENTRATION_MIN_CALLS or n_o < CONCENTRATION_MIN_CALLS:
            continue
        avg_o = sum(n * a for n, a in others) / n_o
        if (mine[1] - avg_o) * overall_in_change > 0:
            e.link = "concentrated"
            e.evidence = (f"In this period, calls on {version} sent {mine[1]:,.0f} input tokens on average and the other "
                          f"{job} calls {avg_o:,.0f}. That fits the change. It does not show the wording is the reason for it.")


async def what_changed(session: AsyncSession, project_id: str, *, days: int = 7, mode: str = "per_use",
                       now: datetime | None = None) -> Changes:
    if days not in DAYS:
        raise ValueError(f"days must be one of {DAYS}")
    money = mode != "subscription"
    today = (now or datetime.now(UTC)).date()
    p0, c0, c1 = windows(days, today)
    cut = lambda d: datetime(d.year, d.month, d.day, tzinfo=UTC)  # noqa: E731
    prev, cur = Period(p0, c0, days), Period(c0, c1, days)
    pm = await _period(session, project_id, cut(p0), cut(c0), prev)
    cm = await _period(session, project_id, cut(c0), cut(c1), cur)

    notes: list[str] = []
    comparable = prev.calls >= MIN_CALLS and cur.calls >= MIN_CALLS
    if prev.calls == 0:
        notes.append(f"There were no calls in the {days} days before, so there is nothing to compare with yet.")
    elif prev.calls < MIN_CALLS:
        notes.append(f"Only {prev.calls} calls in the {days} days before: too few for a percentage change (we need {MIN_CALLS}).")
    if cur.calls == 0:
        notes.append(f"There were no calls in the last {days} days.")
    for label, p in (("last", cur), ("earlier", prev)):
        if p.calls and p.days_with_calls < p.days:
            notes.append(f"In the {label} {days} days, {p.days - p.days_with_calls} had no calls at all.")
        if p.calls and p.with_usage < p.calls:
            notes.append(f"{p.calls - p.with_usage:,} calls in the {label} {days} days report no token counts, so their tokens are not counted.")
        if p.calls and money and p.priced_calls < p.calls:
            notes.append(f"{p.calls - p.priced_calls:,} calls in the {label} {days} days have no known price, so spend leaves them out.")
    if cur.calls and cur.with_trace < cur.calls:
        notes.append(f"Repeated calls can only be found among the {cur.with_trace:,} calls that carry a task id.")

    obs: list[Observation] = []

    def add(key, label, unit, b, a, calls_b=prev.calls, note=None, share=False):
        change = (a - b) if a is not None and b is not None else None
        pct = None if share or b is None or a is None else _pct(b, a)
        if share:
            size = "unknown" if calls_b < MIN_CALLS or change is None else ("notable" if abs(change) >= CACHE_POINTS else "small")
        else:
            size = "unknown" if b is None or a is None else _size(b, a, calls_b)
        obs.append(Observation(key, label, unit, b, a, change, pct if calls_b >= MIN_CALLS else None, size, note))

    add("calls", "AI calls", "count", prev.calls, cur.calls)
    add("tokens_in", "Input tokens", "tokens", prev.tokens_in, cur.tokens_in)
    add("tokens_out", "Output tokens", "tokens", prev.tokens_out, cur.tokens_out)
    per = lambda total, p: (total / p.with_usage if p.with_usage else None)  # noqa: E731
    add("tokens_in_per_call", "Input tokens per call", "tokens", per(prev.tokens_in, prev), per(cur.tokens_in, cur))
    add("tokens_out_per_call", "Output tokens per call", "tokens", per(prev.tokens_out, prev), per(cur.tokens_out, cur))
    cache = lambda p: (p.cache_read / (p.cache_read + p.tokens_in) * 100 if p.cache_read + p.tokens_in else None)  # noqa: E731
    add("cache_share", "Share of input read from the cache", "share", cache(prev), cache(cur), share=True)
    rep = lambda p: (p.repeats / p.with_trace * 100 if p.with_trace else None)  # noqa: E731
    add("repeated_calls", "Calls that repeat an earlier call in the same task", "share", rep(prev), rep(cur),
        calls_b=prev.with_trace, share=True,
        note="Often a retry, but a repeat is all the data can show.")
    if money:
        add("spend_usd", "Spend on calls with a known price", "usd", prev.spend_usd if prev.priced_calls else None,
            cur.spend_usd if cur.priced_calls else None, calls_b=prev.priced_calls)

    splits: list[Split] = []
    tokens_split = split({m: (n, float(tok)) for m, (n, _, _, tok) in pm["model"].items()},
                         {m: (n, float(tok)) for m, (n, _, _, tok) in cm["model"].items()}, "tokens")
    if tokens_split and comparable:
        splits.append(tokens_split)
    if money:
        priced = lambda per_model: {m: (pn, c) for m, (_, pn, c, _) in per_model.items() if pn}  # noqa: E731
        spend_split = split(priced(pm["model"]), priced(cm["model"]), "spend_usd")
        if spend_split and comparable:
            splits.append(spend_split)

    events = await _events(session, project_id, cut(c0), cut(c1), set(pm["model"]) | set(cm["model"]), money)
    in_change = next((o.change for o in obs if o.key == "tokens_in_per_call"), None)
    await _concentration(session, project_id, cut(c0), cut(c1), events, in_change)
    return Changes(
        current=cur, previous=prev, comparable=comparable, observations=obs,
        model_mix=mix_rows({m: v[0] for m, v in pm["model"].items()}, {m: v[0] for m, v in cm["model"].items()}),
        task_mix=mix_rows(pm["task"], cm["task"]), splits=splits, events=events, notes=notes, not_recorded=NOT_RECORDED)
