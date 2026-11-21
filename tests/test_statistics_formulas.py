"""Formula and boundary tests for the statistics behind the recommendation: sample sizes (each published figure traced
to the question it answers), Newcombe's paired and unpaired intervals, Wilson, Kish, and the exact edges of the rule.

Simulations here check that a FORMULA does what it claims (power, coverage). They are never user evidence."""

import math

import numpy as np
import pytest

from agent_memory.recommend import sample_size as ss
from agent_memory.recommend.stats import Sample, assess, difference, paired_difference, sample, wilson, z_for

Z95, Z99 = z_for(0.95), z_for(0.99)


# --- sample sizes: one number per question, reproducible ------------------------------------------------------

@pytest.mark.parametrize(("p", "alpha", "expected"), [
    (0.90, 0.05, 1237), (0.95, 0.05, 653), (0.98, 0.05, 270), (0.90, 0.01, 2008), (0.95, 0.01, 1060),
])
def test_non_inferiority_sizes_are_the_ones_for_our_question(p, alpha, expected):
    """'at most 3 points worse', one-sided, 80% power, equal true rates (Chow, Shao & Wang 2008, p. 90)."""
    assert ss.non_inferiority(p, p, margin=0.03, alpha=alpha) == expected


@pytest.mark.parametrize(("p1", "p2", "expected"), [(0.90, 0.87, 1774), (0.90, 0.85, 686), (0.85, 0.80, 906), (0.85, 0.82, 2402)])
def test_superiority_sizes_answer_a_different_question(p1, p2, expected):
    """'do they differ at all', two-sided: why 1,774 and 1,237 are both right for 90% and 3 points."""
    assert ss.superiority(p1, p2) == expected


@pytest.mark.parametrize(("d", "disagree", "expected"), [(0.03, 0.10, 870), (0.03, 0.20, 1742), (0.05, 0.10, 312), (0.05, 0.20, 626)])
def test_paired_sizes_need_far_fewer_prompts_when_models_mostly_agree(d, disagree, expected):
    assert ss.paired_superiority(d, disagree) == expected


def test_sample_size_is_monotone_and_rejects_impossible_questions():
    assert ss.non_inferiority(0.9, 0.9, margin=0.05) < ss.non_inferiority(0.9, 0.9, margin=0.03)  # wider margin, fewer
    assert ss.non_inferiority(0.9, 0.9, margin=0.03, power=0.9) > ss.non_inferiority(0.9, 0.9, margin=0.03)
    assert ss.non_inferiority(0.95, 0.9, margin=0.03) < ss.non_inferiority(0.9, 0.9, margin=0.03)  # better candidate, fewer
    with pytest.raises(ValueError):
        ss.non_inferiority(0.80, 0.90, margin=0.03)  # already worse than the margin: no n is enough
    with pytest.raises(ValueError):
        ss.non_inferiority(0.80, 0.83, margin=0.03)  # exactly on the margin: infinite n
    with pytest.raises(ValueError):
        ss.superiority(0.9, 0.9)
    with pytest.raises(ValueError):
        ss.paired_superiority(0.2, 0.1)  # cannot differ by more than they disagree


def test_the_non_inferiority_size_reaches_about_eighty_percent_power():
    """Simulation of the FORMULA: at n = 1,237 per model and truly equal rates the one-sided test passes ~80%."""
    rng = np.random.default_rng(20261118)
    n, reps, p = 1237, 4000, 0.90
    a, b = rng.binomial(n, p, reps) / n, rng.binomial(n, p, reps) / n
    se = np.sqrt(a * (1 - a) / n + b * (1 - b) / n)
    power = float(np.mean((a - b + 0.03) / se > 1.6449))
    assert power == pytest.approx(0.80, abs=0.03)


# --- Wilson, Kish, and the edges of the rule -------------------------------------------------------------------

def test_wilson_edges():
    assert wilson(0.0, 10, Z95)[0] == pytest.approx(0.0, abs=1e-12) and 0.2 < wilson(0.0, 10, Z95)[1] < 0.35
    assert wilson(1.0, 10, Z95)[1] == 1.0
    low, high = wilson(0.5, 1, Z95)
    assert 0.0 <= low < 0.5 < high <= 1.0
    assert wilson(0.5, 1e-9, Z95)[0] >= 0.0
    narrow = wilson(0.9, 4000, Z95)
    wide = wilson(0.9, 40, Z95)
    assert narrow[1] - narrow[0] < wide[1] - wide[0]
    assert wilson(0.9, 100, Z99)[0] < wilson(0.9, 100, Z95)[0]  # more confidence, wider


def test_kish_effective_n_edges():
    assert sample([(1.0, True)] * 7).effective_n == 7
    assert sample([(0.5, True)] * 8).effective_n == pytest.approx(8)  # equal weights lose nothing
    s = sample([(1.0, True), (1e-6, False)])
    assert s.effective_n == pytest.approx(1.0, abs=1e-5)  # one run dominates: the other adds almost nothing
    assert s.effective_n <= len([1, 2])
    assert sample([(0.0, True)]) is None  # zero total weight is no evidence


def test_the_tolerance_rule_flips_exactly_at_the_margin():
    cand, ref = Sample(0.95, 600, 600), Sample(0.95, 600, 600)
    low, high = difference(cand, ref, Z95)
    assert assess(cand, ref, margin=-low, z=Z95) == "GOOD_ENOUGH"  # low == -margin passes
    assert assess(cand, ref, margin=-low + 1e-9, z=Z95) == "GOOD_ENOUGH"
    assert assess(cand, ref, margin=-low - 1e-9, z=Z95) == "UNSURE"
    worse = Sample(0.80, 600, 600)
    lo, hi = difference(worse, ref, Z95)
    assert assess(worse, ref, margin=-hi, z=Z95) == "UNSURE"  # high == -margin is not yet 'clearly worse'
    assert assess(worse, ref, margin=-hi - 1e-9, z=Z95) == "CLEARLY_WORSE"


def test_overlapping_model_ranges_are_not_a_tie():
    """Two models whose own ranges overlap can still differ clearly; and no overlap-based tie is ever inferred."""
    a, b = Sample(0.80, 150, 150), Sample(0.90, 150, 150)
    la, ha = wilson(a.pass_rate, a.effective_n, Z95)
    lb, hb = wilson(b.pass_rate, b.effective_n, Z95)
    assert ha > lb  # the per-model ranges overlap
    low, high = difference(b, a, Z95)
    assert low > 0  # yet the difference excludes zero (Newcombe), so they do differ


# --- Newcombe's paired interval ---------------------------------------------------------------------------------

def test_paired_interval_basics():
    assert paired_difference(0, 0, 0, 0, Z95) == (-1.0, 1.0)  # nothing paired: anything is possible
    low, high = paired_difference(80, 10, 4, 6, Z95)
    delta = (10 - 4) / 100
    assert low < delta < high and -1 <= low and high <= 1
    nl, nh = paired_difference(80, 4, 10, 6, Z95)  # swapping the models mirrors the interval
    assert (nl, nh) == pytest.approx((-high, -low), abs=1e-12)
    with pytest.raises(ValueError):
        paired_difference(5, -1, 2, 3, Z95)


def test_pairing_is_narrower_than_ignoring_it_when_models_agree_on_which_prompts_are_hard():
    both, only1, only2, neither = 160, 12, 8, 20  # mostly agree; correlation is strongly positive
    n = both + only1 + only2 + neither
    paired = paired_difference(both, only1, only2, neither, Z95)
    p1, p2 = (both + only1) / n, (both + only2) / n
    unpaired = difference(Sample(p1, n, n), Sample(p2, n, n), Z95)
    assert (paired[1] - paired[0]) < (unpaired[1] - unpaired[0])


def test_identical_answers_give_a_zero_gap_and_a_tight_interval():
    low, high = paired_difference(90, 0, 0, 10, Z95)
    assert low < 0 < high and high - low < 0.1


def test_paired_interval_covers_the_true_gap_about_as_often_as_claimed():
    """Simulation of the FORMULA: 95% intervals cover the true paired difference at least ~93% of the time."""
    rng = np.random.default_rng(7)
    n, reps = 150, 3000
    probs = np.array([0.78, 0.10, 0.04, 0.08])  # both, only first, only second, neither
    truth = probs[1] - probs[2]
    covered = 0
    for row in rng.multinomial(n, probs, reps):
        low, high = paired_difference(*(int(x) for x in row), Z95)
        covered += low <= truth <= high
    assert covered / reps >= 0.93


def test_unpaired_interval_covers_about_as_often_as_claimed():
    rng = np.random.default_rng(11)
    n, reps = 120, 3000
    p1, p2 = 0.92, 0.88
    covered = 0
    for x, y in zip(rng.binomial(n, p1, reps), rng.binomial(n, p2, reps), strict=True):
        low, high = difference(Sample(x / n, n, n), Sample(y / n, n, n), Z95)
        covered += low <= p1 - p2 <= high
    assert covered / reps >= 0.93
    assert math.isfinite(covered)
