"""The recommendation cache: fresh for small jobs; for slow ones, the last verdict while a new one is computed."""

import uuid

import pytest

from agent_memory.models import Job, Project, Run
from agent_memory.recommend import cache


@pytest.fixture(autouse=True)
def empty_cache():
    cache.clear()
    yield
    cache.clear()


async def make_job(session, runs=40):
    session.add(Project(project_id="p", api_key_hash="x"))
    await session.flush()
    job = Job(project_id="p", name="invoice", check_kind="ANSWER_KEY", check_config={"fields": ["total"]})
    session.add(job)
    await session.flush()
    await add_runs(session, job, runs)
    return job


async def add_runs(session, job, n, outcome="PASS"):
    for _ in range(n):
        session.add(Run(run_id=uuid.uuid4(), job_id=job.job_id, project_id="p", prompt="p", prompt_hash="h",
                        model="mini", model_version="mini", outcome=outcome, cost_usd=0.001, state="CHECKED"))
    await session.commit()


async def test_a_repeat_is_served_from_the_cache_and_a_new_run_is_seen_at_once(session):
    job = await make_job(session)
    first = await cache.cached_recommend(session, job)
    assert await cache.cached_recommend(session, job) is first
    await add_runs(session, job, 1)
    second = await cache.cached_recommend(session, job)  # a small job: computed fresh, never served stale
    assert second is not first and second.n_runs == 41


async def test_a_slow_job_gets_its_last_verdict_at_once_and_the_new_one_on_the_next_request(session, monkeypatch):
    monkeypatch.setattr(cache, "SLOW_SECONDS", 0.0)  # treat every job as slow to compute
    job = await make_job(session)
    first = await cache.cached_recommend(session, job)
    await add_runs(session, job, 5, outcome="FAIL")

    served = await cache.cached_recommend(session, job)
    assert served is first  # answered at once, with the verdict it had
    await cache.settle()  # the background refresh finishes
    fresh = await cache.cached_recommend(session, job)
    assert fresh.n_runs == 45 and fresh.computed_at > first.computed_at


async def test_a_verdict_older_than_the_limit_is_never_served(session, monkeypatch):
    monkeypatch.setattr(cache, "SLOW_SECONDS", 0.0)
    monkeypatch.setattr(cache, "STALE_SECONDS", -1)  # every stored verdict counts as too old
    job = await make_job(session)
    await cache.cached_recommend(session, job)
    await add_runs(session, job, 1)
    assert (await cache.cached_recommend(session, job)).n_runs == 41
