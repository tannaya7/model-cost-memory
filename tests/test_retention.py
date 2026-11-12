"""Retention clears old run content but keeps the figures; deleting a project leaves nothing behind."""

import uuid
from datetime import UTC, datetime, timedelta
from decimal import Decimal

import pytest
from sqlalchemy import func, select

from agent_memory.models import (
    Alert,
    FlowEvent,
    Job,
    OutboxRow,
    Project,
    ProviderKey,
    Recommendation,
    RecommendationSummary,
    Retest,
    Run,
    UsageLimit,
)
from agent_memory.retention import clear_old_content, delete_project, remaining_rows
from agent_memory.retest.runner import sample_sources
from agent_memory.security import generate_key, hash_key

NOW = datetime(2026, 11, 13, 12, tzinfo=UTC)


async def _project(session, project_id, retention=90):
    session.add(Project(project_id=project_id, api_key_hash=hash_key(generate_key()),
                        content_retention_days=retention))
    await session.flush()
    job = Job(project_id=project_id, name="invoice", check_kind="ANSWER_KEY", check_config={"fields": ["total"]})
    session.add(job)
    await session.flush()
    return job


def _run(job, days_old, *, prompt="Invoice 7: total?", model="mini"):
    return Run(run_id=uuid.uuid4(), job_id=job.job_id, project_id=job.project_id, prompt=prompt,
               prompt_hash=f"h-{uuid.uuid4()}", model=model, model_version=f"{model}-1", outcome="PASS",
               tokens_in=120, tokens_out=8, cost_usd=Decimal("0.0002"), output='{"total": 7}',
               tool_calls=[{"name": "lookup", "arguments": {"customer": "Ana"}}], expected={"total": 7},
               embedding=[0.1] * 384, created_at=NOW - timedelta(days=days_old))


async def test_old_runs_lose_their_content_but_keep_every_figure(session):
    job = await _project(session, "acme")
    old, recent = _run(job, 91), _run(job, 10)
    session.add_all([old, recent])
    await session.commit()

    assert await clear_old_content(session, now=NOW) == 1
    session.expunge_all()
    old, recent = await session.get(Run, old.run_id), await session.get(Run, recent.run_id)
    assert (old.prompt, old.output, old.tool_calls, old.expected, old.embedding) == (None, None, None, None, None)
    assert old.content_removed_at == NOW
    # what the statistics read is untouched
    assert (old.outcome, old.model, old.tokens_in, old.cost_usd) == ("PASS", "mini", 120, Decimal("0.0002"))
    assert old.prompt_hash.startswith("h-")
    assert recent.prompt == "Invoice 7: total?" and recent.content_removed_at is None
    assert await clear_old_content(session, now=NOW) == 0  # nothing left to clear


async def test_each_project_keeps_content_for_its_own_number_of_days(session):
    short = await _project(session, "short", retention=7)
    long = await _project(session, "long", retention=365)
    a, b = _run(short, 30), _run(long, 30)
    session.add_all([a, b])
    await session.commit()
    assert await clear_old_content(session, now=NOW) == 1
    session.expunge_all()
    assert (await session.get(Run, a.run_id)).prompt is None
    assert (await session.get(Run, b.run_id)).prompt is not None


async def test_clearing_works_in_batches(session):
    job = await _project(session, "acme")
    session.add_all([_run(job, 100) for _ in range(7)])
    await session.commit()
    assert await clear_old_content(session, now=NOW, batch=3) == 7
    left = (await session.execute(select(func.count()).where(Run.content_removed_at.is_(None)))).scalar_one()
    assert left == 0


async def test_re_tests_never_pick_a_run_whose_prompt_was_cleared(session):
    job = await _project(session, "acme")
    session.add_all([_run(job, 100), _run(job, 1)])
    await session.commit()
    await clear_old_content(session, now=NOW)
    sources = await sample_sources(session, job, "big", 10)
    assert len(sources) == 1 and sources[0].prompt == "Invoice 7: total?"


async def test_the_run_detail_says_when_content_was_removed(client, session):
    key = generate_key()
    session.add(Project(project_id="acme", api_key_hash=hash_key(key)))
    await session.flush()
    job = Job(project_id="acme", name="invoice", check_kind="ANSWER_KEY", check_config={"fields": ["total"]})
    session.add(job)
    await session.flush()
    run = _run(job, 200)
    session.add(run)
    await session.commit()
    await clear_old_content(session, now=NOW)

    headers = {"X-API-Key": key}
    detail = (await client.get(f"/v1/runs/{run.run_id}", headers=headers)).json()
    assert detail["prompt"] is None and detail["output"] is None and detail["content_removed_at"]
    assert detail["outcome"] == "PASS" and detail["cost_usd"] == 0.0002
    row = (await client.get("/v1/runs", headers=headers)).json()["items"][0]
    assert row["prompt_preview"] is None and row["content_removed_at"]


@pytest.fixture
async def full_project(session):
    """A project with a row in every table that refers to it, and a second project that must survive."""
    job = await _project(session, "doomed")
    keep = await _project(session, "kept")
    retest = Retest(job_id=job.job_id, project_id="doomed", candidate_model="big", trigger="MANUAL",
                    budget_usd=Decimal("1"))
    session.add(retest)
    await session.flush()
    runs = [_run(job, 1), _run(job, 2)]
    replay = _run(job, 1, model="big")
    replay.run_kind, replay.retest_id = "RETEST", retest.retest_id
    session.add_all([*runs, replay, _run(keep, 1)])
    await session.flush()
    first = Recommendation(job_id=job.job_id, model="mini", model_version="mini-1", verdict="HOLD", n_runs=2,
                           evidence_weight=2.0, consolidated_from=[])
    session.add(first)
    await session.flush()
    second = Recommendation(job_id=job.job_id, model="mini", model_version="mini-1", verdict="DOWNGRADE",
                            n_runs=3, evidence_weight=3.0, consolidated_from=[])
    session.add(second)
    await session.flush()
    first.superseded_by_id = second.recommendation_id  # the chain points from old to new
    session.add_all([
        OutboxRow(run_id=runs[0].run_id, op="UPSERT", payload={}),
        FlowEvent(project_id="doomed", run_id=runs[0].run_id, stage="api", message="recorded"),
        Alert(job_id=job.job_id, kind="SILENT_DROP", detail={}),
        RecommendationSummary(summary_key="k", job_id=job.job_id, summary="s", prompt_version="v"),
        UsageLimit(project_id="doomed", name="daily", window_hours=24, resets_at=NOW, measure="USD", size=5),
        ProviderKey(project_id="doomed", provider="gemini", base_url="https://g.example/v1",
                    key_encrypted="x", key_hint="abcd"),
    ])
    await session.commit()
    return job


async def test_deleting_a_project_removes_everything_under_it_and_nothing_else(session, full_project):
    assert await delete_project(session, "doomed") is True
    await session.commit()
    assert set((await remaining_rows(session, "doomed")).values()) == {0}
    job_ids = [full_project.job_id]
    for model in (Alert, Recommendation, RecommendationSummary):
        assert (await session.execute(select(func.count()).select_from(model)
                                      .where(model.job_id.in_(job_ids)))).scalar_one() == 0
    assert (await session.execute(select(func.count()).select_from(OutboxRow))).scalar_one() == 0
    assert (await remaining_rows(session, "kept"))["runs"] == 1  # the other project is untouched
    assert await delete_project(session, "doomed") is False


@pytest.fixture
def owner(monkeypatch):
    monkeypatch.setenv("DEV_LOGIN", "true")

    async def sign_in(client, email):
        assert (await client.post("/auth/dev/login", json={"email": email})).status_code == 200
        created = (await client.post("/v1/projects", json={"name": "Invoices"})).json()
        return created["project"]["project_id"], created["api_key"]

    return sign_in


async def test_the_owner_deletes_a_project_and_its_key_stops_working(client, owner):
    pid, key = await owner(client, "ana@example.com")
    assert (await client.post("/v1/jobs", headers={"X-API-Key": key}, json={
        "name": "invoice", "check_kind": "LATE_LABEL", "check_config": {}})).status_code == 201

    wrong = await client.delete(f"/v1/projects/{pid}", params={"confirm": "something-else"})
    assert wrong.status_code == 422
    assert (await client.get("/v1/jobs", headers={"X-API-Key": key})).status_code == 200

    assert (await client.delete(f"/v1/projects/{pid}", params={"confirm": pid})).status_code == 204
    assert (await client.get("/v1/jobs", headers={"X-API-Key": key})).status_code == 401
    assert (await client.get("/v1/projects")).json() == []


async def test_only_the_owner_can_delete_a_project(client, owner):
    pid, _ = await owner(client, "ana@example.com")
    await client.post("/auth/logout")
    await client.post("/auth/dev/login", json={"email": "ben@example.com"})
    assert (await client.delete(f"/v1/projects/{pid}", params={"confirm": pid})).status_code == 404


async def test_the_owner_sets_how_long_content_is_kept(client, owner):
    pid, _ = await owner(client, "ana@example.com")
    assert (await client.get(f"/v1/projects/{pid}")).json()["content_retention_days"] == 90
    changed = await client.patch(f"/v1/projects/{pid}", json={"content_retention_days": 30})
    assert changed.status_code == 200 and changed.json()["content_retention_days"] == 30
    for bad in (0, 3651):
        assert (await client.patch(f"/v1/projects/{pid}", json={"content_retention_days": bad})).status_code == 422
