"""Confidence intervals for freshness-weighted pass rates, and the tolerance rule (technical plan 3.4).

Runs carry a freshness weight R(t), so a model's pass rate is a weighted mean. Its uncertainty uses
the Kish effective sample size, (sum w)^2 / sum w^2: 100 fresh runs count as 100, while 100 runs at
mixed ages count as fewer.

    interval        Wilson score interval at the configured confidence (default 95%), which stays
                    inside 0..1 and behaves well near 100%, where pass rates usually sit
    difference      Newcombe's hybrid score interval for p(candidate) - p(reference), built from the
                    two Wilson intervals

The tolerance rule is a non-inferiority test with a margin: a candidate is GOOD_ENOUGH when we are
confident it is at most `margin` worse than the reference, CLEARLY_WORSE when we are confident it is
more than `margin` worse, and UNSURE otherwise. UNSURE is what a re-test is for. A margin is needed
because two equally good models always have overlapping intervals, so "proven at least as good"
would never be reached. `assess` is the one place the rule lives, so it can be swapped.
"""

from __future__ import annotations

import math
from collections.abc import Iterable
from dataclasses import dataclass
from statistics import NormalDist
from typing import Literal

Assessment = Literal["GOOD_ENOUGH", "UNSURE", "CLEARLY_WORSE"]


@dataclass(frozen=True)
class Sample:
    """A freshness-weighted pass rate with its effective sample size."""

    pass_rate: float
    effective_n: float
    evidence_weight: float


def z_for(confidence: float) -> float:
    """The two-sided normal quantile: 1.96 for 95%."""
    return NormalDist().inv_cdf(1 - (1 - confidence) / 2)


def sample(results: Iterable[tuple[float, bool]]) -> Sample | None:
    """From (weight, passed) pairs; None when there is no weight at all."""
    total = squares = passing = 0.0
    for weight, passed in results:
        total += weight
        squares += weight * weight
        if passed:
            passing += weight
    if total <= 0:
        return None
    return Sample(pass_rate=passing / total, effective_n=total * total / squares, evidence_weight=total)


def wilson(p: float, n: float, z: float) -> tuple[float, float]:
    """Wilson score interval for a proportion p observed over n (possibly fractional) trials."""
    if n <= 0:
        return 0.0, 1.0
    z2 = z * z
    centre = (p + z2 / (2 * n)) / (1 + z2 / n)
    half = z * math.sqrt(p * (1 - p) / n + z2 / (4 * n * n)) / (1 + z2 / n)
    return max(0.0, centre - half), min(1.0, centre + half)


def difference(candidate: Sample, reference: Sample, z: float) -> tuple[float, float]:
    """Newcombe's interval for candidate.pass_rate - reference.pass_rate."""
    p1, p2 = candidate.pass_rate, reference.pass_rate
    l1, u1 = wilson(p1, candidate.effective_n, z)
    l2, u2 = wilson(p2, reference.effective_n, z)
    d = p1 - p2
    return d - math.hypot(p1 - l1, u2 - p2), d + math.hypot(u1 - p1, p2 - l2)


def assess(candidate: Sample, reference: Sample, *, margin: float, z: float) -> Assessment:
    """The tolerance rule: is the candidate good enough compared with the reference?"""
    low, high = difference(candidate, reference, z)
    if low >= -margin:
        return "GOOD_ENOUGH"
    if high < -margin:
        return "CLEARLY_WORSE"
    return "UNSURE"
