"""The savings method with no database: finding the change, choosing equal windows, and the statistics and their guards."""

from datetime import date, timedelta

import numpy as np
import pytest

from agent_memory.insights import savings_method as sm

D0 = date(2026, 10, 1)


def days(spec):
    """spec: list of (n_days, {model: calls_per_day}) in order, starting D0."""
    out, d = {}, D0
    for n, mix in spec:
        for _ in range(n):
            out[d] = dict(mix)
            d += timedelta(days=1)
    return out


# ---- finding the change -----------------------------------------------------------------------------------------------

def test_a_change_of_model_is_found_on_its_first_day():
    segs = sm.find_segments(days([(20, {"big": 30}), (20, {"small": 30})]))
    assert [(s.model, s.start, s.end) for s in segs] == [("big", D0, D0 + timedelta(days=19)), ("small", D0 + timedelta(days=20), None)]


def test_one_model_is_no_change():
    assert len(sm.find_segments(days([(30, {"big": 30})]))) == 1


def test_a_blip_of_another_model_is_not_a_change():
    segs = sm.find_segments(days([(10, {"big": 30}), (2, {"small": 30}), (10, {"big": 30})]))
    assert [s.model for s in segs] == ["big"]  # two days is not three


def test_a_new_model_needs_enough_calls_to_count():
    segs = sm.find_segments(days([(10, {"big": 30}), (4, {"small": 5}), (3, {"big": 30})]))  # 20 calls in the run: too few
    assert [s.model for s in segs] == ["big"]


def test_a_split_between_two_models_is_neither_a_change_nor_a_stretch():
    # 60/40 every day for a week, then a clean change: the split week belongs to no segment's start
    segs = sm.find_segments(days([(10, {"big": 30}), (7, {"big": 18, "small": 12}), (10, {"small": 30})]))
    assert [s.model for s in segs] == ["big", "small"]
    assert segs[1].start == D0 + timedelta(days=17)  # the change is dated when the new model really took over


def test_two_changes_make_two_pairs_and_each_stretch_ends_where_the_next_begins():
    segs = sm.find_segments(days([(20, {"a": 30}), (20, {"b": 30}), (20, {"c": 30})]))
    assert [s.model for s in segs] == ["a", "b", "c"]
    assert segs[0].end + timedelta(days=1) == segs[1].start and segs[1].end + timedelta(days=1) == segs[2].start


def test_a_back_and_forth_is_recorded_as_changes_each_time():
    segs = sm.find_segments(days([(15, {"a": 30}), (15, {"b": 30}), (15, {"a": 30})]))
    assert [s.model for s in segs] == ["a", "b", "a"]


# ---- equal windows of whole weeks --------------------------------------------------------------------------------------

def seg(model, start, end=None):
    return sm.Segment(model=model, start=start, end=end)


def test_windows_are_equal_whole_weeks_and_leave_out_the_day_of_the_change():
    switch = D0 + timedelta(days=40)
    win, _ = sm.choose_windows(seg("a", D0, switch - timedelta(days=1)), seg("b", switch), switch + timedelta(days=36), D0)
    assert win.days == 28  # 28 days before the change, the cap
    assert win.after_start == switch + timedelta(days=1) and win.before_end == switch - timedelta(days=1)
    assert (win.before_end - win.before_start).days + 1 == (win.after_end - win.after_start).days + 1 == 28
    assert win.longer_before_start is None


def test_the_window_shrinks_to_whole_weeks_and_waits_below_fourteen_days():
    switch = D0 + timedelta(days=40)
    win, progress = sm.choose_windows(seg("a", D0), seg("b", switch), switch + timedelta(days=18), D0)
    assert win.days == 14  # 17 complete days after: round down to two weeks
    none, progress = sm.choose_windows(seg("a", D0), seg("b", switch), switch + timedelta(days=10), D0)
    assert none is None and progress["days_after"] == 9 and progress["needed"] == 14


def test_only_completed_days_are_used_so_the_answer_cannot_change_as_today_fills_up():
    switch = D0 + timedelta(days=40)
    a, _ = sm.choose_windows(seg("a", D0), seg("b", switch), switch + timedelta(days=30), D0)
    b, _ = sm.choose_windows(seg("a", D0), seg("b", switch), switch + timedelta(days=30), D0)  # the same day, asked again
    assert a == b and a.after_end < switch + timedelta(days=30)


def test_a_longer_baseline_is_offered_only_when_more_history_exists():
    switch = D0 + timedelta(days=40)
    win, _ = sm.choose_windows(seg("a", D0), seg("b", switch), switch + timedelta(days=22), D0)
    assert win.days == 21 and win.longer_before_start == switch - timedelta(days=28)


def test_the_second_stretch_after_a_first_change_does_not_reuse_days_from_before_it():
    s1, s2 = D0 + timedelta(days=30), D0 + timedelta(days=60)
    win, progress = sm.choose_windows(seg("b", s1, s2 - timedelta(days=1)), seg("c", s2), s2 + timedelta(days=40), D0)
    assert win.before_start > s1  # starts after the first change's own day: no overlap with the earlier entry
    assert progress["days_before"] == 29  # the first change's day is left out


# ---- the statistics ---------------------------------------------------------------------------------------------------

def make(rng, n, *, mult=1.0, pass_p=0.9, mix=(0.45, 0.30, 0.18, 0.07), sigma=0.4):
    base = np.array([1.0, 2.5, 6.0, 14.0]) * 0.001
    bucket = rng.choice(4, size=n, p=list(mix))
    return sm.Calls(cost=base[bucket] * mult * rng.lognormal(0, sigma, n), passed=rng.random(n) < pass_p, bucket=bucket,
                    checked=n, calls_total=n)


def test_a_real_saving_is_found_with_a_range_that_holds_the_truth():
    rng = np.random.default_rng(1)
    a = sm.analyse(make(rng, 400), make(rng, 400, mult=0.7), seed=1, boot=800)
    assert a.status == "saving" and a.saving_low > 0 and a.saving_low < a.saving < a.saving_high
    assert a.cpc_after < a.cpc_before


def test_no_change_is_no_clear_change_not_a_saving():
    rng = np.random.default_rng(2)
    a = sm.analyse(make(rng, 400), make(rng, 400), seed=2, boot=800)
    assert a.status == "no_clear_change" and a.saving_low < 0 < a.saving_high


def test_a_cost_increase_is_a_valid_negative_result():
    rng = np.random.default_rng(3)
    a = sm.analyse(make(rng, 400), make(rng, 400, mult=1.4), seed=3, boot=800)
    assert a.status == "cost_up" and a.saving < 0 and a.saving_high < 0


def test_cheaper_but_less_correct_is_never_called_a_saving():
    rng = np.random.default_rng(4)
    a = sm.analyse(make(rng, 400), make(rng, 400, mult=0.6, pass_p=0.7), seed=4, boot=800)
    assert a.status == "less_correct" and a.pass_diff_high < 0 and "not shown as a saving" in a.reason


@pytest.mark.parametrize("n", [20, 60, 99])
def test_too_few_checked_calls_is_not_enough_comparable_data(n):
    rng = np.random.default_rng(5)
    a = sm.analyse(make(rng, n), make(rng, n, mult=0.5), seed=5, boot=300)
    assert a.status == "not_enough_data" and a.saving is None and a.saving_low is None


def test_too_few_correct_answers_is_not_enough_comparable_data():
    rng = np.random.default_rng(6)
    a = sm.analyse(make(rng, 200, pass_p=0.1), make(rng, 200, pass_p=0.1, mult=0.5), seed=6, boot=300)
    assert a.status == "not_enough_data" and "correct answers" in a.reason


def test_calls_with_no_cost_that_are_many_stop_the_figure_and_are_never_counted_as_free():
    rng = np.random.default_rng(7)
    before, after = make(rng, 400), make(rng, 400, mult=0.7)
    after.cost[:80] = np.nan  # 20% of the later checked calls have no price
    a = sm.analyse(before, after, seed=7, boot=300)
    assert a.status == "not_enough_data" and "no cost" in a.reason


def test_a_few_unpriced_calls_are_left_out_and_the_rest_still_gives_a_figure():
    rng = np.random.default_rng(8)
    before, after = make(rng, 400), make(rng, 400, mult=0.7)
    after.cost[:12] = np.nan  # 3%
    a = sm.analyse(before, after, seed=8, boot=500)
    assert a.status == "saving" and a.checked_after == 388


def test_a_shift_in_the_kinds_of_prompts_is_not_counted_as_a_saving():
    rng = np.random.default_rng(9)
    # nothing changed per call, but the later prompts are much bigger, so a naive before/after would say it got costlier
    a = sm.analyse(make(rng, 600), make(rng, 600, mix=(0.15, 0.25, 0.35, 0.25)), seed=9, boot=800)
    assert a.status == "no_clear_change" and a.buckets_used == [0, 1, 2, 3]


def test_prompts_that_do_not_overlap_cannot_be_compared():
    rng = np.random.default_rng(10)
    a = sm.analyse(make(rng, 400, mix=(0.7, 0.3, 0.0, 0.0)), make(rng, 400, mix=(0.0, 0.0, 0.5, 0.5)), seed=10, boot=300)
    assert a.status == "not_enough_data" and "kinds of prompts changed" in a.reason


def test_a_bucket_seen_on_one_side_only_is_dropped_and_the_rest_is_compared():
    rng = np.random.default_rng(11)
    a = sm.analyse(make(rng, 600, mix=(0.5, 0.35, 0.15, 0.0)), make(rng, 600, mix=(0.45, 0.3, 0.2, 0.05), mult=0.7), seed=11, boot=600)
    assert a.buckets_used == [0, 1, 2] and a.mix_covered >= 0.9 and a.status == "saving"


def test_when_the_prompt_text_is_gone_the_mix_cannot_be_compared_so_it_says_so():
    rng = np.random.default_rng(12)
    before, after = make(rng, 400), make(rng, 400, mult=0.7)
    after.bucket[:] = -1
    a = sm.analyse(before, after, seed=12, boot=300)
    assert a.status == "not_enough_data" and "deleted" in a.reason


def test_the_same_data_always_gives_the_same_answer():
    rng = np.random.default_rng(13)
    before, after = make(rng, 400), make(rng, 400, mult=0.8)
    one, two = sm.analyse(before, after, seed=99, boot=600), sm.analyse(before, after, seed=99, boot=600)
    assert (one.saving, one.saving_low, one.saving_high, one.status) == (two.saving, two.saving_low, two.saving_high, two.status)


def test_an_earlier_baseline_that_looks_cheaper_makes_the_smaller_saving_the_one_shown():
    rng = np.random.default_rng(14)
    bad = make(rng, 400, mult=1.25, pass_p=1.0)  # an unusually costly stretch just before the change
    normal = make(rng, 400, pass_p=1.0)
    after = make(rng, 400, pass_p=1.0)  # no real change (every answer correct, so only cost can differ)
    alone = sm.analyse(bad, after, seed=14, boot=800)
    checked = sm.analyse(bad, after, seed=14, boot=800, baselines={"earlier": normal})
    assert alone.status == "saving"  # alone, the bad stretch fakes a saving
    assert checked.status != "saving" and checked.saving < alone.saving
    assert any("earlier baseline" in n for n in checked.notes)


def test_a_saving_that_is_real_survives_the_extra_baselines():
    rng = np.random.default_rng(15)
    before = make(rng, 400)
    a = sm.analyse(before, make(rng, 400, mult=0.65), seed=15, boot=800, baselines={"earlier": make(rng, 400), "longer": make(rng, 800)})
    assert a.status == "saving"


def test_bucket_edges_are_by_prompt_characters():
    assert [sm.bucket_of(n) for n in (0, 999, 1000, 3999, 4000, 15999, 16000, 10**6)] == [0, 0, 1, 1, 2, 2, 3, 3]
    assert sm.bucket_of(None) == -1
