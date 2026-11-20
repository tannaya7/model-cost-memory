# ruff: noqa: F811  (the project, key and runs come from the re-test tests' `world` fixture)
"""A paid replay starts only after a person has seen a preview and confirmed it. Mocked provider only: no test here
makes a network call to a provider, and the provider's `complete` is made to fail loudly if anything reaches it by accident.

Real Postgres, made-up names and prices."""

import json
import uuid
from datetime import UTC, datetime, timedelta
from decimal import Decimal

import pytest
from sqlalchemy import func, select, text
from sqlalchemy.ext.asyncio import async_sessionmaker

from agent_memory.catalog.sync import CatalogRecord
from agent_memory.ingest import prompt_hash
from agent_memory.models import CatalogEntry, Job, Project, ProviderKey, Retest, Run
from agent_memory.retest import confirm as confirm_module
from agent_memory.retest import keys
from agent_memory.retest import provider as provider_module
from agent_memory.retest.runner import run_queued, start_for_new_models, start_on_first_key, start_when_unsure
from agent_memory.security import generate_key, hash_key
from tests.test_retest import SETTINGS, FakeProvider, factory, world  # noqa: F401  (the same made-up project, key and runs)

BODY = {"candidate_model": "mini", "budget_usd": 1.0, "sample_size": 10}


@pytest.fixture(autouse=True)
def no_real_provider(monkeypatch):
    async def boom(self, *a, **k):
        raise AssertionError("a real provider call was attempted")

    monkeypatch.setattr(provider_module.OpenAICompatible, "complete", boom)


async def _preview(client, key, **over):
    return await client.post("/v1/jobs/invoice/retest/preview", headers={"X-API-Key": key}, json={**BODY, **over})


async def _start(client, key, confirmation, **over):
    return await client.post("/v1/jobs/invoice/retest", headers={"X-API-Key": key}, json={**BODY, **over, "confirmation": confirmation})


# ---- the preview: what, where, how much, what stays untouched ----------------------------------------------------

async def test_the_preview_shows_what_is_sent_where_the_cost_range_and_what_stays_untouched(client, session, world):
    key, _, _ = world
    before = [(await session.execute(text(f"SELECT count(*) FROM {t}"))).scalar_one() for t in ("retests", "runs", "jobs")]
    got = (await _preview(client, key)).json()
    assert got["can_start"] is True and got["blocked"] is None and got["confirmation"] and got["expires_at"]
    assert got["destination_host"] == "acme.example" and got["provider"] == "acme"
    sent = [d for d in got["data"] if d["kind"] == "sent"]
    assert len(sent) == 1 and "10 past prompts" in sent[0]["what"] and "acme.example" in sent[0]["where"]
    kinds = {d["kind"]: d for d in got["data"]}
    assert "Not sent" in kinds["stays"]["where"] and kinds["never"]["where"] == "Never sent."
    assert "retention" in kinds["received"]["where"] and "90 days" in kinds["received"]["where"]
    cost = got["cost"]
    assert 0 < cost["low_usd"] <= cost["high_usd"] <= BODY["budget_usd"] and cost["worst_case_usd"] >= cost["high_usd"]
    assert cost["low_usd"] == pytest.approx(10 * 0.0012 * 100 / 100 * (1000 * 1 + 100 * 2) / 1200, rel=0.01)  # 10 prompts at list price
    assert got["price_basis"]["input_usd_per_mtok"] == 1.0 and "not your invoice" in got["price_basis"]["source"]
    assert "does not know" in got["retention_note"] and "acme.example" in got["retention_note"]
    joined = " ".join(got["statements"])
    assert "live traffic is not touched" in joined and "source code" in joined and "not added to your project" in joined
    assert "not repeated or scheduled" in joined
    assert "answer key" in got["evaluator"].lower() and got["evaluator_kind"] == "ANSWER_KEY"
    assert got["examples"]["planned"] == 10 and got["examples"]["available"] == 60
    # A preview only reads: nothing was queued, nothing recorded, nothing sent.
    after = [(await session.execute(text(f"SELECT count(*) FROM {t}"))).scalar_one() for t in ("retests", "runs", "jobs")]
    assert before == after


async def test_the_preview_says_why_it_cannot_start_instead_of_offering_a_confirmation(client, session, world):
    key, _, job = world
    await session.execute(text("UPDATE jobs SET retest_consent = false"))
    await session.commit()
    got = (await _preview(client, key)).json()
    assert got["can_start"] is False and got["confirmation"] is None and got["blocked"]["code"] == "consent_off"
    await session.execute(text("UPDATE jobs SET retest_consent = true"))
    await session.commit()
    unpriced = (await _preview(client, key, candidate_model="no-such-model")).json()
    assert unpriced["can_start"] is False and unpriced["blocked"]["code"] == "no_price" and unpriced["confirmation"] is None


# ---- the confirmation: single use, bound, short-lived -------------------------------------------------------------

async def test_a_replay_cannot_start_without_a_valid_confirmation(client, session, world):
    key, _, _ = world
    assert (await client.post("/v1/jobs/invoice/retest", headers={"X-API-Key": key}, json=BODY)).status_code == 422  # field required
    for bad in ("x" * 40, "not.a-token-at-all-but-long-enough"):
        r = await _start(client, key, bad)
        assert r.status_code == 409 and r.json()["detail"]["code"] == "confirmation_invalid"
    token = (await _preview(client, key)).json()["confirmation"]
    body, sig = token.split(".")
    tampered = await _start(client, key, f"{body}.{'A' * len(sig)}")
    assert tampered.json()["detail"]["code"] == "confirmation_invalid"
    assert (await session.execute(select(func.count()).select_from(Retest))).scalar_one() == 0  # nothing queued by any refusal


async def test_a_confirmation_is_for_exactly_what_was_previewed(client, session, world):
    key, _, _ = world
    token = (await _preview(client, key)).json()["confirmation"]
    for change in ({"budget_usd": 2.0}, {"candidate_model": "mini@low"}, {"sample_size": 11}, {"sample_size": None}):
        r = await _start(client, key, token, **change)
        assert r.status_code == 409 and r.json()["detail"]["code"] == "confirmation_mismatch", change
    assert (await session.execute(select(func.count()).select_from(Retest))).scalar_one() == 0
    assert (await _start(client, key, token)).status_code == 202  # the exact values start


async def test_a_confirmation_expires(client, world, monkeypatch):
    key, _, _ = world
    monkeypatch.setattr(confirm_module, "CONFIRM_MINUTES", -1)
    token = (await _preview(client, key)).json()["confirmation"]
    r = await _start(client, key, token)
    assert r.status_code == 409 and r.json()["detail"]["code"] == "confirmation_expired"


async def test_a_confirmation_works_once_only(client, engine, session, world):
    key, _, _ = world
    token = (await _preview(client, key)).json()["confirmation"]
    assert (await _start(client, key, token)).status_code == 202
    sessions = async_sessionmaker(engine, expire_on_commit=False)
    assert await run_queued(sessions, settings=SETTINGS, client_factory=factory(FakeProvider())) == 1
    again = await _start(client, key, token)  # the first replay is finished, so only the single-use rule can stop this
    assert again.status_code == 409 and again.json()["detail"]["code"] == "confirmation_used"
    assert (await session.execute(select(func.count()).select_from(Retest))).scalar_one() == 1


async def test_a_confirmation_cannot_be_used_in_another_project(client, session, world):
    key, _, _ = world
    token = (await _preview(client, key)).json()["confirmation"]
    other_key = generate_key()
    session.add(Project(project_id="other", api_key_hash=hash_key(other_key)))
    await session.flush()
    session.add(Job(project_id="other", name="invoice", check_kind="ANSWER_KEY", check_config={"fields": ["total"]}, retest_consent=True))
    await session.commit()
    r = await _start(client, other_key, token)
    assert r.status_code == 409 and r.json()["detail"]["code"] in ("confirmation_mismatch", "provider_key_required")
    assert (await session.execute(select(func.count()).select_from(Retest))).scalar_one() == 0


# ---- what is recorded ---------------------------------------------------------------------------------------------

async def test_a_confirmed_replay_records_who_what_when_price_basis_evaluator_and_sample(client, engine, session, world):
    key, _, _ = world
    started = (await _start(client, key, (await _preview(client, key)).json()["confirmation"])).json()
    assert started["status"] == "QUEUED" and started["confirmed_at"] and started["trigger"] == "MANUAL"
    sessions = async_sessionmaker(engine, expire_on_commit=False)
    provider = FakeProvider(accuracy=0.9)
    await run_queued(sessions, settings=SETTINGS, client_factory=factory(provider))
    got = (await client.get(f"/v1/jobs/invoice/retest/{started['retest_id']}", headers={"X-API-Key": key})).json()
    assert got["status"] == "DONE" and got["runs_done"] == 10 and got["sample_size"] == 10
    assert got["evaluator"] == "ANSWER_KEY" and got["provider_host"] == "acme.example"
    assert got["price_basis"]["input_usd_per_mtok"] == 1.0 and "invoice" in got["price_basis"]["source"]
    assert got["started_at"] and got["finished_at"] and got["created_at"]
    row = (await session.execute(select(Retest))).scalar_one()
    await session.refresh(row)
    assert len(row.sample_run_ids) == 10 and row.confirmation_hash and row.preview["can_start"] is True
    assert "confirmation" not in row.preview and "expires_at" not in row.preview
    assert "invoice 1" not in json.dumps(row.preview) and "invoice 1" not in json.dumps(row.sample_run_ids)  # ids, never text
    replays = (await session.execute(select(Run).where(Run.run_kind == "RETEST"))).scalars().all()
    assert len(replays) == 10 and {r.model_version for r in replays} == {"mini-2026-10-01"}  # the version the provider reported
    assert all(r.retest_id == row.retest_id for r in replays)


async def test_a_short_replay_is_shown_as_inconclusive_and_a_long_one_with_its_range(client, engine, session, world):
    key, _, _ = world
    sessions = async_sessionmaker(engine, expire_on_commit=False)
    small = (await _start(client, key, (await _preview(client, key)).json()["confirmation"])).json()
    await run_queued(sessions, settings=SETTINGS, client_factory=factory(FakeProvider()))
    got = (await client.get(f"/v1/jobs/invoice/retest/{small['retest_id']}", headers={"X-API-Key": key})).json()
    assert got["evidence"] == "inconclusive" and "Only 10 answers were checked" in got["evidence_note"] and "at least 25" in got["evidence_note"]
    assert got["pass_rate"] == 1.0 and got["pass_rate_low"] < 1.0  # the range is wide, so the rate is not a result
    await session.execute(text("UPDATE retests SET status = 'DONE'"))
    await session.execute(text("DELETE FROM outbox WHERE run_id IN (SELECT run_id FROM runs WHERE run_kind = 'RETEST')"))
    await session.execute(text("DELETE FROM runs WHERE run_kind = 'RETEST'"))
    await session.commit()
    body = {"candidate_model": "mini", "budget_usd": 1.0, "sample_size": 40}
    big = (await _start(client, key, (await _preview(client, key, **body)).json()["confirmation"], **body)).json()
    await run_queued(sessions, settings=SETTINGS, client_factory=factory(FakeProvider(accuracy=0.9)))
    got = (await client.get(f"/v1/jobs/invoice/retest/{big['retest_id']}", headers={"X-API-Key": key})).json()
    assert got["evidence"] == "enough" and got["pass_rate_low"] < got["pass_rate"] < got["pass_rate_high"]


# ---- no tools, no writes to the project, nothing automatic -------------------------------------------------------

async def test_runs_that_used_tools_are_never_replayed(client, engine, session, world):
    key, _, job = world
    for i in range(60, 70):
        session.add(Run(run_id=uuid.uuid4(), job_id=job.job_id, project_id="demo", prompt=f"TOOLUSER {i}", prompt_hash=prompt_hash(f"TOOLUSER {i}"),
                        model="big", model_version="big-2026-09", outcome="PASS", cost_usd=0.03, state="INDEXED", tokens_in=1000,
                        tokens_out=100, expected={"total": 100.0}, tool_call_count=2, tool_calls=[{"name": "t", "id": "c"}],
                        created_at=datetime.now(UTC) - timedelta(hours=i)))
    await session.commit()
    got = (await _preview(client, key, sample_size=100)).json()
    assert got["examples"]["left_out_for_tool_use"] == 10 and got["examples"]["available"] == 60 and got["examples"]["planned"] == 60

    seen = []

    class Recording(FakeProvider):
        async def complete(self, model, prompt, effort=None, max_tokens=None):
            seen.append(prompt)
            return await super().complete(model, prompt, effort, max_tokens)

    body = {"candidate_model": "mini", "budget_usd": 5.0, "sample_size": 100}
    await _start(client, key, (await _preview(client, key, **body)).json()["confirmation"], **body)
    await run_queued(async_sessionmaker(engine, expire_on_commit=False), settings=SETTINGS, client_factory=factory(Recording()))
    assert len(seen) == 60 and not any(p.startswith("TOOLUSER") for p in seen)


async def test_a_replay_never_writes_the_candidate_into_the_project(client, engine, session, world):
    key, _, _ = world
    snapshot = lambda: session.execute(text(  # noqa: E731
        "SELECT (SELECT md5(string_agg(p::text, '|' ORDER BY project_id)) FROM projects p WHERE project_id = 'demo'), "
        "(SELECT count(*) FROM jobs), (SELECT md5(string_agg(j.name || j.check_kind || j.check_config::text || j.retest_consent::text, '|')) FROM jobs j), "
        "(SELECT count(*) FROM model_catalog), (SELECT count(*) FROM runs WHERE run_kind = 'PRODUCTION')"))
    before = (await snapshot()).one()
    await _start(client, key, (await _preview(client, key)).json()["confirmation"])
    await run_queued(async_sessionmaker(engine, expire_on_commit=False), settings=SETTINGS, client_factory=factory(FakeProvider()))
    await session.rollback()
    after = (await snapshot()).one()
    assert before == after  # the project row, the tasks and their settings, the catalog and the production runs are all unchanged


async def test_automatic_paid_replays_are_off_unless_an_admin_turns_them_on(client, session, world):
    key = generate_key()
    session.add(Project(project_id="fresh", api_key_hash=hash_key(key), retest_monthly_cap_usd=Decimal("10")))  # no opt-in
    await session.flush()
    job = Job(project_id="fresh", name="invoice", check_kind="ANSWER_KEY", check_config={"fields": ["total"]}, retest_consent=True)
    session.add(job)
    await session.flush()
    for i in range(60):
        session.add(Run(run_id=uuid.uuid4(), job_id=job.job_id, project_id="fresh", prompt=f"p{i}", prompt_hash=prompt_hash(f"p{i}"),
                        model="big", model_version="big-2026-09", outcome="PASS", cost_usd=0.03, state="INDEXED", tokens_in=1000,
                        tokens_out=100, expected={"total": 100.0}, created_at=datetime.now(UTC) - timedelta(hours=i)))
    await session.commit()
    await keys.set_key(session, "fresh", provider="acme", api_key="sk-test-5678", base_url="https://acme.example/v1", settings=SETTINGS)
    await session.commit()
    fresh = await session.get(Project, "fresh")
    assert fresh.auto_retests is False  # the default
    new = [CatalogRecord("acme-nano", "acme-nano", "acme", Decimal("0.1"), Decimal("0.4"), None, "ACTIVE")]
    session.add(CatalogEntry(model="acme-nano", model_version="acme-nano", provider="acme", price_in_per_mtok=Decimal("0.1"), price_out_per_mtok=Decimal("0.4")))
    await session.flush()
    # (the shared `demo` project in this test did opt in, so only the new project's starts are looked at)
    mine = lambda rows: [r for r in rows if r.project_id == "fresh"]  # noqa: E731
    assert mine(await start_for_new_models(session, new, settings=SETTINGS)) == []
    assert await start_on_first_key(session, fresh, settings=SETTINGS) == []
    assert mine(await start_when_unsure(session, settings=SETTINGS)) == []
    assert (await session.execute(select(func.count()).select_from(Retest).where(Retest.project_id == "fresh"))).scalar_one() == 0
    # An admin opts in, on purpose, and only then can an automatic start happen.
    fresh.auto_retests = True
    await session.flush()
    assert [(r.candidate_model, r.trigger) for r in mine(await start_for_new_models(session, new, settings=SETTINGS))] == [("acme-nano", "NEW_MODEL")]


async def test_a_signed_in_admin_turns_automatic_replays_on_and_a_member_cannot(client, monkeypatch):
    monkeypatch.setenv("DEV_LOGIN", "true")
    monkeypatch.setenv("AUTO_REPLAYS", "true")  # the operator has allowed them on this server
    await client.post("/auth/dev/login", json={"email": "owner@example.com"})
    org = (await client.post("/v1/organisations", json={"name": "Acme"})).json()["org_id"]
    made = (await client.post("/v1/projects", json={"name": "P", "organisation_id": org})).json()["project"]
    assert made["auto_retests"] is False
    assert (await client.patch(f"/v1/projects/{made['project_id']}", json={"auto_retests": True})).json()["auto_retests"] is True
    token = (await client.post(f"/v1/organisations/{org}/invites", json={"email": "m@example.com", "role": "member"})).json()["token"]
    await client.post("/auth/logout")
    await client.post("/auth/dev/login", json={"email": "m@example.com"})
    await client.post("/v1/invites/accept", json={"token": token})
    assert (await client.patch(f"/v1/projects/{made['project_id']}", json={"auto_retests": False})).status_code == 403
    for method in ("preview", ""):
        r = await client.post(f"/v1/jobs/x/retest{'/' + method if method else ''}", headers={"X-Project-Id": made["project_id"]}, json={**BODY, "confirmation": "x" * 30})
        assert r.status_code == 403  # a member cannot start or even preview a paid replay


async def test_only_this_projects_data_is_ever_in_a_preview(client, session, world):
    key, _, _ = world
    other_key = generate_key()
    session.add(Project(project_id="other", api_key_hash=hash_key(other_key)))
    await session.flush()
    oj = Job(project_id="other", name="invoice", check_kind="ANSWER_KEY", check_config={"fields": ["total"]}, retest_consent=True)
    session.add(oj)
    await session.flush()
    session.add(Run(run_id=uuid.uuid4(), job_id=oj.job_id, project_id="other", prompt="THEIR SECRET", prompt_hash=prompt_hash("THEIR SECRET"),
                    model="big", model_version="big-1", outcome="PASS", cost_usd=0.03, state="INDEXED", tokens_in=1000, tokens_out=100,
                    expected={"total": 1.0}))
    await session.commit()
    got = await _preview(client, key)
    assert "THEIR SECRET" not in got.text and "invoice 1" not in got.text  # no prompt text in a preview at all
    assert got.json()["examples"]["available"] == 60
    assert (await client.post("/v1/jobs/nope/retest/preview", headers={"X-API-Key": key}, json=BODY)).status_code == 404


def test_nothing_schedules_a_paid_replay_by_default():
    """The scheduler's re-test jobs only ever pick up what a person confirmed or a project explicitly opted into."""
    import inspect

    from agent_memory import scheduler
    from agent_memory.retest import runner
    assert "auto_retests" in inspect.getsource(runner._eligible_jobs) and "auto_retests" in inspect.getsource(runner.start_on_first_key)
    assert "QUEUED" in inspect.getsource(runner.run_queued)
    assert ProviderKey.__tablename__ == "provider_keys" and scheduler is not None


async def test_a_run_with_a_json_null_or_empty_tool_list_still_counts_as_tool_free(session, world):
    """Retention clears tool calls to a JSON null, and some apps send an empty list: neither used a tool."""
    from agent_memory.retest.runner import sample_sources
    _, _, job = world
    await session.execute(text("UPDATE runs SET tool_calls = 'null'::jsonb WHERE prompt LIKE 'invoice 1%'"))
    await session.execute(text("UPDATE runs SET tool_calls = '[]'::jsonb WHERE prompt LIKE 'invoice 2%'"))
    await session.commit()
    got = await sample_sources(session, job, "mini", 500)
    assert len(got) == 60


async def test_automatic_replays_are_off_on_a_server_unless_the_operator_allows_them(client, monkeypatch, session):
    monkeypatch.setenv("DEV_LOGIN", "true")
    monkeypatch.delenv("AUTO_REPLAYS", raising=False)
    await client.post("/auth/dev/login", json={"email": "owner@example.com"})
    assert (await client.get("/auth/config")).json()["auto_replays"] is False
    org = (await client.post("/v1/organisations", json={"name": "Acme"})).json()["org_id"]
    made = (await client.post("/v1/projects", json={"name": "P", "organisation_id": org})).json()["project"]
    refused = await client.patch(f"/v1/projects/{made['project_id']}", json={"auto_retests": True})
    assert refused.status_code == 422 and "switched off on this server" in refused.json()["detail"]
    assert (await client.patch(f"/v1/projects/{made['project_id']}", json={"auto_retests": False})).status_code == 200  # turning off is always fine
    monkeypatch.setenv("AUTO_REPLAYS", "true")
    assert (await client.get("/auth/config")).json()["auto_replays"] is True


async def test_with_the_server_switch_off_no_trigger_starts_anything_even_for_a_project_that_opted_in(session, world):
    off = SETTINGS.model_copy(update={"auto_replays": False}) if hasattr(SETTINGS, "model_copy") else __import__("dataclasses").replace(SETTINGS, auto_replays=False)
    project = await session.get(Project, "demo")
    assert project.auto_retests is True  # this project opted in
    new = [CatalogRecord("acme-nano", "acme-nano", "acme", Decimal("0.1"), Decimal("0.4"), None, "ACTIVE")]
    session.add(CatalogEntry(model="acme-nano", model_version="acme-nano", provider="acme", price_in_per_mtok=Decimal("0.1"), price_out_per_mtok=Decimal("0.4")))
    await session.flush()
    assert await start_for_new_models(session, new, settings=off) == []
    assert await start_on_first_key(session, project, settings=off) == []
    assert await start_when_unsure(session, settings=off) == []
