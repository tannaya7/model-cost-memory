"""The SDK: reads provider responses, sends in the background, never breaks the caller."""

import json
import time
import uuid
from types import SimpleNamespace

import httpx
import pytest

from agent_memory.recorder import RunRecorder, Sender, provider_for, read_response


def anthropic_like():
    return SimpleNamespace(
        model="model-a-2026-09",
        usage=SimpleNamespace(input_tokens=800, output_tokens=120, cache_read_input_tokens=300,
                              cache_creation_input_tokens=50),
        content=[SimpleNamespace(type="text", text='{"total": '), SimpleNamespace(type="text", text="12.5}")],
    )


def openai_like():
    return SimpleNamespace(
        model="model-b-2026-08",
        usage=SimpleNamespace(prompt_tokens=1000, completion_tokens=90,
                              prompt_tokens_details=SimpleNamespace(cached_tokens=400)),
        choices=[SimpleNamespace(message=SimpleNamespace(content="hello"))],
    )


def test_reads_an_anthropic_shaped_response():
    data = read_response(anthropic_like())
    assert data == {
        "model_version": "model-a-2026-09", "tokens_in": 800, "tokens_out": 120,
        "cache_read_tokens": 300, "cache_write_tokens": 50, "output": '{"total": 12.5}',
    }


def test_reads_an_openai_shaped_response_and_does_not_double_count_cached_tokens():
    data = read_response(openai_like())
    assert data["tokens_in"] == 600 and data["cache_read_tokens"] == 400  # 1000 total, 400 of them cached
    assert data["tokens_out"] == 90 and data["output"] == "hello"


def test_reads_plain_dicts_and_survives_missing_fields():
    data = read_response({"model": "m", "usage": {"prompt_tokens": 5, "completion_tokens": 2},
                          "choices": [{"message": {"content": "hi"}}]})
    assert data["tokens_in"] == 5 and data["output"] == "hi"
    assert read_response(object()) == {"model_version": None}
    assert read_response(None) == {"model_version": None}


class Server:
    """A fake API that records what it is sent."""

    def __init__(self, status=202):
        self.requests: list[httpx.Request] = []
        self.status = status

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        return httpx.Response(self.status, json={"status": "accepted"})

    def bodies(self):
        return [json.loads(r.content) for r in self.requests]


def sender_for(handler, **kw):
    return Sender("http://api.test", "mcm_live_key", transport=httpx.MockTransport(handler),
                  backoff=0.0, **kw)


def test_a_captured_call_is_sent_in_the_background_with_the_key():
    server = Server()
    sender = sender_for(server)
    with RunRecorder(job="invoice-extract", prompt_version="v2", sender=sender) as rec:
        rec.capture(anthropic_like(), prompt="Extract the total.", model="model-a")
    assert sender.flush(2)
    request = server.requests[0]
    assert request.url == "http://api.test/v1/runs" and request.headers["X-API-Key"] == "mcm_live_key"
    body = server.bodies()[0]
    assert body["job"] == "invoice-extract" and body["prompt"] == "Extract the total."
    assert body["model"] == "model-a" and body["model_version"] == "model-a-2026-09"
    assert body["prompt_version"] == "v2" and body["tokens_in"] == 800
    assert uuid.UUID(body["run_id"]) and body["latency_ms"] >= 0
    sender.close()


def test_nothing_is_sent_when_nothing_was_captured():
    server = Server()
    sender = sender_for(server)
    with RunRecorder(job="j", sender=sender):
        pass
    assert sender.flush(1) and server.requests == []
    sender.close()


def test_explicit_values_fill_what_the_response_lacks():
    server = Server()
    sender = sender_for(server)
    with RunRecorder(job="j", sender=sender) as rec:
        rec.capture(None, prompt="p", model="local-model", tokens_in=7, tokens_out=3, output="x", cost_usd=0.0)
    sender.flush(2)
    body = server.bodies()[0]
    assert body["model"] == "local-model" and body["model_version"] == "local-model"
    assert body["tokens_in"] == 7 and body["cost_usd"] == 0.0
    sender.close()


def test_the_applications_own_exception_is_never_swallowed():
    sender = sender_for(Server())
    with pytest.raises(ValueError, match="boom"), RunRecorder(job="j", sender=sender) as rec:
        rec.capture(openai_like(), prompt="p")
        raise ValueError("boom")
    sender.close()


def test_an_unreachable_api_never_raises_and_the_run_is_dropped_after_retries():
    attempts = []

    def down(request):
        attempts.append(1)
        raise httpx.ConnectError("no route to host")

    sender = sender_for(down)
    with RunRecorder(job="j", sender=sender) as rec:
        rec.capture(openai_like(), prompt="p")
    assert sender.flush(3)
    assert len(attempts) == 3 and sender.dropped == 1 and sender.sent == 0
    sender.close()


def test_a_rejected_run_is_not_retried():
    server = Server(status=404)
    sender = sender_for(server)
    with RunRecorder(job="missing", sender=sender) as rec:
        rec.capture(openai_like(), prompt="p")
    sender.flush(2)
    assert len(server.requests) == 1 and sender.dropped == 1
    sender.close()


def test_a_server_error_is_retried_then_succeeds():
    calls = []

    def flaky(request):
        calls.append(1)
        return httpx.Response(503 if len(calls) < 3 else 202, json={})

    sender = sender_for(flaky)
    with RunRecorder(job="j", sender=sender) as rec:
        rec.capture(openai_like(), prompt="p")
    sender.flush(3)
    assert len(calls) == 3 and sender.sent == 1
    sender.close()


def test_the_call_is_not_slowed_down_even_when_the_api_is_slow():
    def slow(request):
        time.sleep(0.5)
        return httpx.Response(202, json={})

    sender = sender_for(slow)
    started = time.perf_counter()
    for _ in range(5):
        with RunRecorder(job="j", sender=sender) as rec:
            rec.capture(openai_like(), prompt="p")
    elapsed_ms = (time.perf_counter() - started) * 1000 / 5
    assert elapsed_ms < 10, f"{elapsed_ms:.2f} ms per call"  # the budget is 5 ms; allow slack for CI
    sender.close()


def test_a_full_queue_drops_instead_of_blocking():
    gate = []

    def stuck(request):
        while not gate:
            time.sleep(0.01)
        return httpx.Response(202, json={})

    sender = sender_for(stuck, queue_size=2)
    results = [sender.submit({"run_id": str(i)}) for i in range(6)]
    assert results.count(False) >= 3 and sender.dropped >= 3
    gate.append(1)
    sender.close()


@pytest.mark.parametrize("url, provider", [
    ("https://api.groq.com/openai/v1", "groq"),
    ("https://generativelanguage.googleapis.com/v1beta/openai/", "gemini"),
    ("https://API.OpenAI.com/v1", "openai"),
    ("http://localhost:11434/v1", "ollama"),
    ("https://llm.internal.example/v1", None),
    (None, None),
])
def test_the_provider_is_named_from_the_endpoint_address(url, provider):
    assert provider_for(url) == provider


def test_the_recorders_provider_is_sent_with_each_run():
    server = Server()
    sender = sender_for(server)
    with RunRecorder(job="j", provider="groq", sender=sender) as rec:
        rec.capture(openai_like(), prompt="p")
    with RunRecorder(job="j", sender=sender) as rec:
        rec.capture(openai_like(), prompt="p")
    sender.flush(2)
    assert [b.get("provider") for b in server.bodies()] == ["groq", None]
    sender.close()


TOOLS = [{"name": "search", "description": "Search the web", "input_schema": {"type": "object"}}]


def test_agent_trace_and_tool_definitions_are_sent_and_the_tool_size_is_estimated():
    server = Server()
    sender = sender_for(server)
    with RunRecorder(job="j", sender=sender) as rec:
        rec.capture(anthropic_like(), prompt="p", agent="planner", trace_id="t-1", tools=TOOLS)
    assert sender.flush(2)
    body = server.bodies()[0]
    assert body["agent"] == "planner" and body["trace_id"] == "t-1"
    assert body["tools_tokens"] == len(json.dumps(TOOLS, sort_keys=True)) // 4 > 0
    sender.close()


def test_long_agent_and_trace_are_trimmed_and_no_tools_means_no_field():
    server = Server()
    sender = sender_for(server)
    with RunRecorder(job="j", sender=sender) as rec:
        rec.capture(anthropic_like(), prompt="p", agent="a" * 300, trace_id="t" * 500)
    sender.flush(2)
    body = server.bodies()[0]
    assert len(body["agent"]) == 100 and len(body["trace_id"]) == 200 and "tools_tokens" not in body
    sender.close()


def test_unserialisable_tools_never_raise():
    server = Server()
    sender = sender_for(server)
    cyc: list = []
    cyc.append(cyc)
    with RunRecorder(job="j", sender=sender) as rec:
        rec.capture(anthropic_like(), prompt="p", tools=cyc)
    sender.flush(2)
    assert len(server.requests) == 1
    sender.close()


def test_tool_calls_are_read_from_anthropic_and_openai_responses():
    anth = anthropic_like()
    anth.content.append(SimpleNamespace(type="tool_use", id="tu_1", name="search", input={"q": "x"}))
    assert [c["name"] for c in read_response(anth)["tool_calls"]] == ["search"]
    oai = openai_like()
    oai.choices[0].message.tool_calls = [
        SimpleNamespace(id="c1", function=SimpleNamespace(name="a", arguments="{}")),
        SimpleNamespace(id="c2", function=SimpleNamespace(name="b", arguments="{}")),
    ]
    assert len(read_response(oai)["tool_calls"]) == 2
    assert "tool_calls" not in read_response(anthropic_like())


def gemini_like():
    return SimpleNamespace(
        model_version="gemini-x",
        usage_metadata=SimpleNamespace(prompt_token_count=1000, cached_content_token_count=400,
                                       candidates_token_count=90, thoughts_token_count=60,
                                       tool_use_prompt_token_count=0),
        candidates=[SimpleNamespace(content=SimpleNamespace(parts=[SimpleNamespace(text="hi "), SimpleNamespace(text="there")]))],
    )


def test_reads_a_gemini_response_object_cached_inside_prompt_and_thoughts_as_output():
    data = read_response(gemini_like())
    assert data["tokens_in"] == 600 and data["cache_read_tokens"] == 400
    assert data["tokens_out"] == 150  # 90 answer + 60 thinking, both billed as output
    assert data["output"] == "hi there"


def test_reads_a_gemini_rest_dict_with_tool_use_tokens():
    data = read_response({"usageMetadata": {"promptTokenCount": 500, "toolUsePromptTokenCount": 40,
                                            "candidatesTokenCount": 10}})
    assert data["tokens_in"] == 540 and data["tokens_out"] == 10 and data["cache_read_tokens"] == 0
