"""The staleness experiment's worlds and what one timeline records. Simulated data."""

from sqlalchemy.ext.asyncio import async_sessionmaker

from agent_memory.simulation.staleness import CURATION_DAYS, run_once, stable_scenario
from agent_memory.simulation.world import truth


def test_in_the_control_world_the_right_answer_never_changes():
    scenario = stable_scenario(seed=0)
    assert {truth(scenario, day, 0.03) for day in range(scenario.days)} == {"acme-mini"}


async def test_a_timeline_records_every_answer_the_rechecked_baseline_and_the_spend(engine):
    sessions = async_sessionmaker(engine, expire_on_commit=False)
    result = await run_once(sessions, stable_scenario(seed=0, days=CURATION_DAYS + 8))
    assert len(result.daily) == 8  # one maintained answer a day from curation on
    assert [c.day for c in result.checkpoints] == [CURATION_DAYS, CURATION_DAYS + 7]
    first = result.checkpoints[0]
    assert first.rechecked == first.frozen  # both start from the curated answer
    assert result.changes() == sum(a != b for a, b in zip(result.daily, result.daily[1:], strict=False))
    assert result.retest_runs == 2 * 30 * (CURATION_DAYS + 8)  # two models off production, 30 a day each
    assert 0 < result.retest_usd < result.production_usd
