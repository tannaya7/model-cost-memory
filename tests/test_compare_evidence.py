"""What the compare page draws: the engine's own difference interval against the model in use, what is priced and
what is not, re-test counts, and cost percentiles only when enough calls stand behind them."""

import pytest

from agent_memory.api import _vs_current
from agent_memory.config import Settings
from agent_memory.recommend.engine import MIN_SPREAD_RUNS, recommend
from agent_memory.recommend.stats import assess, difference, z_for
from tests.test_evidence_states import NOW, job_with, runs


def costs(rs, values):
    for r, v in zip(rs, values, strict=False):
        r.cost_usd = v
    return rs


async def test_the_difference_is_the_engines_interval_at_the_confidence_a_move_needs(session):
    job = await job_with(session)
    session.add_all(runs(job, "big", 400, 0.97, age=lambda i: 0.01 + i * 0.001)
                    + runs(job, "mini", 400, 0.94, cost=0.001, age=lambda i: 5 + i * 0.01))
    await session.commit()
    settings = Settings()
    r = await recommend(session, job, now=NOW, settings=settings)
    d = r.decision
    cur = d.current
    mini = next(m for m in d.models if m.model != cur.model)
    got = _vs_current(mini, cur, settings)
    conf = max(settings.switch_confidence, settings.confidence_level)
    low, high = difference(mini.sample, cur.sample, z_for(conf))
    assert got.against == cur.model and got.confidence == conf and got.method == "unpaired"
    assert got.gap_points == pytest.approx((mini.sample.pass_rate - cur.sample.pass_rate) * 100)
    assert (got.low_points, got.high_points) == pytest.approx((low * 100, high * 100))
    assert got.status == assess(mini.sample, cur.sample, margin=settings.tolerance_points, z=z_for(conf))
    assert got.margin_points == pytest.approx(settings.tolerance_points * 100)
    assert _vs_current(cur, cur, settings) is None  # the model in use has nothing to be compared with itself


async def test_no_difference_without_a_model_in_use_or_without_checked_answers(session):
    job = await job_with(session)
    session.add_all(runs(job, "big", 300, 0.95))
    await session.commit()
    r = await recommend(session, job, now=NOW, settings=Settings())
    [only] = r.decision.models
    assert _vs_current(only, None, Settings()) is None
    other = type(only)(**{**vars(only), "sample": None})
    assert _vs_current(other, only, Settings()) is None


async def test_priced_unpriced_and_retest_counts_never_hide_missing_data(session):
    job = await job_with(session)
    big = costs(runs(job, "big", 100, 0.95, age=lambda i: 0.01 + i * 0.001), [0.01] * 100)
    mini = costs(runs(job, "mini", 100, 0.90, age=lambda i: 3 + i * 0.01), [None] * 30 + [0.001] * 70)
    for r in mini[:10]:
        r.run_kind = "RETEST"
    session.add_all(big + mini)
    await session.commit()
    ms = {m.model: m for m in (await recommend(session, job, now=NOW, settings=Settings())).decision.models}
    assert (ms["big"].priced_runs, ms["big"].unpriced_runs, ms["big"].retest_runs) == (100, 0, 0)
    assert (ms["mini"].priced_runs, ms["mini"].unpriced_runs, ms["mini"].retest_runs) == (70, 30, 10)


async def test_cost_percentiles_show_the_expensive_tail_only_with_enough_calls(session):
    job = await job_with(session)
    many = costs(runs(job, "big", 100, 0.95, age=lambda i: 0.01 + i * 0.001), [0.001] * 90 + [0.05] * 10)
    few = costs(runs(job, "mini", MIN_SPREAD_RUNS - 1, 0.90, age=lambda i: 3 + i * 0.01), [0.001] * (MIN_SPREAD_RUNS - 1))
    session.add_all(many + few)
    await session.commit()
    ms = {m.model: m for m in (await recommend(session, job, now=NOW, settings=Settings())).decision.models}
    assert ms["big"].cost_p50_usd == pytest.approx(0.001) and ms["big"].cost_p90_usd >= 0.001  # an average hides the 5-cent tail
    assert ms["big"].mean_cost_usd > ms["big"].cost_p50_usd
    assert ms["mini"].cost_p50_usd is None and ms["mini"].cost_p90_usd is None  # 19 calls say nothing about a tail


async def test_a_model_that_costs_nothing_keeps_its_zero_and_an_unpriced_one_stays_unknown(session):
    job = await job_with(session)
    free = costs(runs(job, "local", 60, 0.9, age=lambda i: 3 + i * 0.01), [0.0] * 60)
    unknown = costs(runs(job, "mystery", 60, 0.9, age=lambda i: 4 + i * 0.01), [None] * 60)
    session.add_all(free + unknown + costs(runs(job, "big", 60, 0.95, age=lambda i: 0.01 + i * 0.001), [0.01] * 60))
    await session.commit()
    ms = {m.model: m for m in (await recommend(session, job, now=NOW, settings=Settings())).decision.models}
    assert ms["local"].mean_cost_usd == 0 and ms["local"].priced_runs == 60  # free is not unknown
    assert ms["mystery"].mean_cost_usd is None and ms["mystery"].unpriced_runs == 60 and ms["mystery"].cost_p50_usd is None
