"""Regressions for the security and privacy audit (2026-11-16): each test failed before its fix."""

import json
import uuid
from datetime import UTC, datetime, timedelta

import httpx
import pytest
from sqlalchemy import update

from agent_memory import api as api_module
from agent_memory.alerts.notifier import deliver_pending
from agent_memory.auth import routes as auth_routes
from agent_memory.config import Settings, startup_problems
from agent_memory.csrf import cross_site
from agent_memory.models import Alert, Job, Project, Run, TaskSummary
from agent_memory.projects import create_project
from agent_memory.recommend import task_summary
from agent_memory.recommend.task_summary import sanitize
from agent_memory.retention import clear_old_content
from agent_memory.urls import _public

LONG = "x" * 40


# 1. rate limit -------------------------------------------------------------------------------------------

async def test_a_new_random_key_each_request_does_not_escape_the_ip_limit(client, monkeypatch):
    monkeypatch.setenv("RATE_LIMIT_KEY_PER_MINUTE", "5")
    statuses = [(await client.get("/v1/jobs", headers={"X-API-Key": f"mcm_{uuid.uuid4().hex}"})).status_code
                for _ in range(8)]
    assert statuses[:5] == [401] * 5 and set(statuses[5:]) == {429}


async def test_a_busy_real_key_still_gets_its_own_rate(client, monkeypatch, session):
    monkeypatch.setenv("RATE_LIMIT_KEY_PER_MINUTE", "5")
    monkeypatch.setenv("RATE_LIMIT_IP_PER_MINUTE", "1")
    _, key = await create_project(session, "busy-sdk")
    await session.commit()
    codes = [(await client.get("/v1/jobs", headers={"X-API-Key": key})).status_code for _ in range(5)]
    assert codes == [200] * 5  # the keyless IP rate (1) does not apply to a keyed caller


# 2. startup settings -------------------------------------------------------------------------------------

@pytest.mark.parametrize("kwargs", [
    {"public_url": "HTTPS://mcm.example", "secret_key": LONG, "dev_login": True},
    {"public_url": "https://mcm.example", "secret_key": LONG, "dev_login": True},
    {"public_url": "http://localhost:5174", "domain": "mcm.example", "dev_login": True},
    {"public_url": "http://203.0.113.9:8000", "dev_login": True},
])
def test_dev_login_is_refused_on_a_real_server(kwargs):
    assert any("DEV_LOGIN" in p for p in startup_problems(Settings(**kwargs)))


def test_private_urls_are_refused_for_an_upper_case_https_url():
    problems = startup_problems(Settings(public_url="HTTPS://mcm.example", secret_key=LONG, allow_private_urls=True))
    assert any("ALLOW_PRIVATE_URLS" in p for p in problems)


def test_dev_login_still_works_on_a_laptop():
    assert startup_problems(Settings(public_url="http://localhost:5174", dev_login=True)) == []


# 3. embedded IPv4 in IPv6 --------------------------------------------------------------------------------

@pytest.mark.parametrize("address", ["64:ff9b::7f00:1", "64:ff9b::a00:1", "2002:7f00:1::1", "2002:c0a8:101::1",
                                     "2001:0:4136:e378:8000:63bf:3fff:fdd2", "::7f00:1", "64:ff9b:1::1"])
def test_ipv6_forms_that_carry_a_private_ipv4_are_refused(address):
    assert not _public(address)


@pytest.mark.parametrize("address", ["64:ff9b::808:808", "2002:808:808::1", "2606:4700::1111"])
def test_ipv6_forms_that_carry_a_public_ipv4_pass(address):
    assert _public(address)


# 4. consent needs the signed-in owner --------------------------------------------------------------------

async def _owner(client, session, monkeypatch, project_id):
    monkeypatch.setenv("DEV_LOGIN", "true")
    me = (await client.post("/auth/dev/login", json={"email": f"{project_id}@example.com"})).json()
    await session.execute(update(Project).where(Project.project_id == project_id)
                          .values(owner_user_id=uuid.UUID(me["user_id"])))
    await session.commit()
    return {"X-Project-Id": project_id}


async def test_a_project_key_cannot_switch_task_summaries_on(client, session):
    _, key = await create_project(session, "consent-key")
    await session.commit()
    refused = await client.put("/v1/task-summary-consent", json={"enabled": True}, headers={"X-API-Key": key})
    assert refused.status_code == 401
    session.expire_all()
    assert (await session.get(Project, "consent-key")).task_summary_consent is False


async def test_the_owner_can_switch_it_and_someone_elses_project_is_404(client, session, monkeypatch):
    await create_project(session, "consent-own")
    await create_project(session, "consent-other")
    await session.commit()
    owner = await _owner(client, session, monkeypatch, "consent-own")
    assert (await client.put("/v1/task-summary-consent", json={"enabled": True}, headers=owner)).status_code == 200
    other = await client.put("/v1/task-summary-consent", json={"enabled": True},
                             headers={"X-Project-Id": "consent-other"})
    assert other.status_code == 404


# 5. sanitize ---------------------------------------------------------------------------------------------

@pytest.mark.parametrize("raw, leak", [
    ("key AKIAIOSFODNN7EXAMPLE here", "AKIAIOSFODNN7EXAMPLE"),
    ("login password=hunter2secret ok", "hunter2secret"),
    ("api_key: AbCd1234 ok", "AbCd1234"),
    ("Authorization: Bearer abc.def.ghi", "abc.def.ghi"),
    ("use Bearer tok_12345678 now", "tok_12345678"),
    ("jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.abcDEF123", "eyJzdWIi"),
    ("https://bob:pw@host.io/a", "bob:pw"),
    ("postgres://user:pass@db:5432/app", "user:pass"),
    ("mongodb+srv://u:p@cluster0.example.net/db", "cluster0"),
    ("mysql://root:secret@10.0.0.1/x", "root:secret"),
    ("mail bob [at] example [dot] com", "example [dot]"),
    ("mail bob(at)example.com", "bob(at)"),
    ("mail bob at example dot com", "bob at"),
    ("hash deadbeefcafebabe1234 id", "deadbeefcafebabe"),
    ("number 1234567890123456", "1234567890123456"),
])
def test_sanitize_masks_more_secrets(raw, leak):
    assert leak not in sanitize(raw)


def test_sanitize_keeps_ordinary_words():
    text = "Extract the total at the bottom; token limit is 4000 and the passwordless flow stays"
    assert sanitize(text) == text


# 6. summaries go with consent and with the text ----------------------------------------------------------

async def _job_with_summary(session, project_id, *, old=False):
    await create_project(session, project_id)
    job = Job(project_id=project_id, name="invoice", check_kind="LATE_LABEL", check_config={})
    session.add(job)
    await session.flush()
    created = datetime.now(UTC) - timedelta(days=200 if old else 0)
    session.add(Run(run_id=uuid.uuid4(), job_id=job.job_id, project_id=project_id, prompt="p", output="o",
                    prompt_hash="h", model="m", model_version="m-1", tokens_in=1, tokens_out=1,
                    run_kind="PRODUCTION", created_at=created))
    session.add(TaskSummary(job_id=job.job_id, fingerprint="f", summary="It does invoices.", prompt_version="v",
                            attempts=1, attempted_at=datetime.now(UTC)))
    await session.commit()
    session.expunge(job)  # a plain holder of job_id, never expired by later commits
    return job


async def test_turning_consent_off_deletes_the_stored_summaries(client, session, monkeypatch):
    job = await _job_with_summary(session, "sum-consent")
    owner = await _owner(client, session, monkeypatch, "sum-consent")
    await client.put("/v1/task-summary-consent", json={"enabled": True}, headers=owner)
    session.expire_all()
    assert await session.get(TaskSummary, job.job_id) is not None
    await client.put("/v1/task-summary-consent", json={"enabled": False}, headers=owner)
    session.expire_all()
    assert await session.get(TaskSummary, job.job_id) is None


async def test_clearing_old_prompts_deletes_the_summary_made_from_them(session):
    old = await _job_with_summary(session, "sum-old", old=True)
    fresh = await _job_with_summary(session, "sum-fresh")
    assert await clear_old_content(session) >= 1
    session.expire_all()
    assert await session.get(TaskSummary, old.job_id) is None
    assert await session.get(TaskSummary, fresh.job_id) is not None


# 7. per-project share of the daily cap -------------------------------------------------------------------

async def test_one_project_cannot_use_the_whole_daily_summary_limit(session):
    assert task_summary.PROJECT_DAILY_LIMIT == 50
    hog = await _job_with_summary(session, "sum-hog")
    other = await _job_with_summary(session, "sum-other")
    await session.execute(update(TaskSummary).where(TaskSummary.job_id == hog.job_id)
                          .values(attempts=task_summary.PROJECT_DAILY_LIMIT))
    await session.commit()
    settings = Settings()  # server limit 200: the hog is under it but over its own share
    now = datetime.now(UTC)
    assert not await task_summary._claim(session, hog, "new-fp", "v2", settings, now)
    assert await task_summary._claim(session, other, "new-fp", "v2", settings, now)


# 8. cross-site requests ----------------------------------------------------------------------------------

def test_cross_site_policy():
    s = Settings(public_url="http://localhost:5174")
    host = {"host": "mcm.example"}
    assert not cross_site({**host, "origin": "http://mcm.example"}, s)  # same origin
    assert not cross_site({**host, "origin": "http://localhost:5174"}, s)  # the dev proxy / PUBLIC_URL
    assert cross_site({**host, "origin": "https://evil.example"}, s)
    assert cross_site({**host, "origin": "null"}, s)
    assert cross_site({**host, "origin": "https://evil.mcm.example"}, s)  # a sibling subdomain
    assert not cross_site(host, s)  # no Origin, no Sec-Fetch-Site: curl, older clients
    assert not cross_site({**host, "sec-fetch-site": "same-origin"}, s)
    assert cross_site({**host, "sec-fetch-site": "cross-site"}, s)
    assert cross_site({**host, "sec-fetch-site": "same-site"}, s)


async def test_a_cross_site_post_with_the_session_cookie_is_refused(client, monkeypatch):
    monkeypatch.setenv("DEV_LOGIN", "true")
    await client.post("/auth/dev/login", json={"email": "csrf@example.com"})
    bad = await client.post("/auth/logout", headers={"Origin": "https://evil.example"})
    assert bad.status_code == 403
    assert (await client.get("/v1/me")).status_code == 200  # still signed in
    forged = await client.post("/v1/projects", json={"name": "x"}, headers={"Sec-Fetch-Site": "cross-site"})
    assert forged.status_code == 403
    same = await client.post("/v1/projects", json={"name": "csrf one"}, headers={"Origin": "http://localhost:5174"})
    assert same.status_code == 201
    assert (await client.post("/auth/logout")).status_code == 204  # no Origin: allowed


async def test_a_project_key_request_is_not_affected_by_the_origin_check(client, session):
    _, key = await create_project(session, "csrf-key")
    await session.commit()
    client.cookies.set("mcm_session", "stale")
    ok = await client.post("/v1/jobs", json={"name": "invoice", "check_kind": "LATE_LABEL"},
                           headers={"X-API-Key": key, "Origin": "https://evil.example"})
    assert ok.status_code in (200, 201)


# 9. caps -------------------------------------------------------------------------------------------------

async def test_projects_per_user_are_capped(client, monkeypatch):
    monkeypatch.setattr(auth_routes, "MAX_PROJECTS_PER_USER", 2)
    monkeypatch.setenv("DEV_LOGIN", "true")
    await client.post("/auth/dev/login", json={"email": "cap@example.com"})
    codes = [(await client.post("/v1/projects", json={"name": f"cap {i}"})).status_code for i in range(3)]
    assert codes == [201, 201, 409]
    assert "most" in (await client.post("/v1/projects", json={"name": "cap 9"})).json()["detail"]


async def test_jobs_per_project_are_capped(client, session, monkeypatch):
    monkeypatch.setattr(api_module, "MAX_JOBS_PER_PROJECT", 2)
    _, key = await create_project(session, "job-cap")
    await session.commit()
    codes = [(await client.post("/v1/jobs", headers={"X-API-Key": key},
                                json={"name": f"job-{i}", "check_kind": "LATE_LABEL"})).status_code for i in range(3)]
    assert codes[2] == 409 and all(c in (200, 201) for c in codes[:2])


# 10. no dollar wording for a subscription ----------------------------------------------------------------

async def _alert_world(session, project_id, mode):
    await create_project(session, project_id, webhook_url="https://hooks.example/a", billing_mode=mode)
    job = Job(project_id=project_id, name="invoice", check_kind="LATE_LABEL", check_config={})
    session.add(job)
    await session.flush()
    for kind, key in (("BUDGET", "b"), ("TRIAL_BUDGET", "t"), ("SILENT_DROP", "s")):
        session.add(Alert(job_id=job.job_id, kind=kind, detail={"summary": "$9 of $10"}, dedupe_key=key))
    await session.commit()


async def test_a_subscription_project_gets_no_budget_alert_but_keeps_trial_budget(session):
    await _alert_world(session, "sub-hooks", "subscription")
    sent = []

    def ok(request):
        sent.append(request.content)
        return httpx.Response(200)

    delivered, _ = await deliver_pending(session, transport=httpx.MockTransport(ok))
    assert delivered == 2 and sorted(json.loads(b)["kind"] for b in sent) == ["SILENT_DROP", "TRIAL_BUDGET"]


async def test_a_pay_per_use_project_still_gets_its_budget_alert(session):
    await _alert_world(session, "paid-hooks", "per_use")

    def ok(request):
        return httpx.Response(200)

    assert (await deliver_pending(session, transport=httpx.MockTransport(ok)))[0] == 3
