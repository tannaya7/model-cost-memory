"""Token burst, monthly budget and model retirement alerts (alerts/watch.py), and the budget field."""

import uuid
from datetime import UTC, date, datetime, timedelta
from decimal import Decimal

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker

from agent_memory.alerts.watch import check_budgets, check_retirements, check_token_bursts, check_trial_budgets
from agent_memory import heartbeat, scheduler
from agent_memory.models import Alert, CatalogEntry, Job, Project, ProviderPrice, Run
from agent_memory.security import generate_key, hash_key

NOW = datetime(2026, 11, 20, 12, 30, tzinfo=UTC)


async def make_job(session, project_id="acme", name="invoice", budget=None):
    if await session.get(Project, project_id) is None:
        session.add(Project(project_id=project_id, api_key_hash=hash_key(generate_key()), monthly_budget_usd=budget))
        await session.flush()
    job = Job(project_id=project_id, name=name, check_kind="LATE_LABEL", check_config={})
    session.add(job)
    await session.flush()
    return job


def run(job, when, *, tokens=1000, cost=None, kind="PRODUCTION", model="mini", provider=None):
    return Run(run_id=uuid.uuid4(), job_id=job.job_id, project_id=job.project_id, prompt="p",
               prompt_hash=f"h-{uuid.uuid4()}", model=model, model_version=f"{model}-1", outcome="PASS",
               tokens_in=tokens // 2, tokens_out=tokens // 4, cache_read_tokens=tokens // 8,
               cache_write_tokens=tokens - tokens // 2 - tokens // 4 - tokens // 8, cost_usd=cost,
               run_kind=kind, provider=provider, created_at=when)


async def alerts(session, kind=None):
    q = select(Alert)
    if kind:
        q = q.where(Alert.kind == kind)
    return list((await session.execute(q)).scalars())


# ---- token burst

def steady(job, per_hour=10_000, hours=range(1, 25)):
    return [run(job, NOW - timedelta(hours=h, minutes=10), tokens=per_hour) for h in hours]


async def test_a_burst_over_the_floor_raises_one_plain_alert(session):
    job = await make_job(session)
    other = await make_job(session, name="chat")
    session.add_all(steady(job) + [run(job, NOW - timedelta(minutes=5), tokens=200_000),
                                   run(other, NOW - timedelta(minutes=6), tokens=40_000)])
    await session.commit()
    [alert] = await check_token_bursts(session, now=NOW)
    assert alert.kind == "TOKEN_BURST" and alert.job_id == job.job_id
    assert alert.detail["tokens_last_hour"] == 240_000 and alert.detail["usual_tokens_per_hour"] == 10_000
    assert alert.detail["top_job"] == "invoice"
    assert "240,000 tokens in the last hour" in alert.detail["summary"] and "invoice" in alert.detail["summary"]


async def test_a_burst_under_the_volume_floor_is_ignored(session):
    job = await make_job(session)
    session.add_all(steady(job, 100) + [run(job, NOW - timedelta(minutes=5), tokens=10_000)])  # 100x, but tiny
    await session.commit()
    assert await check_token_bursts(session, now=NOW) == []


async def test_the_same_burst_is_not_raised_again_within_24_hours(session):
    job = await make_job(session)
    session.add_all(steady(job) + [run(job, NOW - timedelta(minutes=5), tokens=200_000)])
    await session.commit()
    assert len(await check_token_bursts(session, now=NOW)) == 1
    for open_alert in await alerts(session):
        open_alert.resolved_at = NOW  # even resolved, it must not come straight back
    await session.commit()
    assert await check_token_bursts(session, now=NOW + timedelta(minutes=30)) == []


async def test_only_production_runs_count_towards_a_burst(session):
    job = await make_job(session)
    session.add_all(steady(job) + [run(job, NOW - timedelta(minutes=5), tokens=500_000, kind="RETEST")])
    await session.commit()
    assert await check_token_bursts(session, now=NOW) == []


# ---- budget

async def spend(session, job, day_offsets, cost="10", **kw):
    session.add_all(run(job, NOW - timedelta(days=d), cost=Decimal(cost), **kw) for d in day_offsets)
    await session.commit()


async def test_85_then_95_percent_each_fire_once_per_month(session):
    job = await make_job(session, budget=Decimal("100"))
    await spend(session, job, [0], cost="86")
    [a] = await check_budgets(session, now=NOW)
    assert (a.kind, a.detail["level"]) == ("BUDGET", "85") and "86%" in a.detail["summary"]
    assert await check_budgets(session, now=NOW + timedelta(days=1)) == []  # not again this month
    await spend(session, job, [0], cost="10")
    [b] = await check_budgets(session, now=NOW + timedelta(hours=1))
    assert b.detail["level"] == "95"
    assert await check_budgets(session, now=NOW + timedelta(days=2)) == []
    # next month the thresholds count again
    session.add(run(job, datetime(2026, 12, 3, tzinfo=UTC), cost=Decimal("90")))
    await session.commit()
    [c] = await check_budgets(session, now=datetime(2026, 12, 3, 12, tzinfo=UTC))
    assert c.detail["level"] == "85" and c.detail["month"] == "2026-12"


async def test_spend_jumping_past_95_raises_only_the_95_alert(session):
    job = await make_job(session, budget=Decimal("100"))
    await spend(session, job, [0], cost="99")
    assert [a.detail["level"] for a in await check_budgets(session, now=NOW)] == ["95"]


async def test_a_subscription_project_gets_no_spending_limit_alerts_but_keeps_the_limit(session):
    job = await make_job(session, budget=Decimal("100"))
    await spend(session, job, [0], cost="99")
    project = await session.get(Project, "acme")
    project.billing_mode = "subscription"
    await session.commit()
    assert await check_budgets(session, now=NOW) == []
    assert project.monthly_budget_usd == Decimal("100.00")  # kept, just not fired
    project.billing_mode = "both"
    await session.commit()
    assert [a.detail["level"] for a in await check_budgets(session, now=NOW)] == ["95"]


async def test_no_budget_no_alert(session):
    job = await make_job(session)
    await spend(session, job, [0], cost="9999")
    assert await check_budgets(session, now=NOW) == []


async def test_unpriced_runs_are_not_counted_as_spend(session):
    job = await make_job(session, budget=Decimal("100"))
    await spend(session, job, [0], cost="50")
    session.add_all(run(job, NOW - timedelta(hours=1), cost=None, tokens=10**7) for _ in range(5))
    await session.commit()
    assert await check_budgets(session, now=NOW) == []


async def test_projected_over_budget_needs_seven_days_of_data(session):
    job = await make_job(session, budget=Decimal("100"))
    # 5 days of data at $10 a day: on pace to pass $100 but too little history to say so
    await spend(session, job, [1, 2, 3, 4, 5], cost="10")
    assert await check_budgets(session, now=NOW) == []
    # a run 8 days ago gives 7 full days of history
    await spend(session, job, [8], cost="10")
    [a] = await check_budgets(session, now=NOW)
    assert a.detail["level"] == "PROJECTED" and a.detail["projected_usd"] > 100
    assert "over your $100.00 budget" in a.detail["summary"]
    assert await check_budgets(session, now=NOW + timedelta(hours=2)) == []  # once per month


async def test_a_pace_inside_the_budget_raises_nothing(session):
    job = await make_job(session, budget=Decimal("1000"))
    await spend(session, job, [1, 2, 3, 4, 5, 6, 7, 8], cost="5")
    assert await check_budgets(session, now=NOW) == []


async def test_re_test_runs_do_not_count_towards_the_app_budget(session):
    job = await make_job(session, budget=Decimal("100"))
    await spend(session, job, [0], cost="90", kind="RETEST")
    assert await check_budgets(session, now=NOW) == []


# ---- trial budget (the re-test cap, already in Settings)

async def trial_spend(session, job, cost):
    session.add(run(job, NOW - timedelta(hours=2), cost=Decimal(cost), kind="RETEST"))
    await session.commit()


async def test_trial_budget_warns_at_85_and_95_once_each_per_month(session):
    job = await make_job(session)  # the default cap is $10 a month
    await trial_spend(session, job, "8.6")
    [a] = await check_trial_budgets(session, now=NOW)
    assert (a.kind, a.detail["level"]) == ("TRIAL_BUDGET", "85") and "trials on a new model" in a.detail["summary"]
    assert await check_trial_budgets(session, now=NOW + timedelta(days=1)) == []
    await trial_spend(session, job, "1.0")
    [b] = await check_trial_budgets(session, now=NOW + timedelta(days=1))
    assert b.detail["level"] == "95"
    assert await check_trial_budgets(session, now=NOW + timedelta(days=2)) == []


async def test_trial_budget_is_quiet_below_85_percent(session):
    job = await make_job(session)
    await trial_spend(session, job, "8.0")
    assert await check_trial_budgets(session, now=NOW) == []


async def test_burst_and_budget_jobs_leave_heartbeats(session, engine):
    factory = async_sessionmaker(engine, expire_on_commit=False)
    for name, fn in (("token-burst", scheduler.run_token_bursts), ("budget-alerts", scheduler.run_budget_alerts),
                     ("retirement-alerts", scheduler.run_retirement_alerts)):
        assert name in heartbeat.INTERVALS
        await heartbeat.tracked(name, fn)(factory, None)
    rows = {r.job for r in (await session.execute(select(heartbeat.SchedulerHeartbeat))).scalars()
            if r.last_ok_at}
    assert {"token-burst", "budget-alerts", "retirement-alerts"} <= rows


# ---- retirement

async def add_catalog(session, status="DEPRECATED", shutdown=date(2026, 12, 15)):
    session.add(CatalogEntry(model="mini", model_version="mini-1", provider="acme", status=status,
                             shutdown_date=shutdown))
    session.add(ProviderPrice(model="mini", provider="acme", shutdown_date=shutdown))
    await session.commit()


async def test_a_model_shutting_down_within_60_days_is_flagged_once_with_not_before_wording(session):
    job = await make_job(session)
    session.add(run(job, NOW - timedelta(days=3), provider="acme"))
    await add_catalog(session)
    [a] = await check_retirements(session, now=NOW)
    assert a.kind == "MODEL_RETIRING" and a.detail["shutdown_date"] == "2026-12-15"
    assert "not before 15 Dec 2026" in a.detail["summary"] and "provider's notice" in a.detail["summary"]
    assert await check_retirements(session, now=NOW + timedelta(days=1)) == []  # once per model and date


async def test_far_off_or_unused_models_are_not_flagged(session):
    job = await make_job(session)
    session.add(run(job, NOW - timedelta(days=3), provider="acme"))
    await add_catalog(session, shutdown=date(2027, 6, 1))
    assert await check_retirements(session, now=NOW) == []  # more than 60 days away
    entry = await session.get(CatalogEntry, ("mini", "mini-1"))
    price = await session.get(ProviderPrice, ("mini", "acme"))
    entry.shutdown_date = price.shutdown_date = date(2026, 12, 1)
    for r in (await session.execute(select(Run))).scalars():
        r.created_at = NOW - timedelta(days=45)  # not run in the last 30 days
    await session.commit()
    assert await check_retirements(session, now=NOW) == []


async def test_an_already_retired_model_is_flagged(session):
    job = await make_job(session)
    session.add(run(job, NOW - timedelta(days=1), provider="acme"))
    await add_catalog(session, status="RETIRED", shutdown=date(2026, 11, 1))
    [a] = await check_retirements(session, now=NOW)
    assert a.detail["status"] == "RETIRED" and "has been retired" in a.detail["summary"]


# ---- the budget field on the API

@pytest.fixture
def dev_login(monkeypatch):
    monkeypatch.setenv("DEV_LOGIN", "true")


async def test_the_monthly_budget_can_be_set_validated_and_cleared(client, dev_login):
    assert (await client.post("/auth/dev/login", json={"email": "ana@example.com"})).status_code == 200
    project = (await client.post("/v1/projects", json={"name": "Demo"})).json()["project"]
    assert project["monthly_budget_usd"] is None
    url = f"/v1/projects/{project['project_id']}"
    assert (await client.patch(url, json={"monthly_budget_usd": 250.5})).json()["monthly_budget_usd"] == 250.5
    assert (await client.patch(url, json={"name": "Renamed"})).json()["monthly_budget_usd"] == 250.5  # untouched
    for bad in (0, -5, 10_000_001):
        assert (await client.patch(url, json={"monthly_budget_usd": bad})).status_code == 422
    assert (await client.patch(url, json={"monthly_budget_usd": None})).json()["monthly_budget_usd"] is None


async def test_f16_shadow_runs_do_not_count_towards_the_budget(session):
    job = await make_job(session, budget=Decimal("100"))
    await spend(session, job, [0], cost="90", kind="SHADOW")
    assert await check_budgets(session, now=NOW) == []


async def test_f17_the_text_never_rounds_up_to_a_level_not_reached(session):
    job = await make_job(session, budget=Decimal("100"))
    await spend(session, job, [0], cost="94.6")
    assert [a.detail["level"] for a in await check_budgets(session, now=NOW)] == ["85"]
    a = (await alerts(session, "BUDGET"))[0]
    assert "94%" in a.detail["summary"] and "95%" not in a.detail["summary"]


async def test_f15_a_first_run_on_the_day_seven_days_ago_is_enough_like_the_web_app(session):
    job = await make_job(session, budget=Decimal("100"))
    first = NOW.replace(hour=0, minute=0, second=0, microsecond=0) - timedelta(days=7) + timedelta(hours=12)
    session.add(run(job, first, cost=Decimal("40")))
    session.add_all(run(job, NOW - timedelta(days=d), cost=Decimal("10")) for d in [1, 2, 3, 4, 5, 6])
    await session.commit()
    levels = [a.detail["level"] for a in await check_budgets(session, now=NOW)]
    assert "PROJECTED" in levels
