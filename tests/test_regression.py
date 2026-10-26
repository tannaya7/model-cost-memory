"""Regression detection, alerts, webhook delivery and the simulated-time harness. Names are made up."""

import hashlib
import hmac
import json
import uuid
from datetime import UTC, datetime, timedelta

import httpx
import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker

from agent_memory.alerts.notifier import deliver_pending, sign
from agent_memory.alerts.service import catalog_alerts
from agent_memory.models import Alert, Job, Project, Recommendation, Run
from agent_memory.pipeline.consolidation import consolidate_job
from agent_memory.pipeline.regression import cusum_alarm, drop_test, sweep_job
from agent_memory.security import generate_key, hash_key
from agent_memory.simulation.evaluation import detection, upgrade_scenario
from agent_memory.simulation.harness import Simulator
from agent_memory.simulation.world import truth

T0 = datetime(2026, 9, 1, tzinfo=UTC)


def test_drop_test_matches_a_textbook_case():
    drop, p = drop_test(90, 100, 75, 100)  # 90% -> 75%
    assert drop == pytest.approx(0.15)
    assert p == pytest.approx(0.00255, abs=2e-4)  # z ~ 2.80, one-sided
    assert drop_test(90, 100, 92, 100)[1] > 0.5  # an improvement is not a drop


def test_cusum_needs_a_sustained_drop():
    steady = [(19, 20)] * 10  # 95% every day
    assert not cusum_alarm(steady, 0.95)
    one_bad_day = [(19, 20)] * 5 + [(15, 20)] + [(19, 20)] * 4  # one day at 75%: noise on 20 runs
    assert not cusum_alarm(one_bad_day, 0.95)
    sustained = [(19, 20)] * 3 + [(17, 20)] * 7  # 85% for a week
    assert cusum_alarm(sustained, 0.95)


@pytest.fixture
async def world(session):
    key = generate_key()
    session.add(Project(project_id="demo", api_key_hash=hash_key(key), webhook_url="https://hooks.example/alerts",
                        webhook_secret="whsec_test"))
    await session.flush()
    job = Job(project_id="demo", name="invoice", check_kind="ANSWER_KEY", check_config={"fields": ["total"]})
    session.add(job)
    await session.flush()

    async def add(n, *, version, passes, start, model="big"):
        for i in range(n):
            session.add(Run(
                run_id=uuid.uuid4(), job_id=job.job_id, project_id="demo", prompt="p", prompt_hash="h", model=model,
                model_version=version, outcome="PASS" if i < passes else "FAIL", cost_usd=0.03, state="INDEXED",
                created_at=start + timedelta(minutes=10 * i),
            ))
        await session.commit()

    return key, job, add


async def test_a_drop_across_a_version_change_raises_one_alert_and_supersedes_the_verdict(session, world):
    _, job, add = world
    await add(200, version="big-2026-08", passes=190, start=T0)  # 95%
    await consolidate_job(session, job, now=T0 + timedelta(days=3))
    await add(100, version="big-2026-09", passes=80, start=T0 + timedelta(days=3))  # 80%
    now = T0 + timedelta(days=5)
    result = await sweep_job(session, job, now=now)
    [alert] = result.alerts
    assert alert.kind == "VERSION_REGRESSION"
    assert (alert.detail["old_version"], alert.detail["new_version"]) == ("big-2026-08", "big-2026-09")
    assert alert.detail["drop"] == pytest.approx(0.15) and alert.detail["p_value"] < 0.05
    assert len(alert.detail["failing_run_ids"]) == 10
    session.expunge_all()
    recs = (await session.execute(select(Recommendation).order_by(Recommendation.valid_at))).scalars().all()
    assert recs[0].supersession_reason == "REGRESSION" and recs[-1].invalid_at is None

    again = await sweep_job(session, job, now=now + timedelta(hours=1))  # still open: not raised twice
    assert again.alerts == []


async def test_a_small_or_unproven_drop_is_not_flagged(session, world):
    _, job, add = world
    await add(200, version="big-2026-08", passes=190, start=T0)  # 95%
    await add(100, version="big-2026-09", passes=93, start=T0 + timedelta(days=3))  # 93%: below the 5-point minimum
    assert (await sweep_job(session, job, now=T0 + timedelta(days=5))).alerts == []


async def test_too_few_runs_on_the_new_version_are_not_judged(session, world):
    _, job, add = world
    await add(200, version="big-2026-08", passes=190, start=T0)
    await add(20, version="big-2026-09", passes=10, start=T0 + timedelta(days=3))  # 50%, but only 20 runs
    assert (await sweep_job(session, job, now=T0 + timedelta(days=5))).alerts == []


async def test_alerts_are_listed_and_resolved_through_the_api(client, session, world):
    key, job, add = world
    await add(200, version="big-2026-08", passes=190, start=T0)
    await add(100, version="big-2026-09", passes=80, start=T0 + timedelta(days=3))
    await sweep_job(session, job, now=T0 + timedelta(days=5))
    headers = {"X-API-Key": key}
    [alert] = (await client.get("/v1/jobs/invoice/regressions", headers=headers)).json()
    assert alert["kind"] == "VERSION_REGRESSION" and "fell from 95.0% to 80.0%" in alert["summary"]
    assert [a["alert_id"] for a in (await client.get("/v1/alerts", headers=headers)).json()] == [alert["alert_id"]]
    resolved = (await client.post(f"/v1/alerts/{alert['alert_id']}/resolve", headers=headers)).json()
    assert resolved["resolved_at"] is not None
    assert (await client.get("/v1/jobs/invoice/regressions", headers=headers)).json() == []
    every = (await client.get("/v1/jobs/invoice/regressions?include_resolved=true", headers=headers)).json()
    assert len(every) == 1
    assert (await client.post(f"/v1/alerts/{uuid.uuid4()}/resolve", headers=headers)).status_code == 404


async def test_webhook_delivery_is_signed_and_retried_with_backoff(session, world):
    _, job, add = world
    await add(200, version="big-2026-08", passes=190, start=T0)
    await add(100, version="big-2026-09", passes=80, start=T0 + timedelta(days=3))
    now = T0 + timedelta(days=5)
    await sweep_job(session, job, now=now)
    received = []

    def down(request):
        return httpx.Response(503)

    assert await deliver_pending(session, now=now, transport=httpx.MockTransport(down)) == (0, 1)
    session.expunge_all()
    alert = (await session.execute(select(Alert))).scalar_one()
    assert alert.delivery_attempts == 1 and alert.delivered_at is None and "503" in alert.last_error
    assert alert.next_attempt_at > now
    assert await deliver_pending(session, now=now, transport=httpx.MockTransport(down)) == (0, 0)  # not due yet

    def up(request):
        received.append(request)
        return httpx.Response(204)

    later = now + timedelta(minutes=5)
    assert await deliver_pending(session, now=later, transport=httpx.MockTransport(up)) == (1, 0)
    [request] = received
    expected = "sha256=" + hmac.new(b"whsec_test", request.content, hashlib.sha256).hexdigest()
    assert request.headers["X-MCM-Signature"] == expected == sign("whsec_test", request.content)
    payload = json.loads(request.content)
    assert payload["kind"] == "VERSION_REGRESSION" and payload["job"] == "invoice"
    # Slack (text) and Discord (content) show a readable line
    assert payload["text"] == payload["content"]
    assert payload["text"].startswith("Regression after a model upgrade in invoice: big: pass rate fell from 95.0%")
    assert "prompt" not in json.dumps(payload)  # figures and run ids only


async def test_a_deprecated_recommended_model_raises_an_alert(session, world):
    _, job, add = world
    await add(200, version="big-2026-08", passes=198, start=T0)
    await consolidate_job(session, job, now=T0 + timedelta(days=2))
    raised = await catalog_alerts(session, [("big-2026-08", "ACTIVE", "DEPRECATED")], now=T0 + timedelta(days=3))
    await session.commit()
    assert [a.kind for a in raised] == ["MODEL_DEPRECATED"]
    assert await catalog_alerts(session, [("unrelated-model", "ACTIVE", "RETIRED")], now=T0) == []


def test_truth_picks_the_cheapest_model_within_the_margin():
    from agent_memory.simulation.world import Scenario, SimModel, Version

    big = SimModel("big", 0.03, (Version("big-1", 0, 0.98, 0.96),))
    mini = SimModel("mini", 0.001, (Version("mini-1", 0, 0.97, 0.70),))
    s = Scenario(job="j", models=(big, mini), production="big", days=10, runs_per_day=1, retest_per_day=1,
                 long_share_start=0.0, long_share_end=1.0)
    assert truth(s, 0, 0.03) == "mini"  # all short documents: mini is within 3 points
    assert truth(s, 9, 0.03) == "big"  # all long: mini falls far behind


async def test_the_harness_detects_an_injected_version_regression(engine):
    sessions = async_sessionmaker(engine, expire_on_commit=False)
    async with sessions() as session:
        sim = Simulator(session, upgrade_scenario(0.15, seed=1), project_id="sim-test")
        results = await sim.run()
    flagged = [r.day for r in results if any(a.kind == "VERSION_REGRESSION" for a in r.alerts)]
    assert flagged and 30 <= flagged[0] <= 33  # within a few simulated days of the upgrade


async def test_the_detection_evaluation_reports_rates(engine):
    sessions = async_sessionmaker(engine, expire_on_commit=False)
    control, injected = await detection(sessions, drops=(0.0, 0.15), trials=2)
    assert (control.drop, control.flagged) == (0.0, 0)
    assert injected.rate == 1.0
