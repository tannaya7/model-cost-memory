"""The cost scenario planner: deterministic maths, honest minimums, unknowns kept visible, one task and one project at a time.

Real Postgres and made-up calls with a price of $1 per million input tokens and $2 per million output tokens. No provider is called."""

import math
import uuid
from datetime import UTC, datetime, timedelta
from decimal import Decimal

import pytest
from sqlalchemy import select

from agent_memory.insights.planner import MIN_FOR_ESTIMATE, MIN_FOR_RANGE, far_out_limit, plan, project, quantile
from agent_memory.models import Job, PriceVersion, Run
from agent_memory.projects import create_project

NOW = datetime.now(UTC)
JOB = {"name": "t", "check_kind": "ANSWER_KEY", "check_config": {"fields": ["x"]}}


# --- the pure maths ---------------------------------------------------------------------------------------------

def test_quantile_is_the_usual_interpolation():
    assert quantile([1.0, 2.0, 3.0, 4.0], 0.5) == 2.5 and quantile([5.0], 0.9) == 5.0


def test_estimate_is_tasks_times_attempts_times_the_mean_call():
    s = project([(0.01, 0.03)] * 40, tasks=1000, retry_rate=0.0, input_change=0.0, output_change=0.0)
    assert s.estimate_usd == pytest.approx(40.0) and s.per_task_usd == pytest.approx(0.04)
    assert s.low_usd == pytest.approx(40.0) and s.high_usd == pytest.approx(40.0)  # every call cost the same: no spread to show


def test_retries_multiply_attempts_and_size_changes_scale_only_their_side():
    side = [(0.01, 0.03)] * 40
    base = project(side, tasks=100, retry_rate=0.0, input_change=0.0, output_change=0.0).estimate_usd
    assert project(side, tasks=100, retry_rate=0.5, input_change=0.0, output_change=0.0).estimate_usd == pytest.approx(base * 1.5)
    assert project(side, tasks=100, retry_rate=0.0, input_change=1.0, output_change=0.0).estimate_usd == pytest.approx(100 * (0.02 + 0.03))
    assert project(side, tasks=100, retry_rate=0.0, input_change=0.0, output_change=-0.5).estimate_usd == pytest.approx(100 * (0.01 + 0.015))


def test_the_range_follows_the_documented_formula_and_widens_with_uneven_calls():
    sides = [(0.01 * (1 + (i % 5)), 0.0) for i in range(40)]
    s = project(sides, tasks=10_000, retry_rate=0.0, input_change=0.0, output_change=0.0)
    costs = [a for a, _ in sides]
    mean = sum(costs) / 40
    var = sum((c - mean) ** 2 for c in costs) / 39
    sd = math.sqrt(10_000 * var * (1 + 10_000 / 40))
    assert s.estimate_usd == pytest.approx(10_000 * mean)
    assert s.low_usd == pytest.approx(s.estimate_usd - 1.28 * sd) and s.high_usd == pytest.approx(s.estimate_usd + 1.28 * sd)
    flat = project([(0.03, 0.0)] * 40, tasks=10_000, retry_rate=0.0, input_change=0.0, output_change=0.0)
    assert (s.high_usd - s.low_usd) > (flat.high_usd - flat.low_usd)


def test_a_range_is_never_below_zero():
    sides = [(0.0, 0.0)] * 30 + [(10.0, 0.0)]
    assert project(sides, tasks=1, retry_rate=0.0, input_change=0.0, output_change=0.0).low_usd >= 0


def test_too_few_calls_give_no_number_and_a_few_give_no_range():
    none = project([(0.01, 0.01)] * (MIN_FOR_ESTIMATE - 1), tasks=1000, retry_rate=0, input_change=0, output_change=0)
    assert none.estimate_usd is None and none.low_usd is None
    few = project([(0.01, 0.01)] * MIN_FOR_ESTIMATE, tasks=1000, retry_rate=0, input_change=0, output_change=0)
    assert few.estimate_usd is not None and few.low_usd is None and "range needs" in few.range_note
    enough = project([(0.01, 0.01)] * MIN_FOR_RANGE, tasks=1000, retry_rate=0, input_change=0, output_change=0)
    assert enough.low_usd is not None and enough.range_note is None


def test_the_far_out_fence_needs_enough_calls_and_catches_a_huge_outlier():
    assert far_out_limit([1.0] * 7) is None
    costs = [1.0, 1.1, 0.9, 1.0, 1.2, 0.8, 1.0, 1.1, 50.0]
    limit = far_out_limit(costs)
    assert 1.2 < limit < 50.0


# --- through the database ---------------------------------------------------------------------------------------

@pytest.fixture
async def world(client, session):
    proj, key = await create_project(session, "proj1")
    h = {"X-API-Key": key}
    await client.post("/v1/jobs", json=JOB, headers=h)
    await client.post("/v1/jobs", json={**JOB, "name": "other"}, headers=h)
    jobs = {j.name: j for j in (await session.execute(select(Job))).scalars()}
    v = PriceVersion(scope="catalog", model="m", model_version="", provider="acme", input_per_mtok=1, output_per_mtok=2, source_kind="MANUAL",
                     effective_from=NOW - timedelta(days=100), source_url="https://example.test/p")
    session.add(v)
    await session.flush()
    return proj, jobs, h, v


def add(session, proj, job, v, *, model="m", tin=1000, tout=500, status="PRICED", outcome="PASS", flags=None, shape="openai_chat", age=1,
        cost="auto", kind="PRODUCTION", trace=None, factor=None):
    c = Decimal(tin) / 1_000_000 * 1 + Decimal(tout) / 1_000_000 * 2
    c = c * (factor or 1)
    session.add(Run(run_id=uuid.uuid4(), job_id=job.job_id, project_id=proj.project_id, prompt_hash="h", model=model, model_version=model,
                    provider="acme", tokens_in=tin, tokens_out=tout, outcome=outcome, state="CHECKED", run_kind=kind, price_status=status,
                    price_version_id=v.version_id if status in ("PRICED", "PARTLY_PRICED") else None, price_factor=factor, usage_shape=shape,
                    cost_usd=(c if cost == "auto" else (Decimal(cost) if cost else None)), data_flags=flags, trace_id=trace,
                    created_at=NOW - timedelta(days=age)))


async def run_plan(session, proj, job="t", **kw):
    await session.commit()
    return await plan(session, proj.project_id, job=job, now=NOW + timedelta(minutes=1), **kw)


async def test_the_estimate_uses_the_stored_price_version_and_shows_it(session, world):
    proj, jobs, _, v = world
    for _ in range(40):
        add(session, proj, jobs["t"], v)
    out = await run_plan(session, proj, calls=[1000])
    m = out.models[0]
    assert m.used_calls == 40 and m.status == "ESTIMATE"
    assert m.mean_call_usd == pytest.approx(0.002)  # 1000 in x $1/M + 500 out x $2/M
    assert m.scenarios[0].estimate_usd == pytest.approx(2.0)
    assert m.versions_used[0].version_id == str(v.version_id) and m.versions_used[0].source_url == "https://example.test/p"
    assert out.currency == "USD" and out.timezone == "UTC" and "not a bill" in out.disclaimer


async def test_a_batch_factor_stored_with_the_call_is_kept(session, world):
    proj, jobs, _, v = world
    for _ in range(40):
        add(session, proj, jobs["t"], v, factor=Decimal("0.5"))
    assert (await run_plan(session, proj, calls=[1000])).models[0].mean_call_usd == pytest.approx(0.001)


async def test_unpriced_and_doubtful_calls_are_left_out_counted_and_never_zero(session, world):
    proj, jobs, _, v = world
    for _ in range(30):
        add(session, proj, jobs["t"], v)
    add(session, proj, jobs["t"], v, status="NO_USAGE", shape="none", cost=None)
    add(session, proj, jobs["t"], v, status="UNPRICED_UNKNOWN_MODEL", cost=None)
    add(session, proj, jobs["t"], v, status="CALLER_COST")
    add(session, proj, jobs["t"], v, status="PARTLY_PRICED")
    add(session, proj, jobs["t"], v, flags=["REASONING_EXCEEDS_OUTPUT"])
    add(session, proj, jobs["t"], v, flags=["TOTAL_MISMATCH"])  # doubtful total only: kept, and counted
    m = (await run_plan(session, proj, calls=[1000])).models[0]
    assert m.observed_calls == 36 and m.used_calls == 31 and sum(m.left_out.values()) == 5
    assert m.flagged_included == 1 and m.mean_call_usd == pytest.approx(0.002)  # the unknowns did not drag the mean toward zero


async def test_each_model_uses_only_its_own_calls_and_untested_models_are_named_not_scored(session, world):
    proj, jobs, _, v = world
    for _ in range(10):
        add(session, proj, jobs["t"], v)
        add(session, proj, jobs["other"], v, model="elsewhere")
    out = await run_plan(session, proj)
    assert [m.model for m in out.models] == ["m"] and out.models[0].observed_calls == 10  # nothing borrowed from the other task
    assert out.not_tested == ["elsewhere"]


async def test_too_little_data_says_so_with_no_number(session, world):
    proj, jobs, _, v = world
    for _ in range(3):
        add(session, proj, jobs["t"], v)
    m = (await run_plan(session, proj)).models[0]
    assert m.status == "NOT_ENOUGH_DATA" and all(s.estimate_usd is None for s in m.scenarios) and "Not enough comparable data" in m.status_text


async def test_an_empty_period_gives_no_models(session, world):
    proj, jobs, _, v = world
    add(session, proj, jobs["t"], v, age=90)
    assert (await run_plan(session, proj, days=30)).models == []


async def test_period_boundary_and_other_run_kinds_are_not_counted(session, world):
    proj, jobs, _, v = world
    for _ in range(6):
        add(session, proj, jobs["t"], v, age=29)
    add(session, proj, jobs["t"], v, age=31)
    add(session, proj, jobs["t"], v, kind="RETEST")
    assert (await run_plan(session, proj, days=30)).models[0].observed_calls == 6


async def test_quality_sits_beside_cost_with_its_own_denominator(session, world):
    proj, jobs, _, v = world
    for _ in range(8):
        add(session, proj, jobs["t"], v, outcome="PASS")
    for _ in range(2):
        add(session, proj, jobs["t"], v, outcome="FAIL")
    for _ in range(5):
        add(session, proj, jobs["t"], v, outcome="UNKNOWN")
    out = await run_plan(session, proj)
    m = out.models[0]
    assert (m.passed, m.failed, m.unchecked) == (8, 2, 5)
    assert m.cost_per_success.checked_priced_runs == 10 and m.cost_per_success.value_usd == pytest.approx(10 * 0.002 / 8)
    assert "answer key" in out.success_definition


async def test_no_checks_means_no_cost_per_success_and_a_reason(session, world):
    proj, jobs, _, v = world
    for _ in range(10):
        add(session, proj, jobs["t"], v, outcome="UNKNOWN")
    m = (await run_plan(session, proj)).models[0]
    assert m.cost_per_success.value_usd is None and m.cost_per_success.reason


async def test_the_far_out_filter_is_visible_and_reversible(session, world):
    proj, jobs, _, v = world
    for _ in range(40):
        add(session, proj, jobs["t"], v)
    add(session, proj, jobs["t"], v, tin=5_000_000, tout=0)  # one huge call
    on = (await run_plan(session, proj, exclude_far_out=True)).models[0]
    off = (await run_plan(session, proj, exclude_far_out=False)).models[0]
    assert on.filtered_out == 1 and off.filtered_out == 0
    assert on.mean_call_usd < off.mean_call_usd and on.mean_call_unfiltered_usd == pytest.approx(off.mean_call_usd)
    assert off.uneven is True


async def test_measured_retry_rate_comes_from_task_ids_only(session, world):
    proj, jobs, _, v = world
    for _ in range(3):
        add(session, proj, jobs["t"], v, trace="a")
    add(session, proj, jobs["t"], v, trace="b")
    out = await run_plan(session, proj)
    assert out.observed_retry_rate == pytest.approx(1.0)  # (2 extra + 0) / 2 tasks
    add(session, proj, jobs["other"], v)
    assert (await run_plan(session, proj, job="other")).observed_retry_rate is None  # no task ids: nothing is guessed


async def test_assumptions_are_labelled_as_yours_or_measured(session, world):
    proj, jobs, _, v = world
    add(session, proj, jobs["t"], v)
    out = await run_plan(session, proj, calls=[5], retry_rate=0.2, input_change_pct=10)
    sources = {a.name: a.source for a in out.assumptions}
    assert sources["Retry rate (extra attempts per task)"] == "You entered this" and sources["Calls and prices"] == "Measured from your history"


async def test_a_price_change_after_recording_does_not_rewrite_the_estimate(session, world):
    proj, jobs, _, v = world
    for _ in range(40):
        add(session, proj, jobs["t"], v)
    await session.commit()
    before = (await plan(session, proj.project_id, job="t", now=NOW + timedelta(minutes=1))).models[0].mean_call_usd
    v.effective_to = NOW  # the catalog moves on
    session.add(PriceVersion(scope="catalog", model="m", model_version="", provider="acme", input_per_mtok=9, output_per_mtok=9,
                             source_kind="MANUAL", effective_from=NOW))
    await session.commit()
    after = (await plan(session, proj.project_id, job="t", now=NOW + timedelta(minutes=1))).models[0].mean_call_usd
    assert before == after  # each call keeps the version that priced it


# --- the endpoint -----------------------------------------------------------------------------------------------

async def test_the_endpoint_validates_assumptions_and_is_project_scoped(client, session, world):
    proj, jobs, h, v = world
    for _ in range(10):
        add(session, proj, jobs["t"], v)
    await session.commit()
    ok = await client.get("/v1/insights/planner", params={"job": "t", "calls": [100, 1000]}, headers=h)
    assert ok.status_code == 200 and len(ok.json()["models"][0]["scenarios"]) == 2
    for bad in ({"calls": [0]}, {"calls": [2_000_000_000]}, {"retry_rate": -1}, {"retry_rate": 99}, {"input_change_pct": -100},
                {"output_change_pct": 5000}, {"period": "decade"}, {"days": 0}, {"calls": "abc"}):
        assert (await client.get("/v1/insights/planner", params={"job": "t", **bad}, headers=h)).status_code == 422, bad
    assert (await client.get("/v1/insights/planner", params={"job": "nope"}, headers=h)).status_code == 404
    _, key2 = await create_project(session, "proj2")
    other = {"X-API-Key": key2}
    assert (await client.get("/v1/insights/planner", params={"job": "t"}, headers=other)).status_code == 404  # another project's task is invisible
