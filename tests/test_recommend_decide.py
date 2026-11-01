"""The verdict rules, without a database. Model names and prices are made up."""

from datetime import date

from agent_memory.recommend.engine import ModelInput, decide
from agent_memory.recommend.stats import Sample

RULES = dict(floor=25.0, margin=0.03, confidence=0.95)


def model(name, p, n, cost, status="ACTIVE", shutdown=None):
    s = Sample(pass_rate=p, effective_n=n, evidence_weight=n) if n else None
    return ModelInput(model=name, model_version=f"{name}-2026-09", n_runs=n, failures=round(n * (1 - p)), sample=s,
                      mean_cost_usd=cost, catalog_status=status, shutdown_date=shutdown)


def by_name(decision):
    return {m.model: m for m in decision.models}


def test_below_the_floor_it_refuses_and_reports_progress():
    d = decide([model("big", 1.0, 10, 0.03), model("mini", 1.0, 5, 0.001)], "big", **RULES)
    assert d.verdict == "INSUFFICIENT_EVIDENCE"
    assert d.recommended is None
    assert d.progress == 10 / 25
    assert by_name(d)["big"].status == "BELOW_FLOOR"


def test_a_cheaper_model_that_is_good_enough_is_a_downgrade():
    d = decide([model("big", 0.99, 400, 0.03), model("mini", 0.99, 400, 0.001)], "big", **RULES)
    assert (d.verdict, d.recommended.model, d.current.model) == ("DOWNGRADE", "mini", "big")
    assert by_name(d)["mini"].cost_per_success_usd == 0.001 / 0.99


def test_keeping_the_cheapest_good_model_is_a_hold():
    d = decide([model("big", 0.99, 400, 0.03), model("mini", 0.99, 400, 0.001)], "mini", **RULES)
    assert (d.verdict, d.recommended.model) == ("HOLD", "mini")
    assert d.warnings == []


def test_a_current_model_that_is_clearly_worse_is_a_switch_even_to_a_dearer_one():
    d = decide([model("big", 0.99, 400, 0.03), model("mini", 0.80, 400, 0.001)], "mini", **RULES)
    assert (d.verdict, d.recommended.model) == ("SWITCH", "big")
    assert by_name(d)["mini"].status == "CLEARLY_WORSE"


def test_cost_per_success_stops_a_cheap_model_that_fails_often_from_winning():
    # 'flaky' is cheaper per run, but failing more makes it dearer per success.
    d = decide([model("solid", 0.99, 2000, 0.0100), model("flaky", 0.97, 2000, 0.0098)], "solid", **RULES)
    assert by_name(d)["flaky"].status == "GOOD_ENOUGH"
    assert (d.verdict, d.recommended.model) == ("HOLD", "solid")


def test_a_retired_model_is_never_recommended_and_forces_a_switch():
    d = decide([model("old", 1.0, 400, 0.0001, status="RETIRED"), model("new", 0.99, 400, 0.002)], "old", **RULES)
    assert (d.verdict, d.recommended.model) == ("SWITCH", "new")
    assert not by_name(d)["old"].eligible


def test_an_unpriced_model_cannot_be_compared_on_cost():
    d = decide([model("big", 0.99, 400, 0.03), model("local", 0.99, 400, None)], "big", **RULES)
    assert (d.verdict, d.recommended.model) == ("HOLD", "big")
    assert "no price is known" in by_name(d)["local"].why


def test_when_unsure_about_the_current_model_it_holds_and_says_why():
    d = decide([model("big", 0.99, 400, 0.03), model("mini", 0.97, 60, 0.001)], "mini", **RULES)
    assert by_name(d)["mini"].status == "UNSURE"
    assert (d.verdict, d.recommended.model) == ("HOLD", "mini")
    assert "Not yet sure mini" in d.warnings[0]


def test_cheaper_models_without_enough_evidence_are_re_test_candidates():
    d = decide([model("big", 0.99, 400, 0.03), model("mini", 1.0, 10, 0.001)], "big", **RULES)
    assert d.verdict == "HOLD"
    assert d.retest_candidates == ["mini"]
    assert d.next_step.startswith("Re-test mini")


def test_a_deprecated_recommendation_warns_and_names_the_next_cheapest():
    d = decide(
        [model("big", 0.99, 400, 0.03), model("mid", 0.99, 400, 0.01),
         model("mini", 0.99, 400, 0.001, status="DEPRECATED", shutdown=date(2026, 12, 1))],
        "big", **RULES,
    )
    assert (d.verdict, d.recommended.model) == ("DOWNGRADE", "mini")
    assert d.warnings == ["mini is deprecated and shuts down on 2026-12-01",
                          "The next cheapest model that qualifies is mid"]


def test_without_production_runs_there_is_no_current_model_to_compare():
    d = decide([model("big", 0.99, 400, 0.03)], None, **RULES)
    assert d.verdict == "INSUFFICIENT_EVIDENCE"
    assert d.recommended.model == "big"


def test_a_cheaper_model_must_be_shown_within_the_margin_of_the_current_one_before_a_downgrade():
    # 30 lucky runs make 'mini' the reference, but nothing shows it is within 3 points of 'big', the model
    # in use. Downgrading on that was the gamble the held-out check caught.
    d = decide([model("big", 0.96, 30, 0.03), model("mini", 1.0, 30, 0.001)], "big", **RULES)
    assert d.reference.model == "mini"
    assert (d.verdict, d.recommended.model) == ("HOLD", "big")
    assert d.warnings == ["Not yet sure mini is within 3 points of big, the model in use; a re-test of mini "
                          "would settle it"]
    assert d.retest_candidates == ["mini"]
    assert d.next_step == "Re-test mini to settle whether to switch"
    # Not "good enough": that is next to itself as the reference, not next to the model in use.
    mini = by_name(d)["mini"]
    assert (mini.status, mini.eligible) == ("UNSURE", False)
    assert mini.why == "Not yet sure it is within 3 points of big, the model in use; a re-test would settle it"


def test_a_current_model_that_measures_well_below_the_best_asks_for_a_re_test_of_the_best():
    # 7 points behind, but with 100 and 200 runs that is not yet proven to be more than 3.
    d = decide([model("big", 0.97, 100, 0.03), model("mini", 0.90, 200, 0.001)], "mini", **RULES)
    assert by_name(d)["mini"].status == "UNSURE"
    assert (d.verdict, d.recommended.model) == ("HOLD", "mini")
    assert d.warnings == ["mini measures 7.0 points below big, not yet proven; a re-test of big will show "
                          "whether to switch"]
    assert d.retest_candidates == ["big"]
