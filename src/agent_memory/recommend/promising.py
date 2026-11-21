"""The "Promising, worth a trial" level, and how many checked answers a switch still needs.

A model is PROMISING, not proven, when it looks close to the model in use but there is not yet enough
evidence to advise a switch. It is never advice: the only thing it offers is a trial on the owner's own
examples. Proven (engine.decide) is untouched; this module only looks at jobs where nothing is proven.

The rule, for a candidate that is not proven, against the model in use:

    quality      the lower end of Newcombe's interval for (candidate - model in use), at the true
                 one-sided 95% (z = 1.645), is at least -margin (3 points)
    amount       Kish effective sample size of at least 100 for each of the two models
    time         at least 7 days of the candidate's checked answers
    stability    all of that held at each of the last TWO checkpoints

A checkpoint is every 50th checked answer of the candidate, in run order, judged on the data as it stood
at that moment (answers weighted by their age then). No state is stored: the whole thing is a pure
function of the run history, so it can appear and disappear, and one lucky stretch cannot trigger it
(peeking at a running comparison inflates false positives; two separate looks that agree do much less).

`needed_per_model` solves the other question, shown as stage 2 of the progress bar: how many checked
answers each model needs before the Proven rule would pass, if today's observed rates held.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from datetime import datetime, timedelta

from .stats import Sample, assess, difference

ONE_SIDED_95 = 1.645  # NormalDist().inv_cdf(0.95); stats.z_for() is two-sided, so it is not reused
MIN_EFFECTIVE_N = 100.0
MIN_DAYS = 7
CHECKPOINT_EVERY = 50
SEARCH_LIMIT = 10_000_000


@dataclass(frozen=True)
class Group:
    """`n` checked answers of one model made at `at` (a run, or an hour of runs), `passes` of them correct."""

    at: datetime
    n: int
    passes: int


@dataclass(frozen=True)
class Promising:
    model: str
    current: str
    gap: float  # observed candidate - model in use, as a fraction
    low: float  # range (one-sided 95% bounds, so a 90% range) of that gap
    high: float
    more_needed: int | None  # about this many more checked answers on the candidate before a switch could be advised


def weighted(groups: list[Group], as_of: datetime, stability_days: float) -> Sample | None:
    """The freshness-weighted pass rate of the groups made up to `as_of`, weighted by age at `as_of`."""
    total = squares = passing = 0.0
    for g in groups:
        if g.at > as_of or g.n <= 0:
            continue
        w = math.exp(-max((as_of - g.at).total_seconds(), 0.0) / 86400.0 / stability_days)
        total += g.n * w
        squares += g.n * w * w
        passing += g.passes * w
    if total <= 0:
        return None
    return Sample(pass_rate=passing / total, effective_n=total * total / squares, evidence_weight=total)


def checkpoints(candidate: list[Group]) -> list[datetime]:
    """When the candidate reached its 50th, 100th, ... checked answer, in run order."""
    out: list[datetime] = []
    seen = 0
    for g in sorted(candidate, key=lambda g: g.at):
        before, seen = seen, seen + g.n
        out += [g.at] * (seen // CHECKPOINT_EVERY - before // CHECKPOINT_EVERY)
    return out


def holds_at(candidate: list[Group], current: list[Group], as_of: datetime, *, margin: float,
             stability_days: float) -> bool:
    """The quality and amount parts of the rule, on the data as it stood at `as_of`."""
    c, r = weighted(candidate, as_of, stability_days), weighted(current, as_of, stability_days)
    if c is None or r is None or c.effective_n < MIN_EFFECTIVE_N or r.effective_n < MIN_EFFECTIVE_N:
        return False
    low, _ = difference(c, r, ONE_SIDED_95)
    return low >= -margin


def is_promising(candidate: list[Group], current: list[Group], *, now: datetime, margin: float,
                 stability_days: float, proven_z: float) -> bool:
    """True when the whole rule holds. Never true when the Proven rule (at `proven_z`) already passes."""
    now_c, now_r = weighted(candidate, now, stability_days), weighted(current, now, stability_days)
    if now_c is None or now_r is None:
        return False
    if assess(now_c, now_r, margin=margin, z=proven_z) == "GOOD_ENOUGH":
        return False  # that is Proven (or about to be), not Promising
    cps = checkpoints([g for g in candidate if g.at <= now])
    if len(cps) < 2:
        return False
    first = min((g.at for g in candidate if g.n > 0), default=None)
    if first is None or cps[-1] - first < timedelta(days=MIN_DAYS):
        return False
    return all(holds_at(candidate, current, cp, margin=margin, stability_days=stability_days)
               for cp in (cps[-1], cps[-2]))


def needed_per_model(p_candidate: float, p_current: float, *, margin: float, z: float, floor: float) -> int | None:
    """The smallest effective sample size per model (at least `floor`) at which the Proven rule would pass
    if both observed rates held; None when it never would (the candidate is not within the margin at
    these rates) or the rates are unusable."""
    rates = (p_candidate, p_current)
    if not all(isinstance(p, (int, float)) and math.isfinite(p) for p in rates):
        return None
    p1, p2 = (min(max(p, 0.0), 1.0) for p in rates)
    if p1 - p2 <= -margin:
        return None

    def passes(n: float) -> bool:
        low, _ = difference(Sample(p1, n, n), Sample(p2, n, n), z)
        return low >= -margin

    lo = max(1, math.ceil(floor))
    if passes(lo):
        return lo
    hi = lo
    while not passes(hi):
        hi *= 2
        if hi > SEARCH_LIMIT:
            return None
    while hi - lo > 1:  # passes(hi) is true, passes(lo) false
        mid = (lo + hi) // 2
        lo, hi = (lo, mid) if passes(mid) else (mid, hi)
    return hi
