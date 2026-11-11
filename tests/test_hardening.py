"""Mentor review 3: outbound-URL checks, rate and size limits, the demo's reach, startup checks, key
separation, alert give-up, and the re-test client's output limit and pacing. Hosts and keys are made up."""

import asyncio
import base64
import hashlib
import random
import uuid
from datetime import UTC, datetime, timedelta
from email.utils import format_datetime

import httpx
import pytest
from cryptography.fernet import Fernet
from sqlalchemy import select

from agent_memory import ratelimit, urls
from agent_memory.alerts.notifier import MAX_ATTEMPTS, deliver_pending, retry_given_up_alerts
from agent_memory.config import Settings, UnsafeSettings, check_startup, startup_problems
from agent_memory.models import Alert, Job, Project
from agent_memory.projects import create_project
from agent_memory.retest import provider as provider_module
from agent_memory.retest.provider import (
    MAX_WAIT_SECONDS,
    OpenAICompatible,
    RateLimited,
    backoff_seconds,
    retry_after_seconds,
)
from agent_memory.security import decrypt, derive, encrypt, generate_key, hash_key, session_secret

LONG_SECRET = "s" * 40


# --- Outbound URLs ---------------------------------------------------------------------------------

@pytest.mark.parametrize("url", [
    "https://127.0.0.1/hook", "https://10.1.2.3/x", "https://192.168.0.5/x", "https://172.16.0.1/x",
    "https://169.254.169.254/latest/meta-data", "https://100.64.0.1/x", "https://0.0.0.0/x",
    "https://[::1]/x", "https://[::ffff:127.0.0.1]/x", "https://[fd00::1]/x", "https://localhost/x",
    "https://api.localhost/x", "https://printer.local/x", "https://db.internal/x",
])
def test_private_and_loopback_addresses_are_refused_before_any_lookup(url):
    assert urls.literal_problem(url) is not None


@pytest.mark.parametrize(("url", "problem"), [
    ("ftp://hooks.example/x", "must start with"), ("https://", "no host"),
    ("https://user:pw@hooks.example/x", "user name or password"), ("https://hooks.example:99999/x", "not a valid"),
])
def test_malformed_urls_are_refused(url, problem):
    assert problem in urls.literal_problem(url)


async def test_a_name_is_refused_if_any_address_it_resolves_to_is_private(monkeypatch):
    async def mixed(host, port):
        return ["93.184.215.14", "10.0.0.7"]

    monkeypatch.setattr(urls, "_resolve", mixed)
    with pytest.raises(urls.UnsafeUrl, match="private"):
        await urls.check_outbound("https://hooks.example/a")
    await urls.check_outbound("https://hooks.example/a", allow_private=True)  # the development switch


async def test_a_public_name_passes_and_an_unknown_one_is_refused(monkeypatch):
    await urls.check_outbound("https://hooks.example/a")  # the test resolver answers with a public address

    async def nowhere(host, port):
        raise OSError("no such host")

    monkeypatch.setattr(urls, "_resolve", nowhere)
    with pytest.raises(urls.UnsafeUrl, match="could not be found"):
        await urls.check_outbound("https://missing.example/a")


async def test_a_private_webhook_url_is_refused_when_saved(client, monkeypatch):
    monkeypatch.setenv("DEV_LOGIN", "true")
    await client.post("/auth/dev/login", json={"email": "ana@example.com"})
    pid = (await client.post("/v1/projects", json={"name": "hooks"})).json()["project"]["project_id"]
    refused = await client.patch(f"/v1/projects/{pid}", json={"webhook_url": "https://169.254.169.254/latest"})
    assert refused.status_code == 422 and "private" in refused.json()["detail"]

    async def internal(host, port):
        return ["192.168.1.20"]

    monkeypatch.setattr(urls, "_resolve", internal)
    refused = await client.patch(f"/v1/projects/{pid}", json={"webhook_url": "https://hooks.example/a"})
    assert refused.status_code == 422


# --- Webhook delivery ------------------------------------------------------------------------------

@pytest.fixture
async def alert_world(session):
    session.add(Project(project_id="hooks", api_key_hash=hash_key(generate_key()),
                        webhook_url="https://hooks.example/a", webhook_secret="whsec_x"))
    await session.flush()
    job = Job(project_id="hooks", name="invoice", check_kind="LATE_LABEL", check_config={})
    session.add(job)
    await session.flush()
    session.add(Alert(job_id=job.job_id, kind="SILENT_DROP", detail={"summary": "fell"}, dedupe_key="a"))
    await session.commit()
    return job


async def test_delivery_gives_up_after_the_last_attempt_and_a_new_url_tries_again(session, alert_world):
    def down(request):
        return httpx.Response(500)

    now = datetime.now(UTC)
    for attempt in range(MAX_ATTEMPTS):
        assert await deliver_pending(session, now=now, transport=httpx.MockTransport(down)) == (0, 1)
        now += timedelta(days=1)  # always past the backoff
    session.expunge_all()
    alert = (await session.execute(select(Alert))).scalar_one()
    assert alert.delivery_attempts == MAX_ATTEMPTS and alert.delivery_failed_at is not None
    assert alert.last_error == "the webhook answered HTTP 500"
    assert await deliver_pending(session, now=now + timedelta(days=30), transport=httpx.MockTransport(down)) == (0, 0)

    await retry_given_up_alerts(session, "hooks")
    await session.commit()
    assert await deliver_pending(session, now=now, transport=httpx.MockTransport(lambda r: httpx.Response(204))) == (1, 0)


async def test_one_slow_webhook_does_not_hold_up_the_others(session, alert_world, monkeypatch):
    for i in range(9):
        session.add(Alert(job_id=alert_world.job_id, kind="SILENT_DROP", detail={}, dedupe_key=f"b{i}"))
    await session.commit()
    in_flight, most = 0, 0

    async def handler(request):
        nonlocal in_flight, most
        in_flight += 1
        most = max(most, in_flight)
        await asyncio.sleep(0.05)
        in_flight -= 1
        return httpx.Response(204)

    assert await deliver_pending(session, transport=httpx.MockTransport(handler)) == (10, 0)
    assert most > 1  # sent side by side, not one after another


async def test_a_webhook_host_re_pointed_inside_is_not_called(session, alert_world, monkeypatch):
    async def rebound(host, port):
        return ["127.0.0.1"]

    monkeypatch.setattr(urls, "_resolve", rebound)
    called = []
    assert await deliver_pending(session, transport=httpx.MockTransport(lambda r: called.append(r))) == (0, 1)
    session.expunge_all()
    alert = (await session.execute(select(Alert))).scalar_one()
    assert called == [] and "private" in alert.last_error


async def test_the_api_never_returns_the_raw_delivery_error(client, session, alert_world):
    key = generate_key()
    project = await session.get(Project, "hooks")
    project.api_key_hash = hash_key(key)
    alert = (await session.execute(select(Alert))).scalar_one()
    alert.last_error = "secret internal detail"
    await session.commit()
    body = (await client.get("/v1/alerts", headers={"X-API-Key": key})).text
    assert "secret internal detail" not in body and "last_error" not in body


# --- The public demo -------------------------------------------------------------------------------

async def test_the_demo_shows_its_pages_but_not_the_operators_re_test_account(client, session, monkeypatch):
    await create_project(session, "public-demo")
    monkeypatch.setenv("DEMO_PROJECT_ID", "public-demo")
    for path in ("/v1/jobs", "/v1/runs", "/v1/alerts", "/v1/insights/spend", "/v1/limits", "/v1/models"):
        assert (await client.get(path)).status_code == 200, path
    for path in ("/v1/retest/limits", "/v1/jobs/invoice/retests", f"/v1/jobs/invoice/retest/{uuid.uuid4()}"):
        refused = await client.get(path)
        assert refused.status_code == 403 and "public demo" in refused.json()["detail"], path


# --- Rate, size and daily limits ------------------------------------------------------------------

def test_a_token_bucket_allows_a_minutes_burst_then_refills():
    t = [0.0]
    buckets = ratelimit.TokenBuckets(clock=lambda: t[0])
    assert all(buckets.take("ip:1", 3) == 0 for _ in range(3))
    wait = buckets.take("ip:1", 3)
    assert 0 < wait <= 20  # one token every 20 s at 3 a minute
    t[0] += 20
    assert buckets.take("ip:1", 3) == 0
    assert buckets.take("ip:2", 3) == 0  # another caller has its own bucket


async def test_callers_without_a_key_are_limited_per_ip(client, monkeypatch):
    monkeypatch.setenv("RATE_LIMIT_IP_PER_MINUTE", "3")
    statuses = [(await client.get("/v1/jobs")).status_code for _ in range(4)]
    assert statuses == [401, 401, 401, 429]
    limited = await client.get("/v1/jobs")
    assert int(limited.headers["retry-after"]) >= 1
    assert (await client.get("/healthz")).status_code == 200  # health checks are never limited


async def test_a_body_over_the_limit_is_refused(client, session):
    _, key = await create_project(session, "big-bodies")
    too_big = b"x" * (ratelimit.MAX_BODY_BYTES + 1)
    response = await client.post("/v1/runs", content=too_big,
                                 headers={"X-API-Key": key, "Content-Type": "application/json"})
    assert response.status_code == 413


async def test_a_project_records_at_most_its_daily_runs(client, session, monkeypatch):
    _, key = await create_project(session, "daily")
    headers = {"X-API-Key": key}
    await client.post("/v1/jobs", headers=headers, json={"name": "invoice", "check_kind": "LATE_LABEL"})
    monkeypatch.setenv("RUNS_PER_DAY_PER_PROJECT", "2")

    def run(run_id):
        return {"run_id": str(run_id), "job": "invoice", "prompt": "p", "model": "mini",
                "model_version": "mini-2026-09", "tokens_in": 10}

    first = uuid.uuid4()
    assert (await client.post("/v1/runs", headers=headers, json=run(first))).status_code == 202
    assert (await client.post("/v1/runs", headers=headers, json=run(first))).json()["status"] == "duplicate"
    assert (await client.post("/v1/runs", headers=headers, json=run(uuid.uuid4()))).status_code == 202
    refused = await client.post("/v1/runs", headers=headers, json=run(uuid.uuid4()))
    assert refused.status_code == 429 and "2 runs for today" in refused.json()["detail"]


async def test_live_views_are_capped_per_ip(client, session, monkeypatch):
    _, key = await create_project(session, "watched")
    monkeypatch.setenv("STREAMS_PER_IP", "0")
    refused = await client.get("/v1/flow/stream", headers={"X-API-Key": key})
    assert refused.status_code == 429
    assert ratelimit.STREAMS.total == 0  # a refused view holds no slot


# --- Startup and keys ----------------------------------------------------------------------------

def test_an_unsafe_public_server_refuses_to_start():
    assert startup_problems(Settings()) == []  # a laptop: no secret needed yet
    assert startup_problems(Settings(public_url="https://mcm.example", secret_key=LONG_SECRET)) == []
    problems = startup_problems(Settings(public_url="https://mcm.example", secret_key="short", dev_login=True,
                                         allow_private_urls=True))
    assert len(problems) == 3
    assert any("32 characters" in p for p in problems) and any("DEV_LOGIN" in p for p in problems)
    assert startup_problems(Settings(public_url="https://mcm.example")) == [
        "SECRET_KEY is required on a server whose PUBLIC_URL is https"]
    with pytest.raises(UnsafeSettings, match="Refusing to start"):
        check_startup(Settings(public_url="https://mcm.example", dev_login=True, secret_key=LONG_SECRET))


def test_cookies_and_stored_keys_use_different_keys_from_the_secret():
    assert derive(LONG_SECRET, "a") != derive(LONG_SECRET, "b")
    assert session_secret(LONG_SECRET) != LONG_SECRET
    token = encrypt("sk-live-1234", LONG_SECRET)
    assert decrypt(token, LONG_SECRET) == "sk-live-1234"
    # A key stored before the split (encrypted with SHA-256 of the secret itself) still reads.
    legacy = Fernet(base64.urlsafe_b64encode(hashlib.sha256(LONG_SECRET.encode()).digest()))
    assert decrypt(legacy.encrypt(b"sk-old-5678").decode(), LONG_SECRET) == "sk-old-5678"
    # A new token is not readable with the old derivation.
    with pytest.raises(Exception):
        legacy.decrypt(token.encode())


# --- The re-test client ---------------------------------------------------------------------------

def test_retry_after_is_read_in_seconds_milliseconds_or_as_a_date():
    assert retry_after_seconds({"retry-after": "7"}) == 7
    assert retry_after_seconds({"retry-after-ms": "1500", "retry-after": "9"}) == 1.5
    when = datetime(2026, 11, 11, 12, 0, 30, tzinfo=UTC)
    now = datetime(2026, 11, 11, 12, 0, 0, tzinfo=UTC).timestamp()
    assert retry_after_seconds({"retry-after": format_datetime(when, usegmt=True)}, now=now) == 30
    assert retry_after_seconds({"retry-after": "soon"}) is None and retry_after_seconds(None) is None


def test_backoff_follows_retry_after_up_to_the_cap_with_jitter():
    rng = random.Random(1)
    waits = [backoff_seconds(0, 120.0, rng) for _ in range(50)]
    assert all(120 <= w <= 150 for w in waits) and len(set(waits)) > 1  # spread out, never under the ask
    assert backoff_seconds(0, 10_000.0, rng) <= MAX_WAIT_SECONDS * 1.25
    assert 4 <= backoff_seconds(1, None, rng) <= 5  # 2^2 s without a Retry-After


def _openai_error(cls, status, headers=None, message="error"):
    request = httpx.Request("POST", "https://api.example/v1/chat/completions")
    return cls(message, response=httpx.Response(status, headers=headers or {}, request=request), body=None)


class _Completions:
    def __init__(self, script):
        self.script, self.calls = list(script), []

    async def create(self, **kwargs):
        self.calls.append(kwargs)
        step = self.script.pop(0)
        if isinstance(step, Exception):
            raise step
        return step


def _client(script, **kwargs):
    slept = []

    async def sleep(seconds):
        slept.append(seconds)

    client = OpenAICompatible("https://api.example/v1", "sk-test", sleep=sleep, rng=random.Random(0), **kwargs)
    completions = _Completions(script)
    client._client = type("C", (), {"chat": type("Ch", (), {"completions": completions})()})()
    return client, completions, slept


async def test_the_output_limit_is_sent_and_renamed_for_models_that_want_max_completion_tokens():
    import openai

    wants_new_name = _openai_error(openai.BadRequestError, 400,
                                   message="Unsupported parameter: 'max_tokens'. Use 'max_completion_tokens' instead.")
    client, completions, _ = _client([wants_new_name, {"ok": 1}, {"ok": 2}], min_interval=0)
    assert await client.complete("o-mini", "hi", max_tokens=500, effort="low") == {"ok": 1}
    assert await client.complete("o-mini", "hi", max_tokens=500) == {"ok": 2}
    first, renamed, later = completions.calls
    assert first["max_tokens"] == 500 and renamed["max_completion_tokens"] == 500 and "max_tokens" not in renamed
    assert renamed["reasoning_effort"] == "low"
    assert later["max_completion_tokens"] == 500  # remembered for the rest of the re-test


async def test_a_429_waits_for_retry_after_and_gives_up_after_the_retries():
    import openai

    limited = _openai_error(openai.RateLimitError, 429, {"retry-after": "30"})
    client, _, slept = _client([limited, {"ok": True}], min_interval=0)
    assert await client.complete("m", "hi", max_tokens=500) == {"ok": True}
    assert len(slept) == 1 and 30 <= slept[0] <= 37.5
    client, _, _ = _client([limited] * (provider_module.RATE_LIMIT_RETRIES + 1), min_interval=0)
    with pytest.raises(RateLimited):
        await client.complete("m", "hi", max_tokens=500)


async def test_calls_are_paced_so_a_burst_does_not_empty_a_free_quota():
    t = [100.0]
    client, _, slept = _client([{"n": i} for i in range(3)], min_interval=2.0, clock=lambda: t[0])
    for _ in range(3):
        await client.complete("m", "hi", max_tokens=500)
    assert slept == [2.0, 4.0]  # the clock did not move, so each call waits its turn behind the last
