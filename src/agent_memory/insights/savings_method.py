"""The savings tracker's method, with no database in it, so it can be tested and simulated.

What it measures. After a person has changed which model a task runs on (we never make the change), compare the task's own
cost per correct answer before and after, over equal windows, with the mix of prompt sizes held fixed. Two things come out and
are never added together:

- **Realized change**: the observed change in cost per correct answer, with a range. It can be negative.
- **Estimated avoided cost**: a counterfactual. The correct answers given since the change, times the per-answer change.
  It is an estimate, with assumptions, and is never added to anything.

Design (research_notes/Savings tracker research/measurement_and_claims.md), kept here:
- Baseline is the task's OWN observed cost, never a list price or a model we did not see.
- Cost per correct answer = cost of the priced, checked calls divided by the passes among those same calls (the cost-receipt rule).
  Retries and failed attempts are calls, so their cost is in the numerator.
- Equal windows of whole weeks, at least MIN_WINDOW_DAYS and at most MAX_WINDOW_DAYS; the day of the change is left out.
- Compare within prompt-size buckets and weight by the AFTER mix; a bucket seen in only one window is dropped.
- Range by bootstrap over calls. The decision to show a saving uses the cautious end only.
- Other baselines are also tried, and the SMALLEST saving is reported: a longer one (up to MAX_WINDOW_DAYS before the change) and the
  stretch just before the equal window. People change models after a task looked bad or costly, so the days right before the change
  may be an unusually bad stretch (regression to the mean); checking against earlier days stops that being counted as a saving.
- If quality (pass rate) fell beyond its range, it is "cheaper but less correct", never a saving.
- Too little or too uneven data gives "not enough comparable data", never a weak number.

The thresholds are ours; no source publishes any. They were checked by simulation (scripts/validate_savings_method.py).
Nothing here reads recommendations, "promising" labels or trials, and nothing changes a model or a prompt.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date, timedelta

import numpy as np

from ..recommend.stats import wilson, z_for

# ---- thresholds (ours) -----------------------------------------------------------------------------------------------
MIN_CHECKED = 100          # checked, priced calls in each window
MIN_CORRECT = 30           # passes in each window
MIN_WINDOW_DAYS = 14
MAX_WINDOW_DAYS = 28
DOMINANT_SHARE = 0.80      # a model is "the" model of a day at this share of the day's calls
RUN_DAYS = 3               # consecutive days a new model must dominate to count as a switch
RUN_CALLS = 100            # calls in that run
WINDOW_PURITY = 0.90       # share of a window's calls made by the model it is meant to describe
PRICED_SHARE = 0.90        # share of checked calls that must have a cost (or tokens, on a flat plan)
BUCKET_EDGES = (1_000, 4_000, 16_000)  # prompt characters: <1k, 1k-4k, 4k-16k, 16k+
MIN_BUCKET = 10            # calls a bucket needs in each window to be compared
MIN_MIX_COVERED = 0.60     # share of the AFTER mix that must survive dropping one-sided buckets
CACHE_SHIFT = 0.15         # a change in cache-hit share that is worth saying out loud
BOOTSTRAP = 2000
LOW_Q, HIGH_Q = 0.05, 0.95  # the shown range; the decision uses LOW_Q. Chosen by simulation (the design said 0.10 / 0.90)
BOOT_CAP = 20_000          # largest group the bootstrap resamples whole; larger ones are sampled down for the range only

STATUSES = ("waiting", "not_enough_data", "saving", "no_clear_change", "cost_up", "less_correct")


def bucket_of(prompt_chars: int | None) -> int:
    """The prompt-size bucket, or -1 when the prompt text is gone (retention) and its size is unknown."""
    if prompt_chars is None:
        return -1
    return sum(prompt_chars >= edge for edge in BUCKET_EDGES)


# ---- finding the switch ---------------------------------------------------------------------------------------------

@dataclass
class Segment:
    model: str
    start: date          # first day the model dominates
    end: date | None     # last day before the next switch; None = still current
    calls: int = 0


def find_segments(days: dict[date, dict[str, int]]) -> list[Segment]:
    """Cut a task's history into stretches where one model made at least DOMINANT_SHARE of each day's calls.

    A new stretch starts when a different model dominates RUN_DAYS days in a row with RUN_CALLS calls in total. Days where
    no model reaches the share (a split, or fallback routing) neither start nor end a stretch."""
    segments: list[Segment] = []
    ordered = sorted(days)
    # the dominant model of each day, or None
    dominant: dict[date, str | None] = {}
    for d in ordered:
        counts = days[d]
        total = sum(counts.values())
        top, n = max(counts.items(), key=lambda kv: (kv[1], kv[0]))
        dominant[d] = top if total and n / total >= DOMINANT_SHARE else None
    current: Segment | None = None
    i = 0
    while i < len(ordered):
        d = ordered[i]
        m = dominant[d]
        if m is None:
            i += 1
            continue
        if current is None:
            current = Segment(model=m, start=d, end=None)
            segments.append(current)
            i += 1
            continue
        if m == current.model:
            i += 1
            continue
        # a different model: does it hold for RUN_DAYS consecutive calendar days?
        run = [d]
        j = i + 1
        while j < len(ordered) and ordered[j] == run[-1] + timedelta(days=1) and dominant[ordered[j]] == m:
            run.append(ordered[j])
            j += 1
        if len(run) >= RUN_DAYS and sum(days[x].get(m, 0) for x in run) >= RUN_CALLS:
            current.end = d - timedelta(days=1)
            current = Segment(model=m, start=d, end=None)
            segments.append(current)
            i = j
        else:
            i += 1  # a blip of another model: not a switch
    for seg in segments:
        seg.calls = sum(days[d].get(seg.model, 0) for d in ordered if seg.start <= d and (seg.end is None or d <= seg.end))
    return segments


@dataclass
class Windows:
    before_start: date
    before_end: date
    after_start: date
    after_end: date
    days: int
    longer_before_start: date | None = None  # the longer baseline, when more history exists


def choose_windows(before: Segment, after: Segment, today: date, first_data_day: date) -> tuple[Windows | None, dict]:
    """Equal windows of whole weeks on each side of a switch, or None with how far along it is.

    The day of the switch is left out (the cache is cold and traffic is moving); only completed days are used, so the answer
    does not change as the current day fills up."""
    last_complete = today - timedelta(days=1)
    switch = after.start
    before_first = max(before.start + timedelta(days=1), first_data_day) if before.start > first_data_day else first_data_day
    before_last = switch - timedelta(days=1)
    after_first = switch + timedelta(days=1)
    after_last = min(after.end, last_complete) if after.end is not None else last_complete
    n_before = max((before_last - before_first).days + 1, 0)
    n_after = max((after_last - after_first).days + 1, 0)
    progress = {"days_before": n_before, "days_after": n_after, "needed": MIN_WINDOW_DAYS}
    length = min(n_before, n_after, MAX_WINDOW_DAYS)
    length = (length // 7) * 7
    if length < MIN_WINDOW_DAYS:
        return None, progress
    win = Windows(
        before_start=before_last - timedelta(days=length - 1), before_end=before_last,
        after_start=after_first, after_end=after_first + timedelta(days=length - 1), days=length,
    )
    longer = min(n_before, MAX_WINDOW_DAYS)
    if longer > length:
        win.longer_before_start = before_last - timedelta(days=longer - 1)
    return win, progress


# ---- one window's calls ----------------------------------------------------------------------------------------------

@dataclass
class Calls:
    """The checked calls of one window. `cost` is dollars, or tokens on a flat plan; NaN means no cost is known."""

    cost: np.ndarray
    passed: np.ndarray       # bool
    bucket: np.ndarray       # int, -1 = size unknown
    checked: int = 0         # checked calls, priced or not
    cache_hit_share: float | None = None
    calls_total: int = 0     # every production call in the window
    by_model: dict[str, int] = field(default_factory=dict)

    @property
    def priced(self) -> np.ndarray:
        return ~np.isnan(self.cost)


@dataclass
class Analysis:
    status: str
    reason: str | None = None
    reasons: list[str] = field(default_factory=list)
    cpc_before: float | None = None
    cpc_after: float | None = None
    saving: float | None = None            # cost_before - cost_after per correct answer; negative = cost went up
    saving_low: float | None = None
    saving_high: float | None = None
    pass_before: float | None = None
    pass_after: float | None = None
    pass_diff_low: float | None = None
    pass_diff_high: float | None = None
    checked_before: int = 0
    checked_after: int = 0
    correct_before: int = 0
    correct_after: int = 0
    mix_covered: float | None = None
    buckets_used: list[int] = field(default_factory=list)
    mix_adjusted: bool = True
    longer_baseline: dict | None = None
    notes: list[str] = field(default_factory=list)


def _group(calls: Calls, bucket: int) -> tuple[np.ndarray, np.ndarray]:
    keep = calls.priced & (calls.bucket == bucket)
    return calls.cost[keep], calls.passed[keep].astype(float)


def _cpc(cost: np.ndarray, passed: np.ndarray) -> float | None:
    p = passed.sum()
    return float(cost.sum() / p) if p > 0 else None


def _standardised(groups_b: dict[int, tuple], groups_a: dict[int, tuple], weights: dict[int, float]) -> tuple[float, float]:
    sb = sum(w * _cpc(*groups_b[b]) for b, w in weights.items())
    sa = sum(w * _cpc(*groups_a[b]) for b, w in weights.items())
    return sb, sa


def _boot(groups: dict[int, tuple], rng: np.random.Generator, n: int, weights: dict[int, float]) -> np.ndarray:
    """Weighted cost per correct answer for `n` resamples of each bucket's calls."""
    total = np.zeros(n)
    for b, w in weights.items():
        cost, passed = groups[b]
        size = len(cost)
        if size > BOOT_CAP:  # keep memory bounded: the range comes from a sample, the point estimate from everything
            pick = rng.choice(size, BOOT_CAP, replace=False)
            cost, passed, size = cost[pick], passed[pick], BOOT_CAP
        out = np.empty(n)
        step = max(1, 4_000_000 // size)
        for lo in range(0, n, step):
            hi = min(n, lo + step)
            idx = rng.integers(0, size, size=(hi - lo, size))
            c, p = cost[idx].sum(axis=1), passed[idx].sum(axis=1)
            out[lo:hi] = np.where(p > 0, c / np.where(p > 0, p, 1), np.nan)
        total += w * out
    return total


def analyse(before: Calls, after: Calls, *, seed: int, boot: int = BOOTSTRAP, baselines: dict[str, Calls] | None = None) -> Analysis:
    """Cost per correct answer before and after, standardised for prompt size, with a range and the guards."""
    out = Analysis(status="not_enough_data", checked_before=int(before.priced.sum()), checked_after=int(after.priced.sum()))
    out.correct_before = int(before.passed[before.priced].sum())
    out.correct_after = int(after.passed[after.priced].sum())

    # 1. enough checked, priced calls with a cost, on both sides
    for name, calls in (("before", before), ("after", after)):
        if calls.checked and calls.priced.sum() / calls.checked < PRICED_SHARE:
            out.reasons.append(f"more than {round((1 - PRICED_SHARE) * 100)}% of the checked calls {name} the change have no cost")
    if out.checked_before < MIN_CHECKED or out.checked_after < MIN_CHECKED:
        out.reasons.append(f"fewer than {MIN_CHECKED} checked calls with a cost in each period")
    if out.correct_before < MIN_CORRECT or out.correct_after < MIN_CORRECT:
        out.reasons.append(f"fewer than {MIN_CORRECT} correct answers in each period")
    # 2. the windows describe the models they are meant to
    if out.reasons:
        out.reason = out.reasons[0]
        return out

    # 3. prompt-size mix
    known_b = float((before.bucket[before.priced] >= 0).mean())
    known_a = float((after.bucket[after.priced] >= 0).mean())
    if min(known_b, known_a) < 0.8:
        out.reasons.append("the prompt text was already deleted for many calls, so the size mix could not be compared")
        out.reason = out.reasons[0]
        return out
    bk_b = {b: _group(before, b) for b in set(before.bucket[before.priced].tolist()) if b >= 0}
    bk_a = {b: _group(after, b) for b in set(after.bucket[after.priced].tolist()) if b >= 0}
    usable = [b for b in bk_a if b in bk_b and len(bk_a[b][0]) >= MIN_BUCKET and len(bk_b[b][0]) >= MIN_BUCKET
              and bk_a[b][1].sum() > 0 and bk_b[b][1].sum() > 0]
    after_known = sum(len(bk_a[b][0]) for b in bk_a)
    covered = sum(len(bk_a[b][0]) for b in usable) / after_known if after_known else 0.0
    out.mix_covered = round(covered, 3)
    out.buckets_used = sorted(usable)
    if not usable or covered < MIN_MIX_COVERED:
        out.reasons.append("the kinds of prompts changed too much between the two periods to compare them fairly")
        out.reason = out.reasons[0]
        return out
    weights = {b: len(bk_a[b][0]) / sum(len(bk_a[x][0]) for x in usable) for b in usable}

    sb, sa = _standardised(bk_b, bk_a, weights)
    rng = np.random.default_rng(seed)
    d = _boot(bk_b, rng, boot, weights) - _boot(bk_a, rng, boot, weights)
    d = d[~np.isnan(d)]
    out.cpc_before, out.cpc_after, out.saving = sb, sa, sb - sa
    out.saving_low, out.saving_high = float(np.quantile(d, LOW_Q)), float(np.quantile(d, HIGH_Q))

    # 4. other baselines: report the SMALLEST saving
    tried = {}
    for name, extra in (baselines or {}).items():
        if extra is None or extra.priced.sum() < MIN_CHECKED:
            continue
        eg = {b: _group(extra, b) for b in usable}
        if any(len(eg[b][0]) < MIN_BUCKET or eg[b][1].sum() == 0 for b in usable):
            continue
        esb, _ = _standardised(eg, bk_a, weights)
        ed = _boot(eg, rng, boot, weights) - _boot(bk_a, rng, boot, weights)
        ed = ed[~np.isnan(ed)]
        tried[name] = {"saving": esb - sa, "low": float(np.quantile(ed, LOW_Q)), "high": float(np.quantile(ed, HIGH_Q)), "cpc_before": esb}
    out.longer_baseline = tried or None
    for name, alt in tried.items():
        if alt["saving"] < out.saving:  # the smaller saving is the one reported
            out.cpc_before, out.saving, out.saving_low, out.saving_high = alt["cpc_before"], alt["saving"], alt["low"], alt["high"]
            out.notes.append(f"the {name} baseline gave a smaller saving, so that one is shown")

    # 5. quality: did the pass rate fall beyond its range?
    nb, na = out.checked_before, out.checked_after
    pb, pa = out.correct_before / nb, out.correct_after / na
    z = z_for(0.95)
    lb_, ub_ = wilson(pb, nb, z)
    la_, ua_ = wilson(pa, na, z)
    out.pass_before, out.pass_after = pb, pa
    # Newcombe's interval for the difference of two proportions
    out.pass_diff_low = (pa - pb) - ((pa - la_) ** 2 + (ub_ - pb) ** 2) ** 0.5
    out.pass_diff_high = (pa - pb) + ((ua_ - pa) ** 2 + (pb - lb_) ** 2) ** 0.5

    # 6. what to call it
    if out.pass_diff_high < 0:
        out.status = "less_correct"
        out.reason = "The share of correct answers fell, so this is not shown as a saving."
    elif out.saving_low > 0:
        out.status = "saving"
    elif out.saving_high < 0:
        out.status = "cost_up"
    else:
        out.status = "no_clear_change"
    return out
