"""Consolidation, supersession, lineage and history against a real Postgres. Names are made up."""

import uuid
from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import select

from agent_memory.models import Job, Project, Recommendation, Run
from agent_memory.pipeline.consolidation import consolidate_all, consolidate_job
from agent_memory.recommend import cache
from agent_memory.security import generate_key, hash_key
from agent_memory.storage import lineage

T0 = datetime(2026, 10, 1, 12, 0, tzinfo=UTC)


@pytest.fixture
async def world(session):
    key = generate_key()
    session.add(Project(project_id="demo", api_key_hash=hash_key(key)))
    await session.flush()
    job = Job(project_id="demo", name="invoice", check_kind="ANSWER_KEY", check_config={"fields": ["total"]})
    session.add(job)
    await session.flush()
    cache.clear()

    async def add(n, *, model="big", version="big-2026-09", fail_every=0, cost=0.03, at=T0, kind="PRODUCTION"):
        ids = []
        for i in range(n):
            failed = fail_every and i % fail_every == 0
            run_id = uuid.uuid4()
            session.add(Run(
                run_id=run_id, job_id=job.job_id, project_id="demo", prompt="p", prompt_hash="h", model=model,
                model_version=version, outcome="FAIL" if failed else "PASS", cost_usd=cost, run_kind=kind,
                state="INDEXED", created_at=at - timedelta(minutes=i),
            ))
            ids.append(run_id)
        await session.commit()
        return ids

    return key, job, add


async def recs(session, job):
    session.expunge_all()
    return (await session.execute(
        select(Recommendation).where(Recommendation.job_id == job.job_id).order_by(Recommendation.valid_at)
    )).scalars().all()


async def test_a_verdict_is_stored_with_every_run_behind_it_and_runs_become_consolidated(session, world):
    _, job, add = world
    ids = await add(400, fail_every=100)
    new = await consolidate_job(session, job, now=T0)
    assert (new.verdict, new.model, new.current_model, new.n_runs) == ("HOLD", "big", "big", 400)
    assert set(await lineage.runs_behind(session, new.recommendation_id)) == set(ids)
    states = {r.state for r in (await session.execute(select(Run))).scalars()}
    assert states == {"CONSOLIDATED"}


async def test_an_unchanged_verdict_writes_nothing(session, world):
    _, job, add = world
    await add(400)
    await consolidate_job(session, job, now=T0)
    assert await consolidate_job(session, job, now=T0 + timedelta(hours=1)) is None
    assert len(await recs(session, job)) == 1


async def test_a_changed_verdict_supersedes_the_old_one_which_is_kept(session, world):
    _, job, add = world
    await add(400)  # big alone: HOLD
    first = await consolidate_job(session, job, now=T0)
    await add(400, model="mini", version="mini-2026-09", cost=0.001, kind="RETEST")  # mini proves itself
    second = await consolidate_job(session, job, now=T0 + timedelta(hours=1))
    assert second.verdict == "DOWNGRADE"
    old, new = await recs(session, job)
    assert old.recommendation_id == first.recommendation_id
    assert (old.superseded_by_id, old.supersession_reason) == (second.recommendation_id, "NEW_EVIDENCE")
    assert old.invalid_at == T0 + timedelta(hours=1)
    assert new.invalid_at is None


async def test_a_new_version_of_the_same_model_is_a_model_upgrade(session, world):
    _, job, add = world
    await add(400, version="big-2026-08")
    await consolidate_job(session, job, now=T0)
    await add(400, version="big-2026-09", at=T0 + timedelta(days=2))
    await consolidate_job(session, job, now=T0 + timedelta(days=2))
    old, new = await recs(session, job)
    assert old.supersession_reason == "MODEL_UPGRADE"
    assert new.model_version == "big-2026-09"


async def test_evidence_that_fades_below_the_floor_is_evidence_decayed(session, world):
    _, job, add = world
    await add(40)
    await consolidate_job(session, job, now=T0)
    await consolidate_job(session, job, now=T0 + timedelta(days=120))  # 40 runs at weight ~0.13 each
    old, new = await recs(session, job)
    assert (old.supersession_reason, new.verdict) == ("EVIDENCE_DECAYED", "INSUFFICIENT_EVIDENCE")


async def test_consolidate_all_covers_every_job(session, world):
    _, job, add = world
    await add(400)
    stats = await consolidate_all(session, now=T0)
    assert (stats.jobs, stats.written, stats.superseded) == (1, 1, 0)


async def test_history_follows_the_chain_newest_first_and_lists_versions(client, session, world):
    key, job, add = world
    await add(400, version="big-2026-08")
    await consolidate_job(session, job, now=T0)
    await add(400, version="big-2026-09", at=T0 + timedelta(days=2))
    await consolidate_job(session, job, now=T0 + timedelta(days=2))
    body = (await client.get("/v1/jobs/invoice/history", headers={"X-API-Key": key})).json()
    assert [e["model_version"] for e in body["entries"]] == ["big-2026-09", "big-2026-08"]
    assert body["entries"][0]["invalid_at"] is None
    assert body["entries"][1]["supersession_reason"] == "MODEL_UPGRADE"
    assert body["entries"][1]["superseded_by_id"] == body["entries"][0]["recommendation_id"]
    assert body["entries"][0]["cost_per_success_usd"] == pytest.approx(0.03)
    assert [v["model_version"] for v in body["versions"]] == ["big-2026-08", "big-2026-09"]

    rec_id = body["entries"][1]["recommendation_id"]
    page = (await client.get(f"/v1/runs?recommendation={rec_id}&limit=200", headers={"X-API-Key": key})).json()
    assert len(page["items"]) == 200 and {r["model_version"] for r in page["items"]} == {"big-2026-08"}
    assert (await client.get("/v1/jobs/nope/history", headers={"X-API-Key": key})).status_code == 404


async def test_the_recommendation_cache_sees_a_new_run_immediately(client, world):
    key, job, add = world
    await add(10)
    first = (await client.get("/v1/jobs/invoice/recommendation", headers={"X-API-Key": key})).json()
    await add(400, at=datetime.now(UTC))
    second = (await client.get("/v1/jobs/invoice/recommendation", headers={"X-API-Key": key})).json()
    assert first["evidence"]["n_runs"] == 10 and second["evidence"]["n_runs"] == 410


async def test_a_downgrade_carries_a_savings_forecast(client, world):
    key, job, add = world
    now = datetime.now(UTC)
    await add(400, fail_every=100, at=now)  # big, $0.03 a run, 400 production runs this month
    await add(400, model="mini", version="mini-2026-09", cost=0.001, kind="RETEST", fail_every=100, at=now)
    body = (await client.get("/v1/jobs/invoice/recommendation", headers={"X-API-Key": key})).json()
    assert body["verdict"] == "DOWNGRADE"
    f = body["forecast"]
    assert f["runs_per_month"] == 400
    assert f["monthly_saving_usd"] == pytest.approx((0.03 - 0.001) / 0.99 * 400 * 0.99, rel=0.01)
    assert f["extra_failures_low"] <= f["extra_failures_per_month"] <= f["extra_failures_high"]
