"""Importance and decay arithmetic (no database needed). Tests prove the properties the plan claims."""

import math
from datetime import UTC, datetime, timedelta

import pytest
from hypothesis import given
from hypothesis import strategies as st

from agent_memory.pipeline.scoring import (
    age_days,
    archive_age_days,
    freshness,
    importance,
    is_archived,
    stability_days,
    weighted_pass_rate,
)


def test_importance_is_one_for_a_cheap_pass_and_up_to_four_for_a_costly_failure():
    assert importance("PASS", 0.0, 0.01) == 1.0
    assert importance("PASS", 0.01, 0.01) == 2.0  # as costly as the job's average
    assert importance("PASS", 0.05, 0.01) == 2.0  # the cost part is capped at 1.0
    assert importance("FAIL", 0.0, 0.01) == 3.0
    assert importance("FAIL", 0.05, 0.01) == 4.0
    assert importance("UNKNOWN", 0.005, 0.01) == 1.5


def test_a_job_with_no_cost_history_adds_no_cost_weight():
    assert importance("PASS", 0.5, 0.0) == 1.0


def test_stability_is_thirty_days_for_an_ordinary_current_run():
    assert stability_days(1.0, superseded=False) == 30.0
    assert stability_days(0.2, superseded=False) == 30.0  # never below one unit of importance


def test_evidence_about_a_superseded_version_fades_four_times_faster():
    for imp in (1.0, 2.5, 4.0):
        assert stability_days(imp, superseded=True) * 4 == pytest.approx(stability_days(imp, superseded=False))


def test_worked_examples_from_the_plan():
    current, old = stability_days(1.0, superseded=False), stability_days(1.0, superseded=True)
    assert (current, old) == (30.0, 7.5)
    assert freshness(0, current) == 1.0
    assert freshness(30, current) == pytest.approx(math.exp(-1))  # about 0.368
    assert freshness(7.5, old) == pytest.approx(math.exp(-1))  # a superseded version reaches it in a quarter of the time
    assert freshness(60, current) == pytest.approx(0.1353, abs=1e-4)


def test_runs_are_archived_at_about_three_times_the_stability():
    assert archive_age_days(30.0) == pytest.approx(89.87, abs=0.01)  # a current run: about 90 days
    assert archive_age_days(7.5) == pytest.approx(22.47, abs=0.01)  # a superseded one: about 22 days
    assert is_archived(freshness(91, 30.0)) and not is_archived(freshness(89, 30.0))


def test_age_is_measured_in_days_and_is_never_negative():
    now = datetime(2026, 10, 14, tzinfo=UTC)
    assert age_days(now - timedelta(days=2, hours=12), now) == 2.5
    assert age_days(now + timedelta(days=1), now) == 0.0


def test_the_weighted_pass_rate_lets_recent_evidence_dominate():
    # an old pass (weight 0.135) against a fresh failure (weight 1.0): a plain average says 50%
    assert weighted_pass_rate([(0.1353, True), (1.0, False)]) == pytest.approx(0.1192, abs=1e-3)
    # the same old pass about a superseded version (about 0.0003) is as good as gone
    assert weighted_pass_rate([(0.0003, True), (1.0, False)]) < 0.001


def test_no_weight_means_no_pass_rate():
    assert weighted_pass_rate([]) is None
    assert weighted_pass_rate([(0.0, True)]) is None


@given(st.floats(0, 4000), st.floats(0, 4000), st.floats(1, 360))
def test_freshness_never_increases_with_age(a, b, stability):
    older, newer = max(a, b), min(a, b)
    assert 0.0 <= freshness(older, stability) <= freshness(newer, stability) <= 1.0


@given(st.sampled_from(["PASS", "FAIL", "UNKNOWN"]), st.floats(0, 1000), st.floats(0.0001, 1000))
def test_importance_stays_within_its_range(outcome, cost, mean):
    assert 1.0 <= importance(outcome, cost, mean) <= 4.0


@given(st.floats(1.0, 4.0), st.booleans())
def test_a_higher_importance_is_never_remembered_for_less_time(imp, superseded):
    assert stability_days(imp + 0.5, superseded=superseded) >= stability_days(imp, superseded=superseded)
