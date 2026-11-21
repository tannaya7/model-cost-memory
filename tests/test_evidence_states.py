"""What a verdict rests on: the check kind (deterministic or a human/app label), the window, comparability, pairs, and
the four evidence states. None of it changes a verdict except 'not comparable', which can only stop a move."""

import uuid
from datetime import UTC, datetime, timedelta

import pytest

from agent_memory.config import Settings
from agent_memory.models import Job, Project, Run
from agent_memory.recommend import evidence as ev
from agent_memory.recommend.engine import recommend
from agent_memory.recommend.stats import Sample, z_for

NOW = datetime(2026, 11, 18, 12, 0, tzinfo=UTC)
Z95 = z_for(0.95)


async def job_with(session, check_kind="ANSWER_KEY"):
    session.add(Project(project_id="p", api_key_hash="x"))
    await session.flush()
    job = Job(project_id="p", name="invoice", check_kind=check_kind, check_config={"fields": ["total"]})
    session.add(job)
    await session.flush()
    return job


def runs(job, model, n, pass_rate, *, version=None, prompt_version=None, kind="PRODUCTION", cost=0.01, hashes=None,
         age=lambda i: 1 + i * 0.01, passes=None):
    out = []
    for i in range(n):
        ok = passes[i] if passes is not None else (i % 100) < pass_rate * 100
        out.append(Run(run_id=uuid.uuid4(), job_id=job.job_id, project_id="p", prompt="p",
                       prompt_hash=hashes[i] if hashes else f"h{i}", model=model, model_version=version or f"{model}-2026-09",
                       prompt_version=prompt_version, run_kind=kind, outcome="PASS" if ok else "FAIL", cost_usd=cost,
                       state="INDEXED", created_at=NOW - timedelta(days=age(i))))
    return out


# --- what the pass/fail came from --------------------------------------------------------------------------------

@pytest.mark.parametrize(("kind", "basis"), [("ANSWER_KEY", "deterministic"), ("SCHEMA", "deterministic"),
                                             ("TEST_COMMAND", "deterministic"), ("LATE_LABEL", "human_label")])
def test_every_check_is_labelled_deterministic_or_a_label(kind, basis):
    assert ev.basis_for(kind).kind == basis


def test_a_label_is_never_called_ground_truth_and_a_format_check_is_not_correctness():
    label = ev.basis_for("LATE_LABEL")
    assert "opinion" in label.text and "ground truth" not in label.text.replace("not proof", "")
    assert "well formed, not that it is right" in ev.basis_for("SCHEMA").text
    unknown = ev.basis_for("SOMETHING_NEW")
    assert unknown.kind == "human_label"  # an unknown source is never promoted to deterministic
    lims = ev.limitations(unpaired=True, effective_n=50, n_runs=100, window_days=3, basis=label)
    assert any("model-graded label is an opinion" in x for x in lims)
    assert any("different requests" in x for x in lims) and any("3 days" in x for x in lims)
    assert any("100 checked answers carry about 50" in x for x in lims)


# --- the four states ---------------------------------------------------------------------------------------------

K = dict(current_known=True, app_chosen=False, reference_passes_none=False, open_questions=False, not_comparable_reason=None)


@pytest.mark.parametrize(("verdict", "over", "state"), [
    ("DOWNGRADE", {}, "enough"), ("SWITCH", {}, "enough"), ("HOLD", {}, "enough"),
    ("HOLD", {"open_questions": True}, "not_enough"), ("INSUFFICIENT_EVIDENCE", {}, "not_enough"),
    ("HOLD", {"app_chosen": True}, "no_recommendation"), ("HOLD", {"current_known": False}, "no_recommendation"),
    ("HOLD", {"reference_passes_none": True}, "no_recommendation"),
    ("DOWNGRADE", {"not_comparable_reason": "different prompts"}, "not_comparable"),
])
def test_evidence_state(verdict, over, state):
    got, note = ev.classify(verdict, **{**K, **over})
    assert got == state and note


def test_not_enough_evidence_is_called_a_valid_answer_not_a_failure():
    assert "valid answer, not a failure" in ev.classify("INSUFFICIENT_EVIDENCE", **K)[1]


def test_comparability_needs_a_shared_prompt_version():
    seen = {"a": {"p1"}, "b": {"p2"}, "c": {"p1", "p2"}}
    assert ev.not_comparable(seen, "a", "b") and "different prompt versions" in ev.not_comparable(seen, "a", "b")
    assert ev.not_comparable(seen, "a", "c") is None  # they share p1
    assert ev.not_comparable(seen, "a", "unseen") is None  # unknown is not a reason to refuse
    assert ev.not_comparable(seen, "a", "a") is None and ev.not_comparable(seen, None, "b") is None


def test_a_gap_is_never_called_a_tie_because_ranges_overlap():
    assert "no clear difference yet" in ev.gap_words(-0.04, 0.05, 0.03)
    assert "too wide" in ev.gap_words(-0.10, 0.05, 0.03)
    assert ev.gap_words(0.01, 0.05, 0.03).startswith("better") and ev.gap_words(-0.09, -0.02, 0.03).startswith("worse")
    assert "same" not in ev.gap_words(-0.01, 0.01, 0.03)


# --- pairs ------------------------------------------------------------------------------------------------------

def test_pairs_need_enough_shared_prompts_and_use_the_paired_interval():
    outcomes = {"cheap": {f"h{i}": i % 10 != 0 for i in range(40)}, "big": {f"h{i}": i % 20 != 0 for i in range(40)}}
    got = ev.paired_evidence("cheap", "big", outcomes, Z95)
    assert got.n_prompts == 40 and got.both + got.only_candidate + got.only_current + got.neither == 40
    assert got.low < got.gap < got.high
    assert ev.paired_evidence("cheap", "big", {k: dict(list(v.items())[:29]) for k, v in outcomes.items()}, Z95) is None
    assert ev.paired_evidence("cheap", "missing", outcomes, Z95) is None


def test_unpaired_gap_matches_the_engines_interval():
    gap, low, high = ev.unpaired_gap(Sample(0.95, 300, 300), Sample(0.97, 300, 300), Z95)
    assert gap == pytest.approx(-0.02) and low < gap < high


# --- through the engine ------------------------------------------------------------------------------------------

async def test_the_verdict_carries_its_check_window_state_and_limits(session):
    job = await job_with(session, "LATE_LABEL")
    session.add_all(runs(job, "big", 300, 0.97) + runs(job, "mini", 300, 0.97, cost=0.001))
    await session.commit()
    r = await recommend(session, job, now=NOW, settings=Settings())
    assert r.check_kind == "LATE_LABEL" and r.state in ("enough", "not_enough") and r.state_note
    assert r.window_from < r.window_to <= NOW
    assert any("different requests" in x for x in r.limitations) and r.paired is None
    assert any("opinion" in x for x in r.limitations)  # a label's limits are stated


async def test_models_only_tried_on_different_prompt_versions_are_not_comparable_and_no_move_is_advised(session):
    job = await job_with(session)
    session.add_all(runs(job, "big", 1500, 0.97, prompt_version="v1", age=lambda i: 0.01 + i * 0.001)  # the one in use: ran last
                   + runs(job, "mini", 1500, 0.97, cost=0.001, prompt_version="v2", age=lambda i: 5 + i * 0.01))
    await session.commit()
    alone = Settings()
    r = await recommend(session, job, now=NOW, settings=alone)
    assert r.decision.verdict == "HOLD" and r.state == "not_comparable"
    assert any("different prompt versions" in w for w in r.decision.warnings)
    assert r.decision.recommended is r.decision.current and r.forecast is None


async def test_the_same_models_on_the_same_prompt_version_can_still_move(session):
    job = await job_with(session)
    session.add_all(runs(job, "big", 1500, 0.97, prompt_version="v1", age=lambda i: 0.01 + i * 0.001)
                    + runs(job, "mini", 1500, 0.97, cost=0.001, prompt_version="v1", age=lambda i: 5 + i * 0.01))
    await session.commit()
    r = await recommend(session, job, now=NOW, settings=Settings())
    assert r.state != "not_comparable" and r.decision.verdict in ("DOWNGRADE", "HOLD")


async def test_retests_that_replayed_the_same_prompts_are_also_shown_as_pairs(session):
    job = await job_with(session)
    shared = [f"s{i}" for i in range(60)]
    big = runs(job, "big", 60, 0.95, hashes=shared, passes=[i % 20 != 0 for i in range(60)])
    mini = runs(job, "mini", 60, 0.90, hashes=shared, kind="RETEST", cost=0.001, passes=[i % 10 != 0 for i in range(60)])
    session.add_all(big + mini + runs(job, "big", 400, 0.95) + runs(job, "mini", 400, 0.95, cost=0.001))
    await session.commit()
    r = await recommend(session, job, now=NOW, settings=Settings())
    assert r.paired is not None, (r.decision.verdict, r.decision.retest_candidates)
    assert r.paired.n_prompts == 60 and r.paired.low < r.paired.gap < r.paired.high  # the verdict never depends on it
    assert not any("different requests" in x for x in r.limitations)
