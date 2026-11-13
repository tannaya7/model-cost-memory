"""Scheduled jobs leave heartbeats; /healthz/scheduler turns a stopped or failing job into a 503."""

from datetime import UTC, datetime, timedelta

import httpx
import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker

from agent_memory import heartbeat
from agent_memory.config import Settings
from agent_memory.heartbeat import INTERVALS, LEADER, overdue, record, tracked
from agent_memory.models import SchedulerHeartbeat

NOW = datetime(2026, 11, 13, 12, tzinfo=UTC)


@pytest.fixture
def sessions(engine):
    return async_sessionmaker(engine, expire_on_commit=False)


@pytest.fixture(autouse=True)
def quiet_operator():
    heartbeat._last_notified.clear()
    yield
    heartbeat._last_notified.clear()


async def _row(session, job):
    session.expire_all()
    return (await session.execute(select(SchedulerHeartbeat).where(SchedulerHeartbeat.job == job))).scalar_one()


async def test_a_job_that_finishes_records_its_success(sessions, session):
    async def work(sessions, settings=None):
        return 3

    assert await tracked("decay", work)(sessions, Settings()) == 3
    row = await _row(session, "decay")
    assert row.last_ok_at is not None and row.last_error is None


async def test_a_failing_job_records_the_error_and_does_not_raise(sessions, session):
    async def broken(sessions, settings=None):
        raise RuntimeError("database went away")

    assert await tracked("decay", broken)(sessions, Settings()) is None
    row = await _row(session, "decay")
    assert row.last_ok_at is None and "database went away" in row.last_error


async def test_a_job_that_reports_false_is_a_failure(sessions, session):
    async def gave_up(sessions, settings=None):
        return False  # the catalog sync's way of saying the price list could not be fetched

    await tracked("catalog-sync", gave_up)(sessions, Settings())
    row = await _row(session, "catalog-sync")
    assert row.last_ok_at is None and row.last_error


def test_every_scheduled_job_has_an_interval():
    with pytest.raises(ValueError):
        tracked("not-a-job", lambda *a: None)


async def test_the_operator_hears_about_a_failure_once_an_hour(sessions):
    posted = []
    transport = httpx.MockTransport(lambda request: posted.append(request.content) or httpx.Response(200))
    settings = Settings(operator_webhook_url="https://hooks.example/ops")
    assert await heartbeat.notify_operator(settings, "decay", "boom", transport=transport) is True
    assert await heartbeat.notify_operator(settings, "decay", "boom again", transport=transport) is False
    assert await heartbeat.notify_operator(settings, "regression", "boom", transport=transport) is True
    assert len(posted) == 2 and b"decay" in posted[0] and b"boom" in posted[0]
    assert await heartbeat.notify_operator(Settings(), "retests", "boom") is False  # no URL, no message


async def test_nothing_is_overdue_right_after_the_scheduler_starts(sessions, session):
    await record(sessions, LEADER, now=NOW)
    assert await overdue(session, now=NOW + timedelta(minutes=5)) == {}


async def test_a_job_with_no_success_inside_its_allowance_is_overdue(sessions, session):
    await record(sessions, LEADER, now=NOW)
    for job in INTERVALS:
        await record(sessions, job, now=NOW)
    later = NOW + timedelta(minutes=30)
    for job in INTERVALS:
        if job != "outbox-janitor":  # every job keeps up except the one-minute janitor
            await record(sessions, job, now=later)
    assert await overdue(session, now=later) == {"outbox-janitor": 30.0}
    # a daily job is late only after three days
    late = await overdue(session, now=NOW + timedelta(days=2))
    assert "catalog-sync" not in late and "outbox-janitor" in late


async def test_no_scheduler_at_all_means_every_job_is_overdue(session):
    late = await overdue(session, now=NOW)
    assert set(late) == set(INTERVALS) and set(late.values()) == {None}


async def test_the_health_endpoint_answers_503_without_error_text(client, sessions):
    assert (await client.get("/healthz/scheduler")).status_code == 503  # no scheduler has started
    now = datetime.now(UTC)
    await record(sessions, LEADER, now=now)
    for job in INTERVALS:
        await record(sessions, job, now=now)
    await record(sessions, "decay", error="password authentication failed for user memory", now=now)
    healthy = await client.get("/healthz/scheduler")
    assert healthy.status_code == 200 and healthy.json() == {"status": "ok", "overdue": {}}
    assert "password" not in healthy.text
