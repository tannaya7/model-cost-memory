"""The held-out check: scoring the engine's pick on prompts it never saw. Models and prices are made up."""

import uuid

import pytest

from agent_memory.corpus import generate_invoices
from agent_memory.ingest import prompt_hash
from agent_memory.models import Job, Project, Run
from agent_memory.recommend.holdout import (
    Outcome,
    SimulatedModel,
    evaluate,
    load_outcomes,
    paired_prompts,
    pick_from,
    simulated_outcomes,
)


def outcomes(rates_and_costs, n=200):
    """Each model passes the first rate x n prompts, at a fixed cost per run."""
    return {
        name: {f"p{i}": Outcome(i < rate * n, cost) for i in range(n)}
        for name, (rate, cost) in rates_and_costs.items()
    }


def test_only_prompts_every_model_answered_are_used():
    data = {"a": {"p1": Outcome(True, 1.0), "p2": Outcome(True, 1.0)}, "b": {"p2": Outcome(False, 1.0)}}
    assert paired_prompts(data) == ["p2"]


def test_the_right_answer_is_the_cheapest_per_success_within_the_margin():
    rates = {"big": 0.98, "mid": 0.96, "mini": 0.90}
    costs = {"big": 0.03, "mid": 0.01, "mini": 0.001}
    right, _, cps = pick_from(rates, costs, 0.03)
    assert right == "mid"  # mini is cheapest but 8 points behind
    assert cps["mid"] == pytest.approx(0.01 / 0.96)


def test_identical_models_are_always_a_safe_pick_and_the_cheap_one_is_found_with_enough_evidence():
    data = outcomes({"big": (0.98, 0.03), "mini": (0.98, 0.001)}, n=1000)
    truth = ({"big": 0.98, "mini": 0.98}, {"big": 0.03, "mini": 0.001})
    [small, large] = evaluate(data, "big", evidence_sizes=(25, 400), splits=50, truth=truth)
    assert small.safe_rate == large.safe_rate == 1.0
    assert large.exact_rate > small.exact_rate
    assert large.saving_captured == pytest.approx(large.exact_rate)  # every exact pick realises the whole saving


def test_an_unknown_current_model_or_too_few_prompts_is_refused():
    data = outcomes({"big": (0.98, 0.03)}, n=200)
    with pytest.raises(ValueError, match="current model"):
        evaluate(data, "nope")
    with pytest.raises(ValueError, match="at least 20"):
        evaluate(outcomes({"big": (0.98, 0.03)}, n=10), "big")


def test_simulated_answers_follow_each_models_accuracy_and_report_the_truth():
    invoices = generate_invoices(300, seed=1)
    perfect = SimulatedModel("perfect", {"easy": 1.0, "medium": 1.0, "hard": 1.0}, 1.0, 2.0)
    never = SimulatedModel("never", {"easy": 0.0, "medium": 0.0, "hard": 0.0}, 0.1, 0.2)
    data, (rates, costs) = simulated_outcomes(invoices, [perfect, never], seed=3)
    assert all(o.passed for o in data["perfect"].values()) and not any(o.passed for o in data["never"].values())
    assert rates == {"perfect": 1.0, "never": 0.0}
    assert costs["perfect"] == pytest.approx(10 * costs["never"])
    assert simulated_outcomes(invoices, [perfect, never], seed=3)[0] == data  # deterministic


async def test_recorded_runs_are_read_per_model_family_and_prompt(session):
    session.add(Project(project_id="demo", api_key_hash="x"))
    await session.flush()
    job = Job(project_id="demo", name="invoice", check_kind="ANSWER_KEY", check_config={"fields": ["total"]})
    session.add(job)
    await session.flush()
    for version, prompt, outcome in [("big-2026-09-01", "a", "PASS"), ("big-2026-09-01", "b", "FAIL"),
                                     ("mini-2026-09-01", "a", "PASS"), ("mini-2026-09-01", "b", "UNKNOWN")]:
        session.add(Run(run_id=uuid.uuid4(), job_id=job.job_id, project_id="demo", prompt=prompt,
                        prompt_hash=prompt_hash(prompt), model=version.split("-")[0], model_version=version,
                        outcome=outcome, cost_usd=0.01, state="CHECKED"))
    await session.commit()
    data = await load_outcomes(session, job)
    assert set(data) == {"big", "mini"}
    assert data["big"][prompt_hash("b")] == Outcome(False, 0.01)
    assert list(data["mini"]) == [prompt_hash("a")]  # an unchecked run is not evidence
