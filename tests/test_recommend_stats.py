"""Intervals and the tolerance rule: pure arithmetic, no database."""

import pytest

from agent_memory.recommend.stats import Sample, assess, difference, sample, wilson, z_for

Z95 = z_for(0.95)


def equal(p, n):
    return Sample(pass_rate=p, effective_n=n, evidence_weight=n)


def test_z_for_95_percent_is_1_96():
    assert Z95 == pytest.approx(1.95996, abs=1e-5)
    assert z_for(0.99) == pytest.approx(2.5758, abs=1e-4)


def test_wilson_matches_the_textbook_value_and_stays_inside_0_to_1():
    assert wilson(0.5, 100, Z95) == pytest.approx((0.4038, 0.5962), abs=1e-4)
    low, high = wilson(1.0, 20, Z95)
    assert high == 1.0 and 0.8 < low < 0.85  # all passed, yet not certain
    assert wilson(0.9, 0, Z95) == (0.0, 1.0)  # no evidence: anything is possible


def test_effective_sample_size_shrinks_when_weights_are_uneven():
    even = sample([(1.0, True)] * 10)
    assert (even.pass_rate, even.effective_n, even.evidence_weight) == (1.0, 10.0, 10.0)
    uneven = sample([(1.0, True)] * 5 + [(0.1, False)] * 5)
    assert uneven.pass_rate == pytest.approx(5 / 5.5)
    assert uneven.effective_n == pytest.approx(5.5**2 / 5.05)  # fewer than 10: old runs say less
    assert sample([]) is None


def test_difference_contains_the_observed_gap():
    low, high = difference(equal(0.90, 200), equal(0.95, 200), Z95)
    assert low < -0.05 < high


@pytest.mark.parametrize(
    ("candidate", "reference", "expected"),
    [
        (equal(0.99, 400), equal(0.99, 400), "GOOD_ENOUGH"),  # same quality, plenty of runs
        (equal(0.99, 40), equal(0.99, 40), "UNSURE"),  # same quality, too few runs to be sure
        (equal(0.80, 400), equal(0.99, 400), "CLEARLY_WORSE"),
        (equal(0.95, 100), equal(0.99, 100), "UNSURE"),  # might be within 3 points, might not
    ],
)
def test_assess_has_three_answers(candidate, reference, expected):
    assert assess(candidate, reference, margin=0.03, z=Z95) == expected


def test_a_wider_margin_qualifies_sooner():
    candidate, reference = equal(0.95, 170), equal(0.95, 170)
    assert assess(candidate, reference, margin=0.03, z=Z95) == "UNSURE"
    assert assess(candidate, reference, margin=0.05, z=Z95) == "GOOD_ENOUGH"
