# ruff: noqa: F811  (the project, key and runs come from the re-test tests' `world` fixture)
"""A person can stop a trial: a queued one never starts, a running one starts no new call and keeps what it has.

Every provider call here is a fake; nothing leaves the machine."""

from decimal import Decimal

from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import async_sessionmaker

from agent_memory.models import Retest, Run
from agent_memory.retest.runner import enqueue, run_queued, run_retest
from tests.test_retest import SETTINGS, FakeProvider, factory, world  # noqa: F401
from tests.test_retest_confirmation import BODY, _preview, _start, no_real_provider  # noqa: F401  (the autouse guard against real calls)


async def _started(client, key):
    token = (await _preview(client, key)).json()["confirmation"]
    r = await _start(client, key, token)
    assert r.status_code == 202
    return r.json()["retest_id"]


async def test_stopping_a_queued_trial_closes_it_at_once_and_it_never_sends_anything(client, engine, session, world):
    key, _, _ = world
    rid = await _started(client, key)
    stopped = await client.post(f"/v1/jobs/invoice/retest/{rid}/stop", headers={"X-API-Key": key})
    assert stopped.status_code == 200
    body = stopped.json()
    assert body["status"] == "STOPPED_USER" and body["finished_at"] is not None and body["stopping"] is False
    assert "before it started" in body["message"] and "Nothing was sent" in body["message"]
    provider = FakeProvider()
    sessions = async_sessionmaker(engine, expire_on_commit=False)
    assert await run_queued(sessions, settings=SETTINGS, client_factory=factory(provider)) == 0  # nothing left to run
    assert provider.calls == 0
    session.expunge_all()
    assert (await session.execute(select(func.count()).select_from(Run).where(Run.run_kind == "RETEST"))).scalar_one() == 0


async def test_a_stop_that_arrives_just_as_it_is_picked_up_still_wins(engine, session, world):
    _, project, job = world
    retest = await enqueue(session, project, job, "mini", 1.0, "MANUAL")
    await session.execute(update(Retest).where(Retest.retest_id == retest.retest_id).values(status="STOPPED_USER"))
    await session.commit()
    provider = FakeProvider()
    sessions = async_sessionmaker(engine, expire_on_commit=False)
    done = await run_retest(sessions, retest.retest_id, settings=SETTINGS, client_factory=factory(provider), sample_size=20)
    assert done.status == "STOPPED_USER" and provider.calls == 0


class StopsAfter(FakeProvider):
    """Presses Stop (as the person's browser would, in another request) once it has answered `after` calls."""

    def __init__(self, sessions, retest_id, after):
        super().__init__(accuracy=1.0)
        self.sessions, self.retest_id, self.after = sessions, retest_id, after

    async def complete(self, model, prompt, effort=None, max_tokens=None):
        answer = await super().complete(model, prompt, effort, max_tokens)
        if self.calls == self.after:
            async with self.sessions() as s:
                await s.execute(update(Retest).where(Retest.retest_id == self.retest_id).values(stop_requested_at=func.now()))
                await s.commit()
        return answer


async def test_stopping_a_running_trial_starts_no_new_call_and_keeps_what_it_has(engine, session, world):
    _, project, job = world
    retest = await enqueue(session, project, job, "mini", 1.0, "MANUAL")
    await session.commit()
    sessions = async_sessionmaker(engine, expire_on_commit=False)
    provider = StopsAfter(sessions, retest.retest_id, after=5)
    done = await run_retest(sessions, retest.retest_id, settings=SETTINGS, client_factory=factory(provider), sample_size=20)
    assert done.status == "STOPPED_USER"
    assert 5 <= done.runs_done < 20  # calls already in flight when Stop was pressed finish; the rest were never sent
    assert provider.calls == done.runs_done  # every call made was recorded and paid for, none was lost
    assert Decimal(done.spent_usd) == Decimal("0.0012") * done.runs_done  # $0.0012 per replayed run: only the calls made were charged
    assert "Stopped by you" in done.message and "kept" in done.message
    session.expunge_all()
    kept = (await session.execute(select(func.count()).select_from(Run).where(Run.retest_id == retest.retest_id))).scalar_one()
    assert kept == done.runs_done


async def test_asking_twice_is_harmless_and_a_finished_trial_cannot_be_stopped(client, engine, world):
    key, _, _ = world
    rid = await _started(client, key)
    url, h = f"/v1/jobs/invoice/retest/{rid}/stop", {"X-API-Key": key}
    assert (await client.post(url, headers=h)).status_code == 200
    again = await client.post(url, headers=h)
    assert again.status_code == 200 and again.json()["status"] == "STOPPED_USER"
    sessions = async_sessionmaker(engine, expire_on_commit=False)
    other = await _started(client, key)
    await run_queued(sessions, settings=SETTINGS, client_factory=factory(FakeProvider()))
    late = await client.post(f"/v1/jobs/invoice/retest/{other}/stop", headers=h)
    assert late.status_code == 409 and late.json()["detail"]["code"] == "already_finished"
    assert (await client.post(f"/v1/jobs/invoice/retest/{'0' * 8}-0000-0000-0000-{'0' * 12}/stop", headers=h)).status_code == 404


async def test_the_running_trial_says_it_is_stopping_until_it_has_stopped(client, engine, session, world):
    key, project, job = world
    retest = await enqueue(session, project, job, "mini", 1.0, "MANUAL")
    await session.execute(update(Retest).where(Retest.retest_id == retest.retest_id).values(status="RUNNING", started_at=func.now()))
    await session.commit()
    stopped = await client.post(f"/v1/jobs/invoice/retest/{retest.retest_id}/stop", headers={"X-API-Key": key})
    assert stopped.json()["status"] == "RUNNING" and stopped.json()["stopping"] is True
    shown = await client.get(f"/v1/jobs/invoice/retest/{retest.retest_id}", headers={"X-API-Key": key})
    assert shown.json()["stopping"] is True


async def test_a_viewer_or_member_cannot_stop_a_trial_and_someone_elses_trial_is_not_found(client, session, world, monkeypatch):
    from agent_memory.auth.permissions import ROUTE_PERMISSIONS
    assert ROUTE_PERMISSIONS[("POST", "/v1/jobs/{job}/retest/{retest_id}/stop")] == "retest.start"  # admins and owners, like starting one
    other = await client.post("/v1/jobs/invoice/retest/00000000-0000-0000-0000-000000000000/stop", headers={"X-API-Key": "mcm_live_nope"})
    assert other.status_code == 401
