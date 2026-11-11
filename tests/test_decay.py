"""The decay maintenance job against a real Postgres. Model names are made up."""

import uuid
from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import select

from agent_memory.models import Job, Project, Run
from agent_memory.pipeline.decay import recompute

NOW = datetime(2026, 10, 14, 12, 0, tzinfo=UTC)


@pytest.fixture
async def world(session):
    session.add(Project(project_id="demo", api_key_hash="x"))
    await session.flush()
    jobs = {}
    for name in ("invoice", "ticket"):
        jobs[name] = Job(project_id="demo", name=name, check_kind="LATE_LABEL", check_config={})
        session.add(jobs[name])
    await session.flush()

    async def add(job="invoice", version="model-a-2026-08", age=0.0, outcome="PASS", cost=0.0, kind="PRODUCTION",
                  state="CHECKED", model="model-a"):
        run = Run(run_id=uuid.uuid4(), job_id=jobs[job].job_id, project_id="demo", prompt="p", prompt_hash="h",
                  model=model, model_version=version, outcome=outcome, cost_usd=cost, run_kind=kind, state=state,
                  created_at=NOW - timedelta(days=age))
        session.add(run)
        await session.flush()
        return run.run_id

    return add


async def get(session, run_id):
    session.expunge_all()
    return await session.get(Run, run_id)


async def test_a_current_run_gets_thirty_days_of_stability_and_its_importance(session, world):
    cheap = await world(cost=0.0)
    costly = await world(cost=0.02, outcome="FAIL")  # job mean is 0.01, so cost part is 1.0 (capped)
    await session.commit()
    stats = await recompute(session, now=NOW)
    assert (stats.scored, stats.archived) == (2, 0)
    a, b = await get(session, cheap), await get(session, costly)
    assert (a.importance_score, a.stability) == (1.0, 30.0)
    assert b.importance_score == 4.0  # 1 + 2 for the failure + 1 for costing twice the job's mean
    assert b.stability == 120.0


async def test_an_older_version_is_superseded_and_fades_four_times_faster(session, world):
    old = await world(version="model-a-2026-08", age=40)
    new = await world(version="model-a-2026-09", age=1)
    await session.commit()
    stats = await recompute(session, now=NOW)
    assert stats.superseded == 1
    assert (await get(session, old)).stability == 7.5
    assert (await get(session, new)).stability == 30.0


async def test_runs_are_archived_when_their_weight_falls_below_five_percent(session, world):
    await world(version="model-a-2026-09", age=1)  # makes -2026-09 current
    current_old = await world(version="model-a-2026-09", age=95)  # S=30: faded past ~90 days
    current_fresh = await world(version="model-a-2026-09", age=60)
    superseded_old = await world(version="model-a-2026-08", age=25)  # S=7.5: faded past ~22 days
    superseded_ok = await world(version="model-a-2026-08", age=15)
    await session.commit()
    stats = await recompute(session, now=NOW)
    assert stats.archived == 2
    assert (await get(session, current_old)).state == "ARCHIVED"
    assert (await get(session, current_fresh)).state == "CHECKED"
    assert (await get(session, superseded_old)).state == "ARCHIVED"
    assert (await get(session, superseded_ok)).state == "CHECKED"


async def test_a_failure_is_remembered_longer_than_a_pass(session, world):
    await world(age=0)
    passed = await world(age=100, outcome="PASS", cost=0.0)  # S=30: R(100) = 0.036 -> archived
    failed = await world(age=100, outcome="FAIL", cost=0.0)  # importance 3, S=90: R(100) = 0.33 -> kept
    await session.commit()
    await recompute(session, now=NOW)
    assert (await get(session, passed)).state == "ARCHIVED"
    assert (await get(session, failed)).state == "CHECKED"


async def test_archived_runs_stay_in_the_database_and_are_not_rescored(session, world):
    old = await world(age=200)
    await world(age=0)
    await session.commit()
    await recompute(session, now=NOW)
    assert (await get(session, old)).state == "ARCHIVED"
    again = await recompute(session, now=NOW)
    assert again.scored == 1  # only the live run is looked at the second time
    assert len((await session.execute(select(Run))).scalars().all()) == 2  # nothing was deleted


async def test_retest_runs_do_not_decide_which_version_is_current(session, world):
    prod = await world(version="model-a-2026-08", age=5, kind="PRODUCTION")
    await world(version="model-a-2026-09", age=1, kind="RETEST")  # a candidate being tried, not in use
    await session.commit()
    stats = await recompute(session, now=NOW)
    assert stats.superseded == 1  # the retest run of the newer version counts as superseded, the prod one does not
    assert (await get(session, prod)).stability == 30.0


async def test_a_rollback_makes_the_older_version_current_again(session, world):
    await world(version="model-a-2026-09", age=10)
    older = await world(version="model-a-2026-08", age=1)  # production went back to the older build
    await session.commit()
    await recompute(session, now=NOW)
    assert (await get(session, older)).stability == 30.0


async def test_families_and_jobs_are_independent(session, world):
    other_model = await world(version="model-b-2026-01", age=50, model="model-b")
    other_job = await world(job="ticket", version="model-a-2026-01", age=50)
    await world(version="model-a-2026-09", age=1)  # a newer version in the invoice job only
    await session.commit()
    await recompute(session, now=NOW)
    assert (await get(session, other_model)).stability == 30.0  # different family: still current
    assert (await get(session, other_job)).stability == 30.0  # different job: still current


async def test_time_can_be_moved_forward_to_replay_weeks(session, world):
    run = await world(age=0)
    await world(age=0)
    await session.commit()
    assert (await recompute(session, now=NOW + timedelta(days=30))).archived == 0
    await recompute(session, now=NOW + timedelta(days=120))
    assert (await get(session, run)).state == "ARCHIVED"


async def test_a_run_that_failed_to_index_keeps_its_state(session, world):
    broken = await world(age=300, state="INGESTION_FAILED")
    await world(age=0)
    await session.commit()
    await recompute(session, now=NOW)
    assert (await get(session, broken)).state == "INGESTION_FAILED"
