"""Before and after a prompt change: one task's prompt versions side by side.

Versions come from the `prompt_version` the developer sent (tagged). When no tag was sent, they are detected from
the stored prompt text: the start of the prompt must change and the new start must persist for DETECT_RUN
consecutive calls, so a one-off difference never creates a version. Everything here is plain counting; it
describes what changed and never says why or whether the change was good.
"""

from __future__ import annotations

import statistics
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from typing import Literal

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from ..models import Job, Run
from ..recommend.stats import wilson
from .prompts import common_prefix_len

DETECT_RUN = 5  # a new start must show up in this many calls in a row to count
MIN_PREFIX = 40  # the shared start must be at least this many characters to be a start at all
PREFIX_CAP = 600  # characters of each prompt that are looked at
MAX_DETECTED = 6  # more than this means the start changes constantly: we do not claim versions
MAX_RUNS = 5000  # most recent calls read
CHECKED_FLOOR = 25  # checked answers needed before a correct-answer rate is shown (the evidence floor)
MIN_CALLS_COMPARE = 5
OVERLAP_SHARE = 0.10  # versions "ran side by side" when their time ranges overlap by this share of the shorter one
Z95 = 1.959964
NOTICEABLE = 0.05  # smaller changes are described as "about the same"
CACHE_POINTS = 0.10

Source = Literal["tagged", "detected", "none"]


@dataclass
class RunRow:
    created_at: datetime
    prompt_version: str | None
    text: str | None  # stored prompt start; None when retention cleared it
    tokens_in: int
    tokens_out: int
    cache_read: int
    cache_write: int
    cost: float | None
    outcome: str  # PASS / FAIL / UNKNOWN


@dataclass
class Version:
    label: str
    kind: Literal["tagged", "detected", "untagged"]
    first_seen: datetime
    last_seen: datetime
    calls: int
    typical_tokens_in: float
    typical_tokens_out: float
    cache_read_share: float | None
    priced_calls: int
    unpriced_calls: int
    cost_per_call: float | None
    checked: int
    correct_rate: float | None  # None below CHECKED_FLOOR
    rate_low: float | None
    rate_high: float | None
    start_preview: str | None = None


@dataclass
class Comparison:
    older: str
    newer: str
    side_by_side: bool
    summary: str


@dataclass
class VersionsResult:
    source: Source
    reason: str | None  # no_calls, text_not_kept, no_change, unstable; None when versions can be compared
    versions: list[Version] = field(default_factory=list)
    comparison: Comparison | None = None


def normalise(text: str) -> str:
    """Whitespace collapsed so a reformatted prompt is not a different prompt."""
    return " ".join(text.split())[:PREFIX_CAP]


def _stable_start(window: list[str]) -> str | None:
    n = common_prefix_len(window)
    start = window[0][:n].strip()
    return start if len(start) >= MIN_PREFIX else None


def detect_boundaries(texts: list[str]) -> list[tuple[int, str]] | None:
    """Where the start of the prompt changed for good, in call order.

    Returns [(index, start), ...]: the first entry is the first stable start (index 0), later entries are change
    points. A change point needs DETECT_RUN calls in a row that all leave the current start and agree on a new
    one. None when no stable start is found at all.
    """
    w = DETECT_RUN
    first = next((i for i in range(0, len(texts) - w + 1) if _stable_start(texts[i : i + w])), None)
    if first is None:
        return None
    current = _stable_start(texts[first : first + w]) or ""
    out: list[tuple[int, str]] = [(0, current)]
    i = first + w
    while i < len(texts):
        if texts[i].startswith(current):
            i += 1
            continue
        window = texts[i : i + w]
        candidate = _stable_start(window) if len(window) == w else None
        if candidate and not candidate.startswith(current) and not any(t.startswith(current) for t in window):
            out.append((i, candidate))
            current = candidate
            i += w
        else:
            i += 1  # a one-off difference: ignored
    return out


def _median(values: list[int]) -> float:
    return float(statistics.median(values)) if values else 0.0


def _build(label: str, kind: Literal["tagged", "detected", "untagged"], rows: list[RunRow], preview: str | None = None) -> Version:
    priced = [r.cost for r in rows if r.cost is not None]
    cr = sum(r.cache_read for r in rows)
    tin = sum(r.tokens_in for r in rows)
    passed = sum(1 for r in rows if r.outcome == "PASS")
    checked = passed + sum(1 for r in rows if r.outcome == "FAIL")
    rate = low = high = None
    if checked >= CHECKED_FLOOR:
        rate = passed / checked
        low, high = wilson(rate, checked, Z95)
    times = [r.created_at for r in rows]
    return Version(
        label=label, kind=kind, first_seen=min(times), last_seen=max(times), calls=len(rows),
        typical_tokens_in=_median([r.tokens_in for r in rows]), typical_tokens_out=_median([r.tokens_out for r in rows]),
        cache_read_share=cr / (cr + tin) if cr + tin else None,
        priced_calls=len(priced), unpriced_calls=len(rows) - len(priced),
        cost_per_call=sum(priced) / len(priced) if priced else None,
        checked=checked, correct_rate=rate, rate_low=low, rate_high=high, start_preview=preview,
    )


def ran_side_by_side(a: Version, b: Version) -> bool:
    start, end = max(a.first_seen, b.first_seen), min(a.last_seen, b.last_seen)
    if end <= start:
        return False
    shorter = min(a.last_seen - a.first_seen, b.last_seen - b.first_seen).total_seconds()
    return shorter > 0 and (end - start).total_seconds() >= OVERLAP_SHARE * shorter


def _change(old: float, new: float) -> float | None:
    return (new - old) / old if old else None


def _clause(change: float | None, what: str, up: str, down: str) -> str | None:
    """'about 32% fewer input tokens' / 'about the same ...'; None when there is nothing to compare."""
    if change is None:
        return None
    if abs(change) < NOTICEABLE:
        return f"about the same {what}"
    return f"about {round(abs(change) * 100)}% {down if change < 0 else up} {what}"


def summarise(old: Version, new: Version) -> str:
    """Plain sentences from the numbers only. No verdicts, no causes."""
    if min(old.calls, new.calls) < MIN_CALLS_COMPARE:
        return f"One of these versions has fewer than {MIN_CALLS_COMPARE} calls so far, so there is too little to compare."
    sentences: list[str] = []
    inp = _clause(_change(old.typical_tokens_in, new.typical_tokens_in), "input tokens", "more", "fewer")
    out = _clause(_change(old.typical_tokens_out, new.typical_tokens_out), "output tokens", "more", "fewer")
    if inp:
        sentences.append(f"{new.label} sends {inp} than {old.label}." if "about the same" not in inp else f"{new.label} sends {inp} as {old.label}.")
    if out:
        sentences.append(f"It gets back {out}.")
    if old.cache_read_share is not None and new.cache_read_share is not None:
        d = new.cache_read_share - old.cache_read_share
        if abs(d) >= CACHE_POINTS:
            sentences.append(f"The cached share went {'up' if d > 0 else 'down'} from {old.cache_read_share:.0%} to {new.cache_read_share:.0%}.")
    if old.cost_per_call is not None and new.cost_per_call is not None:
        change = _change(old.cost_per_call, new.cost_per_call)
        if change is not None and abs(change) < NOTICEABLE:
            sentences.append("The list-price cost per call is about the same.")
        elif change is not None:
            sentences.append(f"The list-price cost per call is about {round(abs(change) * 100)}% {'lower' if change < 0 else 'higher'}.")
    if old.correct_rate is None or new.correct_rate is None:
        sentences.append("There are not enough checked answers yet to compare correct answers.")
    elif max(old.rate_low or 0, new.rate_low or 0) <= min(old.rate_high or 1, new.rate_high or 1):
        n = min(old.checked, new.checked)
        tail = f", but only {n} were checked" if n < 100 else f", from {old.checked} and {new.checked} checked answers"
        sentences.append(f"Correct answers look about the same{tail}.")
    else:
        sentences.append(
            f"Correct answers differ: {old.correct_rate:.0%} for {old.label} and {new.correct_rate:.0%} for {new.label}, "
            f"from {old.checked} and {new.checked} checked answers."
        )
    return " ".join(sentences)


def _compare(versions: list[Version]) -> Comparison | None:
    ordered = sorted(versions, key=lambda v: v.first_seen)
    if len(ordered) < 2:
        return None
    old, new = ordered[-2], ordered[-1]
    return Comparison(older=old.label, newer=new.label, side_by_side=ran_side_by_side(old, new), summary=summarise(old, new))


def _same_start(a: str, b: str) -> bool:
    return a.startswith(b) or b.startswith(a)


def build_versions(rows: list[RunRow]) -> VersionsResult:
    """Pure: calls in any order -> versions side by side."""
    rows = sorted(rows, key=lambda r: r.created_at)
    if not rows:
        return VersionsResult("none", "no_calls")

    tags = list(dict.fromkeys(r.prompt_version for r in rows if r.prompt_version))
    if tags:
        versions = [_build(f"Version {t}", "tagged", [r for r in rows if r.prompt_version == t]) for t in tags]
        untagged = [r for r in rows if not r.prompt_version]
        if untagged:
            versions.append(_build("No version tag", "untagged", untagged))
        versions.sort(key=lambda v: v.first_seen)
        tagged = [v for v in versions if v.kind == "tagged"]
        return VersionsResult("tagged", None if len(tagged) > 1 else "no_change", versions, _compare(tagged))

    texted = [r for r in rows if r.text]
    if not texted:
        return VersionsResult("none", "text_not_kept")
    found = detect_boundaries([normalise(r.text or "") for r in texted])
    if not found or len(found) < 2:
        return VersionsResult("none", "no_change")

    # the same start coming back later is the same version (A, B, A is two versions)
    starts: list[str] = []
    slot: list[int] = []
    for _, start in found:
        match = next((n for n, s in enumerate(starts) if _same_start(start, s)), None)
        if match is None:
            starts.append(start)
            match = len(starts) - 1
        slot.append(match)
    if len(starts) > MAX_DETECTED:
        return VersionsResult("none", "unstable")
    cuts = [texted[i].created_at for i, _ in found]
    cuts[0] = rows[0].created_at  # calls before the first stable start belong to the first version
    grouped: dict[int, list[RunRow]] = {}
    for r in rows:
        at = max(n for n, c in enumerate(cuts) if r.created_at >= c)
        grouped.setdefault(slot[at], []).append(r)
    out = []
    for n in sorted(grouped, key=lambda k: min(r.created_at for r in grouped[k])):
        s = starts[n]
        preview = s if len(s) <= 120 else s[:119].rstrip() + "…"
        out.append(_build(f"Detected version {len(out) + 1}", "detected", grouped[n], preview))
    if len(out) < 2:
        return VersionsResult("none", "no_change")
    return VersionsResult("detected", None, out, _compare(out))


async def prompt_versions(
    session: AsyncSession, project_id: str, job: str, *, days: int = 30, now: datetime | None = None,
) -> VersionsResult | None:
    """None when the job does not exist in this project."""
    job_id = (await session.execute(select(Job.job_id).where(Job.project_id == project_id, Job.name == job))).scalar_one_or_none()
    if job_id is None:
        return None
    since = (now or datetime.now(UTC)) - timedelta(days=days)
    q = (
        select(Run.created_at, Run.prompt_version, func.substr(Run.prompt, 1, PREFIX_CAP * 2), Run.tokens_in, Run.tokens_out,
               Run.cache_read_tokens, Run.cache_write_tokens, Run.cost_usd, Run.outcome)
        .where(Run.project_id == project_id, Run.job_id == job_id, Run.run_kind == "PRODUCTION", Run.created_at >= since)
        .order_by(Run.created_at.desc()).limit(MAX_RUNS)
    )
    rows = [
        RunRow(c, v, t, int(ti or 0), int(to or 0), int(cr or 0), int(cw or 0), float(cost) if cost is not None else None, o)
        for c, v, t, ti, to, cr, cw, cost, o in (await session.execute(q)).all()
    ]
    return build_versions(rows)
