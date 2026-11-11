"""Importance and freshness decay (technical plan 3.4). Pure arithmetic: no model, no database.

    importance = 1.0 + (2.0 if the run FAILED) + min(1.0, cost / the job's mean cost)
    R(t)       = e^(-t / S)            t = days since the run
    S          = max(1.0, importance) x 30 x version_factor
    version_factor = 1.00 while the model version is current, 0.25 once a newer version exists

So evidence about a superseded model version fades about four times faster, and failures and
expensive runs, which are the evidence that matters most, are remembered longer. Runs whose weight
falls below 0.05 are archived (kept, but no longer counted).
"""

from __future__ import annotations

import math
from collections.abc import Iterable
from datetime import datetime

BASE_STABILITY_DAYS = 30.0
SUPERSEDED_FACTOR = 0.25
ARCHIVE_BELOW_WEIGHT = 0.05
SECONDS_PER_DAY = 86_400.0


def importance(outcome: str, cost_usd: float, job_mean_cost: float) -> float:
    """How much a run matters, from what was measured. Between 1.0 and 4.0."""
    cost_part = min(1.0, cost_usd / job_mean_cost) if job_mean_cost > 0 else 0.0
    return 1.0 + (2.0 if outcome == "FAIL" else 0.0) + cost_part


def stability_days(
    importance_score: float,
    *,
    superseded: bool,
    base_days: float = BASE_STABILITY_DAYS,
    superseded_factor: float = SUPERSEDED_FACTOR,
) -> float:
    """S: the number of days over which the run's weight falls to about 37%."""
    return max(1.0, importance_score) * base_days * (superseded_factor if superseded else 1.0)


def age_days(created_at: datetime, now: datetime) -> float:
    return max((now - created_at).total_seconds() / SECONDS_PER_DAY, 0.0)


def freshness(age: float, stability: float) -> float:
    """R(t) = e^(-t/S): 1.0 for a brand-new run, falling towards 0."""
    return math.exp(-max(age, 0.0) / stability)


def archive_age_days(stability: float, threshold: float = ARCHIVE_BELOW_WEIGHT) -> float:
    """The age at which a run with this stability drops below the archive threshold."""
    return -stability * math.log(threshold)


def is_archived(weight: float, threshold: float = ARCHIVE_BELOW_WEIGHT) -> bool:
    return weight < threshold


def weighted_pass_rate(results: Iterable[tuple[float, bool]]) -> float | None:
    """sum(R x passed) / sum(R) over (weight, passed) pairs, or None when there is no weight at all."""
    total = passing = 0.0
    for weight, passed in results:
        total += weight
        if passed:
            passing += weight
    return passing / total if total > 0 else None
