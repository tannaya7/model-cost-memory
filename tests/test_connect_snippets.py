"""The Python function the Connect guide gives a developer is a real file (frontend/src/features/jobs/snippets/record_ai_call.py).
These tests run that exact file: what it would send is captured, then given to the real API, so the example cannot drift from the
server. No network is used: urlopen is replaced."""

import json
import threading
import types
import uuid
from pathlib import Path

import pytest

from agent_memory.models import Job, Project
from agent_memory.security import generate_key, hash_key

SNIPPET = Path(__file__).resolve().parents[1] / "frontend" / "src" / "features" / "jobs" / "snippets" / "record_ai_call.py"


def load(monkeypatch, sent, *, fail=False, env=True):
    if env:
        monkeypatch.setenv("MCM_API_URL", "https://mcm.example.com/")
        monkeypatch.setenv("MCM_API_KEY", "mcm_live_testkey")
    else:
        monkeypatch.delenv("MCM_API_URL", raising=False)
        monkeypatch.delenv("MCM_API_KEY", raising=False)
    module = types.ModuleType("record_ai_call")
    exec(compile(SNIPPET.read_text(encoding="utf8"), str(SNIPPET), "exec"), module.__dict__)  # noqa: S102

    class Reply:
        def close(self):
            pass

    def urlopen(request, timeout=None):
        if fail:
            raise OSError("the dashboard is down")
        sent.append({"url": request.full_url, "headers": dict(request.header_items()), "body": json.loads(request.data), "method": request.get_method(), "timeout": timeout})
        return Reply()

    monkeypatch.setattr(module.urllib.request, "urlopen", urlopen)
    return module


def wait_for_threads():
    for t in threading.enumerate():
        if t is not threading.current_thread() and t.daemon and t.is_alive():
            t.join(timeout=5)


async def test_the_function_sends_a_request_the_real_api_accepts(client, session, monkeypatch):
    key = generate_key()
    session.add(Project(project_id="acme", api_key_hash=hash_key(key)))
    await session.flush()
    session.add(Job(project_id="acme", name="read-invoices", check_kind="LATE_LABEL", check_config={}))
    await session.commit()
    sent = []
    module = load(monkeypatch, sent)
    usage = {"prompt_tokens": 1500, "completion_tokens": 80, "prompt_tokens_details": {"cached_tokens": 1000}}
    module.record_ai_call("read-invoices", "the prompt", "the answer", "my-model", "my-model-2026-01-01", "openai", usage, 420, "v2")
    wait_for_threads()
    assert len(sent) == 1
    got = sent[0]
    assert got["url"] == "https://mcm.example.com/v1/runs" and got["method"] == "POST"  # a trailing slash does not double up
    assert {k.lower(): v for k, v in got["headers"].items()}["x-api-key"] == "mcm_live_testkey"
    body = got["body"]
    # OpenAI counts cached tokens inside prompt_tokens, so the uncached part is what is billed at the full price
    assert (body["tokens_in"], body["cache_read_tokens"], body["tokens_out"]) == (500, 1000, 80)
    assert body["job"] == "read-invoices" and body["prompt_version"] == "v2" and body["latency_ms"] == 420
    assert "usage" not in body and uuid.UUID(body["run_id"])
    r = await client.post("/v1/runs", headers={"X-API-Key": key}, json=body)
    assert r.status_code == 202, r.text
    row = (await client.get("/v1/runs", headers={"X-API-Key": key})).json()["items"][0]
    assert (row["tokens_in"], row["tokens_out"]) == (500, 80)


def test_anthropic_style_usage_is_read_as_it_is(monkeypatch):
    sent = []
    module = load(monkeypatch, sent)
    usage = {"input_tokens": 700, "output_tokens": 40, "cache_read_input_tokens": 300, "cache_creation_input_tokens": 50}
    module.record_ai_call("t", "p", "a", "m", "m-1", "anthropic", usage)
    wait_for_threads()
    body = sent[0]["body"]
    assert (body["tokens_in"], body["tokens_out"], body["cache_read_tokens"], body["cache_write_tokens"]) == (700, 40, 300, 50)
    assert "latency_ms" not in body and "prompt_version" not in body  # fields you did not give are left out, not sent empty


def test_an_sdk_usage_object_is_read_too_and_missing_usage_means_zero(monkeypatch):
    sent = []
    module = load(monkeypatch, sent)

    class Usage:  # the OpenAI and Anthropic Python SDKs return objects with model_dump()
        def model_dump(self):
            return {"prompt_tokens": 10, "completion_tokens": 5}

    module.record_ai_call("t", "p", "a", "m", "m-1", "openai", Usage())
    module.record_ai_call("t", "p", "a", "m", "m-1", "openai", None)
    wait_for_threads()
    assert [(b["body"]["tokens_in"], b["body"]["tokens_out"]) for b in sent] == [(10, 5), (0, 0)] or sorted(
        (b["body"]["tokens_in"], b["body"]["tokens_out"]) for b in sent) == [(0, 0), (10, 5)]


def test_it_never_raises_when_the_dashboard_is_down_or_not_set_up(monkeypatch):
    for kwargs in ({"fail": True}, {"env": False}):
        module = load(monkeypatch, [], **kwargs)
        module.record_ai_call("t", "p", "a", "m", "m-1", "openai", {"prompt_tokens": 1})  # must return normally
        wait_for_threads()


def test_the_call_returns_at_once_because_the_send_runs_in_the_background(monkeypatch):
    import time
    sent = []
    module = load(monkeypatch, sent)
    original = module.urllib.request.urlopen

    def slow(request, timeout=None):
        time.sleep(0.4)
        return original(request, timeout=timeout)

    monkeypatch.setattr(module.urllib.request, "urlopen", slow)
    started = time.perf_counter()
    module.record_ai_call("t", "p", "a", "m", "m-1", "openai", {"prompt_tokens": 1})
    assert time.perf_counter() - started < 0.2
    wait_for_threads()
    assert len(sent) == 1


@pytest.mark.parametrize("needle", ["urllib.request", "threading"])
def test_it_uses_only_what_python_already_includes(needle):
    text = SNIPPET.read_text(encoding="utf8")
    assert needle in text
    imports = [line.split()[1] for line in text.splitlines() if line.startswith("import ")]
    assert set(imports) <= {"json", "os", "threading", "urllib.request", "uuid"}
