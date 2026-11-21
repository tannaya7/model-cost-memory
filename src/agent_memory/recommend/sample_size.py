"""How many checked answers per model a comparison needs, and what each published figure answers.

The research notes quote several different numbers (1,237, 1,350, 1,774, 2,402 ...). They are not
contradictions: each answers a different question. This module computes every one from its formula so the
figure shown anywhere can be traced to the question it answers (tests/test_sample_size.py reproduces them).

    non_inferiority   "is the cheaper model at most `margin` worse?"  one-sided alpha, our Proven question
                      n = (z(1-alpha) + z(1-beta))^2 (p1 q1 + p2 q2) / (p1 - p2 + margin)^2
                      Chow, Shao & Wang, Sample Size Calculations in Clinical Research (2nd ed. 2008), p. 90
                      (the margin is written here as a positive number of points the candidate may be worse)
    superiority       "do the two models differ at all?"  two-sided alpha, pooled null variance
    paired            the same prompts through both models; needs the share of prompts where they disagree

All are normal approximations for planning, not guarantees: they assume the true rates are the ones given,
independent checked answers, and equal numbers per model. They are NOT what the engine uses to decide; the
engine's rule (stats.assess) works from the observed interval. `needed_per_model` (promising.py) answers a
third question: how many answers until today's observed rates would pass that rule.
"""

from __future__ import annotations

import math
from statistics import NormalDist

_N = NormalDist()


def _z(p: float) -> float:
    return _N.inv_cdf(p)


def non_inferiority(p_candidate: float, p_reference: float, *, margin: float, alpha: float = 0.05,
                    power: float = 0.80) -> int:
    """Per model, one-sided: candidate at most `margin` worse than the reference, at one-sided `alpha`."""
    gap = p_candidate - p_reference + margin
    if gap <= 1e-12:  # on or past the margin (float noise included): no sample size is enough
        raise ValueError("the candidate is already worse than the margin allows: no sample size is enough")
    var = p_candidate * (1 - p_candidate) + p_reference * (1 - p_reference)
    return math.ceil((_z(1 - alpha) + _z(power)) ** 2 * var / gap ** 2)


def superiority(p1: float, p2: float, *, alpha: float = 0.05, power: float = 0.80) -> int:
    """Per model, two-sided: detect that the two rates differ (the usual textbook A/B size)."""
    if p1 == p2:
        raise ValueError("equal rates: there is no difference to detect")
    pbar = (p1 + p2) / 2
    top = _z(1 - alpha / 2) * math.sqrt(2 * pbar * (1 - pbar)) + _z(power) * math.sqrt(p1 * (1 - p1) + p2 * (1 - p2))
    return math.ceil(top ** 2 / (p1 - p2) ** 2)


def paired_superiority(difference: float, discordant: float, *, alpha: float = 0.05, power: float = 0.80) -> int:
    """Prompts needed when both models answer the same prompts (McNemar), two-sided; `discordant` is the share of
    prompts on which exactly one of the two is right."""
    if not 0 < abs(difference) <= discordant <= 1:
        raise ValueError("need 0 < |difference| <= discordant share <= 1")
    top = _z(1 - alpha / 2) * math.sqrt(discordant) + _z(power) * math.sqrt(discordant - difference ** 2)
    return math.ceil(top ** 2 / difference ** 2)
