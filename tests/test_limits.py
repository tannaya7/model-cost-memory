"""Usage limits: the window, the pace, and what to change before a limit runs out. Names and prices are made up."""

import uuid
from datetime import UTC, datetime, timedelta
from decimal import Decimal

from sqlalchemy import insert

from agent_memory.config import Settings
from agent_memory.ingest import prompt_hash
from agent_memory.limits import current_window, forecast
from agent_memory.models import Job, Project, Run, UsageLimit
from agent_memory.recommend.engine import recommend
from agent_memory.security import generate_key, hash_key

NOW = datetime(2026, 11, 1, 12, 0, tzinfo=UTC)
SETTINGS = Settings(secret_key="test-secret")


def runs(job, model, n, *, cost, hours_ago_max=20, passed=1.0, kind="PRODUCTION", effort=None, tokens=1000):
    """n checked runs spread over the last `hours_ago_max` hours, the newest last."""
    return [dict(
        run_id=uuid.uuid4(), job_id=job.job_id, project_id=job.project_id, prompt=f"{model} {effort} {i}",
        prompt_hash=prompt_hash(f"{model} {effort} {i}"), model=model, model_version=model, effort=effort,
        tokens_in=tokens, tokens_out=100, cost_usd=Decimal(str(cost)), run_kind=kind, state="INDEXED",
        outcome="PASS" if i < round(n * passed) else "FAIL",
        created_at=NOW - timedelta(hours=hours_ago_max) + timedelta(seconds=(i + 1) * hours_ago_max * 3600 / (n + 1)),
    ) for i in range(n)]


async def world(session, *, mini_runs=1200):
    """A job on `big` ($0.03 a run); `mini` ($0.001) measured as well on re-tests, both 99% right."""
    session.add(Project(project_id="lim", api_key_hash=hash_key(generate_key())))
    await session.flush()
    job = Job(project_id="lim", name="invoice", check_kind="ANSWER_KEY", check_config={"fields": ["total"]})
    session.add(job)
    await session.flush()
    rows = runs(job, "mini", mini_runs, cost=0.001, passed=0.99, kind="RETEST") + runs(job, "big", 1200, cost=0.03,
                                                                                       passed=0.99)
    await session.execute(insert(Run), rows)
    await session.commit()
    return job


def weekly(**kw):
    values = dict(project_id="lim", name="Weekly", window_hours=168, resets_at=NOW + timedelta(hours=24),
                  measure="USD", size=Decimal("40"))
    return UsageLimit(limit_id=uuid.uuid4(), **(values | kw))


def test_a_window_that_has_passed_rolls_forward_by_whole_windows():
    limit = weekly(resets_at=NOW - timedelta(days=10))
    assert current_window(limit, NOW) == (NOW - timedelta(days=3), NOW + timedelta(days=4))
    assert current_window(weekly(), NOW) == (NOW - timedelta(days=6), NOW + timedelta(days=1))


async def test_a_limit_used_up_before_it_resets_gets_the_proven_cheaper_model_per_job(session):
    await world(session)
    f = await forecast(session, weekly(), now=NOW, settings=SETTINGS)
    # $36 on big + $1.20 on mini re-tests, all in the last day: $1.55 an hour, $2.80 left, 24 h to the reset.
    assert f.used == 37.2 and f.rate_per_hour == 37.2 / 24
    assert f.state == "AT_RISK" and f.hours_to_full < 2
    [s] = f.suggestions
    assert (s.job, s.current, s.suggested) == ("invoice", "big", "mini")
    assert round(s.reduction, 3) == round(1 - 0.001 / 0.03, 3)
    assert s.note.startswith("Shown within 3 points of big at 99% confidence")
    assert f.lasts_after is True
    assert f.message.startswith("At this pace Weekly runs out in ") and f.message.endswith(
        "before it resets. With the suggested changes it lasts until the reset")


async def test_nothing_is_suggested_while_the_cheaper_model_is_unproven(session):
    await world(session, mini_runs=60)  # too few re-tests of mini to advise a switch
    f = await forecast(session, weekly(size=Decimal("38")), now=NOW, settings=SETTINGS)
    assert f.state == "AT_RISK"
    [s] = f.suggestions
    assert s.suggested is None and s.note == "No cheaper option is proven for this job yet; a re-test of mini would tell"
    assert f.lasts_after is None


async def test_a_limit_with_room_to_spare_says_so_and_suggests_nothing(session):
    await world(session)
    f = await forecast(session, weekly(size=Decimal("500")), now=NOW, settings=SETTINGS)
    assert f.state == "OK" and f.suggestions == []
    assert f.message == "At this pace Weekly lasts until it resets in 24 h"


async def test_a_one_model_limit_moves_jobs_to_another_model_that_does_the_job(session):
    await world(session)
    limit = weekly(name="big limit", model="big", measure="REQUESTS", size=Decimal("1000"))
    f = await forecast(session, limit, now=NOW, settings=SETTINGS)
    assert f.state == "EXHAUSTED" and f.used == 1200
    [s] = f.suggestions
    assert (s.suggested, s.reduction) == ("mini", 1.0)
    assert "does not count against this limit" in s.note


async def test_a_request_limit_on_every_model_is_not_helped_by_a_cheaper_model(session):
    await world(session)
    f = await forecast(session, weekly(measure="REQUESTS", size=Decimal("2500")), now=NOW, settings=SETTINGS)
    assert f.state == "AT_RISK"
    assert f.message.endswith("A cheaper model does not reduce a request count: fewer or batched calls would")
    assert f.lasts_after is None


async def test_a_plan_shown_as_a_percentage_is_calibrated_from_the_users_report(session):
    job = await world(session)
    # The user saw 80% at NOW - 1 h; $37.2 minus the last hour's runs had been recorded by then.
    limit = weekly(measure="PERCENT", size=None, reported_used=Decimal("0.8"), reported_at=NOW - timedelta(hours=1))
    f = await forecast(session, limit, now=NOW, settings=SETTINGS)
    assert 0.8 < f.share_used < 0.9  # the last hour's runs come on top of the 80%
    assert f.state == "AT_RISK"
    unknown = await forecast(session, weekly(measure="PERCENT", size=None), now=NOW, settings=SETTINGS)
    assert unknown.state == "UNKNOWN" and unknown.message.startswith("Enter how much of Weekly is used")
    assert job is not None


async def test_the_engine_compares_each_model_and_effort_as_its_own_option(session):
    session.add(Project(project_id="eff", api_key_hash=hash_key(generate_key())))
    await session.flush()
    job = Job(project_id="eff", name="summaries", check_kind="ANSWER_KEY", check_config={"fields": ["total"]})
    session.add(job)
    await session.flush()
    await session.execute(insert(Run), runs(job, "opus", 1200, cost=0.05, passed=0.99, effort="medium")
                          + runs(job, "sonnet", 1200, cost=0.004, passed=0.99, effort="low", kind="RETEST")
                          + runs(job, "sonnet", 50, cost=0.01, passed=0.9, effort="high", kind="RETEST"))
    await session.commit()
    d = (await recommend(session, job, now=NOW, settings=SETTINGS)).decision
    assert {m.model for m in d.models} == {"opus@medium", "sonnet@low", "sonnet@high"}
    assert (d.current.model, d.verdict, d.recommended.model) == ("opus@medium", "DOWNGRADE", "sonnet@low")


async def test_limits_through_the_api(client, session):
    key = generate_key()
    session.add(Project(project_id="api-lim", api_key_hash=hash_key(key)))
    await session.commit()
    headers = {"X-API-Key": key}
    resets = (datetime.now(UTC) + timedelta(days=1)).isoformat()
    missing = await client.post("/v1/limits", headers=headers,
                                json={"name": "Weekly", "window_hours": 168, "resets_at": resets, "measure": "USD"})
    assert missing.status_code == 422
    made = await client.post("/v1/limits", headers=headers, json={
        "name": "Weekly", "window_hours": 168, "resets_at": resets, "measure": "PERCENT", "used_percent": 80})
    assert made.status_code == 201
    body = made.json()
    assert (body["state"], body["measure"]) == ("UNKNOWN", "PERCENT")  # no runs recorded to calibrate from
    limit_id = body["limit_id"]
    assert (await client.put(f"/v1/limits/{limit_id}/used", headers=headers, json={"used_percent": 85})).status_code == 200
    assert [x["name"] for x in (await client.get("/v1/limits", headers=headers)).json()] == ["Weekly"]
    assert (await client.delete(f"/v1/limits/{limit_id}", headers=headers)).status_code == 204
    assert (await client.get("/v1/limits", headers=headers)).json() == []
    assert (await client.delete(f"/v1/limits/{uuid.uuid4()}", headers=headers)).status_code == 404


async def test_a_run_records_its_effort_normalized(client, session):
    key = generate_key()
    session.add(Project(project_id="api-eff", api_key_hash=hash_key(key)))
    await session.flush()
    session.add(Job(project_id="api-eff", name="j", check_kind="ANSWER_KEY", check_config={"fields": ["total"]}))
    await session.commit()
    run_id = uuid.uuid4()
    sent = await client.post("/v1/runs", headers={"X-API-Key": key}, json={
        "run_id": str(run_id), "job": "j", "prompt": "p", "model": "sonnet", "model_version": "sonnet",
        "effort": " Low ", "output": '{"total": 1}', "expected": {"total": 1}})
    assert sent.status_code in (200, 201, 202)
    assert (await session.get(Run, run_id)).effort == "low"
