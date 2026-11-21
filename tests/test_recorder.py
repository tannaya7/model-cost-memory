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
        # the canonical ledger keys added by usage_ledger.py (additive; the old keys are unchanged)
        "usage_shape": "anthropic_messages",
        "usage_raw": {"input_tokens": 800, "output_tokens": 120, "cache_read_input_tokens": 300,
                      "cache_creation_input_tokens": 50},
    }


def test_reads_an_openai_shaped_response_and_does_not_double_count_cached_tokens():
    data = read_response(openai_like())
    assert data["tokens_in"] == 600 and data["cache_read_tokens"] == 400  # 1000 total, 400 of them cached
    assert data["tokens_out"] == 90 and data["output"] == "hello"


def test_reads_plain_dicts_and_survives_missing_fields():
    data = read_response({"model": "m", "usage": {"prompt_tokens": 5, "completion_tokens": 2},
                          "choices": [{"message": {"content": "hi"}}]})
    assert data["tokens_in"] == 5 and data["output"] == "hi"
    # No usage block at all: the counts are left unset and the shape says "none" (unknown, not zero).
    assert read_response(object()) == {"model_version": None, "usage_shape": "none"}
    assert read_response(None) == {"model_version": None, "usage_shape": "none"}


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
    # Tool-use prompt tokens are kept apart: Google does not document how they are billed, so they are not priced.
    assert data["tokens_in"] == 500 and data["tokens_out"] == 10 and data["cache_read_tokens"] == 0
    assert data["tool_use_input_tokens"] == 40 and data["usage_shape"] == "gemini"


# --- provider usage shapes (research_notes/Provider facts retry/provider_usage_and_pricing.md) ---

def test_openai_responses_usage_subtracts_cached_and_written_tokens_and_keeps_reasoning_inside_output():
    resp = {"model": "gpt-x", "usage": {
        "input_tokens": 1000, "output_tokens": 300, "total_tokens": 1300,
        "input_tokens_details": {"cached_tokens": 400, "cache_write_tokens": 100},
        "output_tokens_details": {"reasoning_tokens": 200}}}
    data = read_response(resp)
    assert data["tokens_in"] == 500 and data["cache_read_tokens"] == 400 and data["cache_write_tokens"] == 100
    assert data["tokens_out"] == 300  # the 200 reasoning tokens are already inside output_tokens


def test_openai_responses_usage_without_cache_write_field():
    data = read_response({"usage": {"input_tokens": 1000, "output_tokens": 50,
                                    "input_tokens_details": {"cached_tokens": 250}}})
    assert (data["tokens_in"], data["cache_read_tokens"], data["cache_write_tokens"]) == (750, 250, 0)


def test_openai_chat_usage_subtracts_cache_write_and_keeps_reasoning_inside_output():
    data = read_response({"usage": {
        "prompt_tokens": 1000, "completion_tokens": 90,
        "prompt_tokens_details": {"cached_tokens": 400, "cache_write_tokens": 100},
        "completion_tokens_details": {"reasoning_tokens": 60}}})
    assert (data["tokens_in"], data["cache_read_tokens"], data["cache_write_tokens"]) == (500, 400, 100)
    assert data["tokens_out"] == 90


def test_anthropic_usage_is_unchanged_next_to_the_responses_shape():
    data = read_response({"usage": {
        "input_tokens": 800, "output_tokens": 120, "cache_read_input_tokens": 300,
        "cache_creation_input_tokens": 248,
        "cache_creation": {"ephemeral_5m_input_tokens": 148, "ephemeral_1h_input_tokens": 100},
        "output_tokens_details": {"thinking_tokens": 50}}})
    assert data["tokens_in"] == 800 and data["tokens_out"] == 120
    assert data["cache_read_tokens"] == 300 and data["cache_write_tokens"] == 248
    assert data["cache_write_1h_tokens"] == 100


def test_deepseek_usage_hit_and_miss_tokens():
    data = read_response({"usage": {
        "prompt_tokens": 1000, "completion_tokens": 90, "prompt_cache_hit_tokens": 700,
        "prompt_cache_miss_tokens": 300, "completion_tokens_details": {"reasoning_tokens": 40}}})
    assert (data["tokens_in"], data["cache_read_tokens"], data["tokens_out"]) == (300, 700, 90)


SECRET = "SECRET-ARGUMENT"


def _calls(response, **kw):
    return read_response(response, **kw).get("tool_calls")


def test_anthropic_server_tool_use_and_mcp_tool_use_blocks_are_read_and_mcp_carries_its_server():
    from agent_memory.insights.agent_kinds import mcp_servers, tool_source

    resp = {"content": [
        {"type": "text", "text": "ok"},
        {"type": "tool_use", "id": "tu1", "name": "lookup", "input": {"q": SECRET}},
        {"type": "server_tool_use", "id": "st1", "name": "web_search", "input": {"query": SECRET}},
        {"type": "mcp_tool_use", "id": "mc1", "name": "create_issue", "server_name": "github", "input": {"t": SECRET}},
    ]}
    calls = _calls(resp)
    assert [c["name"] for c in calls] == ["lookup", "web_search", "mcp__github__create_issue"]
    assert [c["id"] for c in calls] == ["tu1", "st1", "mc1"]
    assert all("arguments" not in c for c in calls) and SECRET not in json.dumps(calls)
    names = [c["name"] for c in calls]
    assert tool_source(names, False) == "mcp" and mcp_servers(names) == ["github"]
    assert SECRET in json.dumps(_calls(resp, include_arguments=True))  # kept only when opted in


def test_openai_chat_custom_tool_calls_are_read_without_arguments():
    oai = openai_like()
    oai.choices[0].message.tool_calls = [
        SimpleNamespace(id="c1", type="function", function=SimpleNamespace(name="a", arguments=SECRET)),
        SimpleNamespace(id="c2", type="custom", custom=SimpleNamespace(name="patch", input=SECRET)),
    ]
    calls = _calls(oai)
    assert [(c["id"], c["name"]) for c in calls] == [("c1", "a"), ("c2", "patch")]
    assert SECRET not in json.dumps(calls)
    kept = _calls(oai, include_arguments=True)
    assert [c["arguments"] for c in kept] == [SECRET, SECRET]


def test_openai_responses_output_items_are_read_without_arguments():
    resp = {"usage": {"input_tokens": 10, "output_tokens": 5, "input_tokens_details": {"cached_tokens": 0}},
            "output": [
                {"type": "reasoning", "id": "rs1"},
                {"type": "message", "id": "m1"},
                {"type": "function_call", "id": "fc1", "call_id": "call1", "name": "lookup", "arguments": SECRET},
                {"type": "custom_tool_call", "call_id": "call2", "name": "patch", "input": SECRET},
                {"type": "mcp_call", "id": "mcp1", "name": "create_issue", "server_label": "github",
                 "arguments": SECRET},
                {"type": "mcp_list_tools", "id": "ml1"},
                {"type": "web_search_call", "id": "ws1"},
                {"type": "file_search_call", "id": "fs1"},
                {"type": "computer_call", "id": "cc1", "call_id": "call3"},
            ]}
    calls = _calls(resp)
    assert [c["name"] for c in calls] == [
        "lookup", "patch", "mcp__github__create_issue", "web_search_call", "file_search_call", "computer_call"]
    assert [c["id"] for c in calls] == ["call1", "call2", "mcp1", "ws1", "fs1", "call3"]
    assert SECRET not in json.dumps(calls) and all("arguments" not in c for c in calls)
    assert [c["arguments"] for c in _calls(resp, include_arguments=True)[:3]] == [SECRET] * 3


def test_gemini_function_calls_are_read_from_rest_and_sdk_shapes_without_arguments():
    rest = {"candidates": [{"content": {"parts": [
        {"text": "hi"}, {"functionCall": {"name": "get_weather", "args": {"city": SECRET}, "id": "g1"}}]}}]}
    calls = _calls(rest)
    assert calls == [{"name": "get_weather", "id": "g1"}]
    assert SECRET not in json.dumps(calls)
    sdk = SimpleNamespace(candidates=[SimpleNamespace(content=SimpleNamespace(parts=[
        SimpleNamespace(function_call=SimpleNamespace(name="get_time", args={"tz": SECRET}, id=None))]))])
    assert _calls(sdk) == [{"name": "get_time", "id": None}]
    assert _calls(rest, include_arguments=True)[0]["arguments"] == {"city": SECRET}


# ---- the optional feature label ---------------------------------------------------------------------------------------------

def test_the_feature_label_is_optional_and_sent_only_when_given():
    server = Server()
    sender = sender_for(server)
    with RunRecorder(job="j", sender=sender) as rec:
        rec.capture(anthropic_like(), prompt="p")
    with RunRecorder(job="j", sender=sender) as rec:
        rec.capture(anthropic_like(), prompt="p", feature="support_summary")
    assert sender.flush(2)
    plain, labelled = server.bodies()
    assert "feature" not in plain and labelled["feature"] == "support_summary"
    sender.close()


def test_a_strange_label_is_made_safe_instead_of_getting_the_whole_call_refused():
    from agent_memory.recorder import clean_feature

    assert clean_feature("Support summary-v2.1") == "Support summary-v2.1"
    assert clean_feature("  invoice/reader<script>  ") == "invoice_reader_script"
    assert clean_feature("___") is None and clean_feature("") is None and clean_feature("   ") is None and clean_feature(None) is None
    assert clean_feature("-leading") == "leading"  # the server wants a letter or digit first
    assert clean_feature("é") is None  # only plain ASCII letters and digits pass
    assert len(clean_feature("a" * 300)) == 100
    assert clean_feature(12345) == "12345"


def test_nothing_is_inferred_from_the_prompt_to_fill_the_label():
    server = Server()
    sender = sender_for(server)
    with RunRecorder(job="j", sender=sender) as rec:
        rec.capture(anthropic_like(), prompt="Please summarise this support ticket for the billing team")
    sender.flush(2)
    assert "feature" not in server.bodies()[0]
    sender.close()
