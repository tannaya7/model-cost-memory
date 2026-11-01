"""The re-test runner against a real Postgres, with a fake provider. Names and prices are made up."""

import uuid
from datetime import UTC, datetime, timedelta
from decimal import Decimal

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker

from agent_memory.catalog.sync import CatalogRecord
from agent_memory.config import Settings
from agent_memory.ingest import prompt_hash
from agent_memory.models import CatalogEntry, Job, Project, ProviderKey, ProviderPrice, Retest, Run
from agent_memory.retest import keys
from agent_memory.retest.provider import RateLimited
from agent_memory.retest.runner import (
    RetestRefused,
    enqueue,
    run_queued,
    first_key_candidate,
    run_retest,
    sample_sources,
    spent_this_month,
    start_for_new_models,
    start_on_first_key,
)
from agent_memory.security import decrypt, generate_key, hash_key

SETTINGS = Settings(secret_key="test-secret", retest_concurrency=2, retest_default_sample=20)


class FakeProvider:
    """Answers with the right total `accuracy` of the time, like a model would."""

    def __init__(self, accuracy=1.0, fail_after=None):
        self.accuracy, self.fail_after, self.calls = accuracy, fail_after, 0

    async def complete(self, model, prompt):
        self.calls += 1
        if self.fail_after is not None and self.calls > self.fail_after:
            raise RateLimited("429")
        right = (self.calls % 10) < self.accuracy * 10  # e.g. 0.9: every tenth answer is wrong
        return {"model": f"{model}-2026-10-01", "usage": {"prompt_tokens": 1000, "completion_tokens": 100},
                "choices": [{"message": {"content": '{"total": %s}' % (100.0 if right else 1.0)}}]}


@pytest.fixture
async def world(session):
    key = generate_key()
    session.add(Project(project_id="demo", api_key_hash=hash_key(key), retest_monthly_cap_usd=Decimal("10")))
    session.add(CatalogEntry(model="mini", model_version="mini", provider="acme", price_in_per_mtok=Decimal("1"),
                             price_out_per_mtok=Decimal("2")))  # $0.0012 per replayed run
    await session.flush()
    job = Job(project_id="demo", name="invoice", check_kind="ANSWER_KEY", check_config={"fields": ["total"]},
              retest_consent=True)
    session.add(job)
    await session.flush()
    for i in range(60):
        session.add(Run(
            run_id=uuid.uuid4(), job_id=job.job_id, project_id="demo", prompt=f"invoice {i}",
            prompt_hash=prompt_hash(f"invoice {i}"),
            model="big", model_version="big-2026-09", outcome="PASS", cost_usd=0.03, state="INDEXED",
            tokens_in=1000, tokens_out=100, expected={"total": 100.0},
            importance_score=3.0 if i < 10 else 1.0, created_at=datetime.now(UTC) - timedelta(hours=i),
        ))
    await session.commit()
    project = await session.get(Project, "demo")
    await keys.set_key(session, "demo", provider="acme", api_key="sk-test-1234", base_url="https://acme.example/v1",
                       settings=SETTINGS)
    await session.commit()
    return key, project, job


def factory(provider):
    return lambda key, settings: provider


async def test_the_provider_key_is_encrypted_and_only_its_hint_is_kept(session, world):
    row = await session.get(ProviderKey, "demo")
    assert row.key_hint == "1234" and "sk-test" not in row.key_encrypted
    assert decrypt(row.key_encrypted, "test-secret") == "sk-test-1234"


async def test_a_re_test_replays_runs_records_them_and_stays_within_budget(engine, session, world):
    _, project, job = world
    retest = await enqueue(session, project, job, "mini", 1.0, "MANUAL")
    await session.commit()
    provider = FakeProvider(accuracy=0.9)
    sessions = async_sessionmaker(engine, expire_on_commit=False)
    done = await run_retest(sessions, retest.retest_id, settings=SETTINGS, client_factory=factory(provider),
                            sample_size=20)
    assert done.status == "DONE"
    assert (done.runs_planned, done.runs_done, done.passed + done.failed) == (20, 20, 20)
    assert done.failed >= 1  # 90% accurate
    assert Decimal(done.spent_usd) == Decimal("0.024000")  # 20 x (1000 x $1 + 100 x $2) / 1M
    session.expunge_all()
    replayed = (await session.execute(select(Run).where(Run.retest_id == retest.retest_id))).scalars().all()
    assert len(replayed) == 20 and {r.run_kind for r in replayed} == {"RETEST"}
    assert {r.model_version for r in replayed} == {"mini-2026-10-01"}
    assert {r.provider for r in replayed} == {"acme"}  # priced at the key's provider's rate
    assert await spent_this_month(session, "demo") == Decimal("0.024000")


async def test_the_budget_stops_a_re_test_before_it_is_exceeded(engine, session, world):
    _, project, job = world
    retest = await enqueue(session, project, job, "mini", 0.005, "MANUAL")  # room for 4 runs at $0.0012
    await session.commit()
    sessions = async_sessionmaker(engine, expire_on_commit=False)
    done = await run_retest(sessions, retest.retest_id, settings=SETTINGS, client_factory=factory(FakeProvider()),
                            sample_size=20)
    assert done.status == "STOPPED_BUDGET" and done.runs_done == 4
    assert Decimal(done.spent_usd) <= Decimal("0.005")


async def test_the_monthly_cap_stops_a_re_test(engine, session, world):
    _, project, job = world
    project.retest_monthly_cap_usd = Decimal("0.01")  # whole cents; room for 8 runs at $0.0012
    await session.commit()
    retest = await enqueue(session, project, job, "mini", 1.0, "MANUAL")
    await session.commit()
    sessions = async_sessionmaker(engine, expire_on_commit=False)
    done = await run_retest(sessions, retest.retest_id, settings=SETTINGS, client_factory=factory(FakeProvider()),
                            sample_size=20)
    assert done.status == "STOPPED_CAP" and done.runs_done == 8


async def test_a_provider_that_keeps_rate_limiting_fails_with_partial_results(engine, session, world):
    _, project, job = world
    retest = await enqueue(session, project, job, "mini", 1.0, "MANUAL")
    await session.commit()
    sessions = async_sessionmaker(engine, expire_on_commit=False)
    done = await run_retest(sessions, retest.retest_id, settings=SETTINGS,
                            client_factory=factory(FakeProvider(fail_after=5)), sample_size=20)
    assert done.status == "FAILED" and 0 < done.runs_done <= 6
    assert "too many requests" in done.message


async def test_a_prompt_is_never_replayed_twice_on_the_same_model(engine, session, world):
    _, project, job = world
    first = await sample_sources(session, job, "mini", 60)
    assert len(first) == 60
    retest = await enqueue(session, project, job, "mini", 1.0, "MANUAL")
    await session.commit()
    sessions = async_sessionmaker(engine, expire_on_commit=False)
    await run_retest(sessions, retest.retest_id, settings=SETTINGS, client_factory=factory(FakeProvider()),
                     sample_size=20)
    assert len(await sample_sources(session, job, "mini", 60)) == 40


async def test_sampling_prefers_important_runs(session, world):
    _, _, job = world
    picked = await sample_sources(session, job, "mini", 10, seed=7)
    important = sum(int(r.prompt.split()[1]) < 10 for r in picked)
    assert important >= 4  # 10 of 60 runs weigh 3x: far more than the 1-2 a uniform draw would give


@pytest.mark.parametrize(
    ("change", "code"),
    [
        (lambda p, j: setattr(j, "retest_consent", False), "consent_off"),
        (lambda p, j: setattr(p, "retest_allowed", False), "project_off"),
        (lambda p, j: setattr(j, "check_kind", "LATE_LABEL"), "not_checkable"),
    ],
)
async def test_re_tests_refuse_to_start_without_consent(session, world, change, code):
    _, project, job = world
    change(project, job)
    with pytest.raises(RetestRefused) as exc:
        await enqueue(session, project, job, "mini", 1.0, "MANUAL")
    assert exc.value.code == code


async def test_without_a_provider_key_the_web_app_is_told_to_ask_for_it(client, session, world):
    key, _, _ = world
    await session.delete(await session.get(ProviderKey, "demo"))
    await session.commit()
    response = await client.post("/v1/jobs/invoice/retest", headers={"X-API-Key": key},
                                 json={"candidate_model": "mini", "budget_usd": 1})
    assert response.status_code == 409
    assert response.json()["detail"]["code"] == "provider_key_required"


async def test_the_api_queues_a_re_test_and_reports_progress_and_limits(client, engine, world):
    key, _, _ = world
    headers = {"X-API-Key": key}
    assert (await client.post("/v1/jobs/invoice/retest", headers=headers,
                              json={"candidate_model": "mini", "budget_usd": 0})).status_code == 422
    queued = (await client.post("/v1/jobs/invoice/retest", headers=headers,
                                json={"candidate_model": "mini", "budget_usd": 1, "sample_size": 10})).json()
    assert (queued["status"], queued["runs_planned"], queued["trigger"]) == ("QUEUED", 10, "MANUAL")
    again = await client.post("/v1/jobs/invoice/retest", headers=headers,
                              json={"candidate_model": "mini", "budget_usd": 1})
    assert again.json()["detail"]["code"] == "already_running"

    sessions = async_sessionmaker(engine, expire_on_commit=False)
    assert await run_queued(sessions, settings=SETTINGS, client_factory=factory(FakeProvider())) == 1
    progress = (await client.get(f"/v1/jobs/invoice/retest/{queued['retest_id']}", headers=headers)).json()
    assert (progress["status"], progress["runs_done"], progress["pass_rate"]) == ("DONE", 10, 1.0)
    limits = (await client.get("/v1/retest/limits", headers=headers)).json()
    assert limits["spent_this_month_usd"] == pytest.approx(0.012)
    assert limits["cap_remaining_usd"] == pytest.approx(10 - 0.012)
    assert limits["provider_key"]["key_hint"] == "1234"
    assert len((await client.get("/v1/jobs/invoice/retests", headers=headers)).json()) == 1


async def test_the_provider_key_can_be_set_and_removed_through_the_api(client, world, monkeypatch):
    key, _, _ = world
    headers = {"X-API-Key": key}
    monkeypatch.setenv("SECRET_KEY", "another-secret")
    put = await client.put("/v1/provider-key", headers=headers, json={"provider": "gemini", "api_key": "AIza-abcdefgh"})
    assert put.status_code == 200
    assert put.json()["base_url"].startswith("https://generativelanguage.googleapis.com")
    assert put.json()["key_hint"] == "efgh" and "api_key" not in put.json()
    assert (await client.delete("/v1/provider-key", headers=headers)).status_code == 204
    assert (await client.get("/v1/retest/limits", headers=headers)).json()["provider_key"] is None
    monkeypatch.setenv("SECRET_KEY", "")
    refused = await client.put("/v1/provider-key", headers=headers, json={"provider": "openai", "api_key": "sk-12345678"})
    assert refused.status_code == 503


async def test_a_cheaper_new_model_from_the_keys_provider_is_re_tested_automatically(session, world):
    _, project, job = world
    new = [
        CatalogRecord("acme-nano", "acme-nano", "acme", Decimal("0.1"), Decimal("0.4"), None, "ACTIVE"),
        CatalogRecord("other-nano", "other-nano", "other", Decimal("0.1"), Decimal("0.4"), None, "ACTIVE"),
        CatalogRecord("acme-huge", "acme-huge", "acme", Decimal("100"), Decimal("400"), None, "ACTIVE"),
    ]
    for rec in new:  # the catalog sync stores them before it reports them as new
        session.add(CatalogEntry(model=rec.model, model_version=rec.model_version, provider=rec.provider,
                                 price_in_per_mtok=rec.price_in_per_mtok, price_out_per_mtok=rec.price_out_per_mtok))
    await session.flush()
    started = await start_for_new_models(session, new, settings=SETTINGS)
    assert [(r.candidate_model, r.trigger) for r in started] == [("acme-nano", "NEW_MODEL")]
    assert started[0].budget_usd == Decimal("1")
    assert (await session.execute(select(Retest))).scalars().all()[0].status == "QUEUED"


async def test_an_early_stop_stops_the_calls_still_queued(engine, session, world):
    # Every answer wrong: clearly worse than big after the first checks. All 50 sources are queued at
    # once; the stop must hold back the ones still waiting for a slot, not only the ones not yet queued.
    _, project, job = world
    retest = await enqueue(session, project, job, "mini", 5.0, "MANUAL")
    await session.commit()
    sessions = async_sessionmaker(engine, expire_on_commit=False)
    provider = FakeProvider(accuracy=0.0)
    done = await run_retest(sessions, retest.retest_id, settings=SETTINGS, client_factory=factory(provider),
                            sample_size=50)
    assert done.status == "DONE" and done.message.startswith("Stopped early: clearly worse than big")
    assert done.runs_planned == 50
    assert done.runs_done < 50 and provider.calls == done.runs_done
    assert done.runs_done <= 30 + SETTINGS.retest_concurrency  # stopped at a check, plus the calls in flight


async def test_a_model_with_no_known_price_is_never_re_tested(engine, session, world):
    # Its calls would count as free, so neither the budget nor the monthly cap could stop it.
    _, project, job = world
    with pytest.raises(RetestRefused) as refused:
        await enqueue(session, project, job, "unpriced-model", 1.0, "MANUAL")
    assert refused.value.code == "no_price"
    # Queued while priced, then the price disappeared: nothing is replayed.
    retest = await enqueue(session, project, job, "mini", 1.0, "MANUAL")
    await session.commit()
    await session.delete(await session.get(CatalogEntry, ("mini", "mini")))
    await session.commit()
    provider = FakeProvider()
    done = await run_retest(async_sessionmaker(engine, expire_on_commit=False), retest.retest_id, settings=SETTINGS,
                            client_factory=factory(provider), sample_size=10)
    assert (done.status, done.runs_done, provider.calls) == ("FAILED", 0, 0)
    assert "No price is known for mini" in done.message


def test_the_first_key_candidate_is_the_priciest_model_at_half_the_cost_or_less():
    offers = [("nano", Decimal("0.001")), ("small", Decimal("0.012")), ("mid", Decimal("0.02")),
              ("same", Decimal("0.03")), ("huge", Decimal("0.3"))]
    assert first_key_candidate(Decimal("0.03"), offers) == "small"  # mid saves only a third
    assert first_key_candidate(Decimal("0.03"), [("mid", Decimal("0.02"))]) == "mid"  # nothing at half: any saving
    assert first_key_candidate(Decimal("0.03"), [("huge", Decimal("0.3"))]) is None


async def test_a_job_that_only_used_one_model_gets_one_re_test_when_the_key_is_first_given(session, world):
    _, project, job = world  # 60 runs of big at $0.03, nothing else measured
    for model, price_in, price_out in (("acme-small", "10", "20"), ("acme-nano", "0.1", "0.4"),
                                       ("acme-mid", "18", "40")):
        session.add(ProviderPrice(model=model, provider="acme", price_in_per_mtok=Decimal(price_in),
                                  price_out_per_mtok=Decimal(price_out)))
        session.add(CatalogEntry(model=model, model_version=model, provider="acme",
                                 price_in_per_mtok=Decimal(price_in), price_out_per_mtok=Decimal(price_out)))
    session.add(ProviderPrice(model="other-small", provider="other", price_in_per_mtok=Decimal("10"),
                              price_out_per_mtok=Decimal("20")))
    await session.flush()
    started = await start_on_first_key(session, project, settings=SETTINGS)
    # Per run: small $0.012 (at most half of $0.03, and the priciest such), mid $0.022, nano $0.00014.
    assert [(r.candidate_model, r.trigger, r.budget_usd) for r in started] == [("acme-small", "FIRST_KEY", Decimal("1"))]
    assert await start_on_first_key(session, project, settings=SETTINGS) == []  # once per job


async def test_a_job_that_already_compares_models_gets_no_first_key_re_test(session, world):
    _, project, job = world
    for i in range(40):
        session.add(Run(run_id=uuid.uuid4(), job_id=job.job_id, project_id="demo", prompt=f"retest {i}",
                        prompt_hash=prompt_hash(f"retest {i}"), model="mini", model_version="mini", outcome="PASS",
                        cost_usd=0.001, state="INDEXED", run_kind="RETEST"))
    session.add(ProviderPrice(model="acme-small", provider="acme", price_in_per_mtok=Decimal("10"),
                              price_out_per_mtok=Decimal("20")))
    await session.flush()
    assert await start_on_first_key(session, project, settings=SETTINGS) == []

