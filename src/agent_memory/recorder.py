"""RunRecorder: the SDK an engineer wraps around an existing model call.

    from agent_memory.recorder import RunRecorder

    with RunRecorder(job="invoice-extract", provider="anthropic") as rec:
        response = client.messages.create(model="...", messages=[...])   # the app's own call, unchanged
        rec.capture(response, prompt=prompt)                              # reads usage, model and output

It copies the run to POST /v1/runs in a background thread. It adds well under 5 ms to the call, never
waits for the network, and never raises into the application: if the API is down the run is dropped
after a short retry and a warning is logged. The production call itself never goes through us.

`provider` says who served the call, so it is priced at that provider's rate: the same open-weight
model can cost several times more on one provider than another. `provider_for(client.base_url)` names
the common ones.

Configuration comes from the environment: MCM_API_URL (default http://127.0.0.1:8000) and MCM_API_KEY.
"""

from __future__ import annotations

import atexit
import json
import logging
import os
import queue
import threading
import time
import uuid
from typing import Any
from urllib.parse import urlsplit

import httpx

from .privacy import sanitize_tool_calls
from .usage_ledger import legacy_columns, read_usage

log = logging.getLogger("agent_memory.recorder")

DEFAULT_API_URL = "http://127.0.0.1:8000"

# Provider names as the price list spells them.
KNOWN_HOSTS = {
    "api.openai.com": "openai",
    "api.anthropic.com": "anthropic",
    "generativelanguage.googleapis.com": "gemini",
    "api.groq.com": "groq",
    "api.together.xyz": "together_ai",
    "api.mistral.ai": "mistral",
    "api.deepseek.com": "deepseek",
    "api.fireworks.ai": "fireworks_ai",
    "api.cerebras.ai": "cerebras",
    "api.x.ai": "xai",
    "api.deepinfra.com": "deepinfra",
}
_STOP = object()


class Sender:
    """Posts runs to the API from one background thread. Bounded queue; drops instead of blocking.

    If the API is unreachable, a circuit breaker stops the thread from spending ~seconds per run on
    retries: after `breaker_threshold` runs in a row could not be delivered, runs are dropped at once
    for `breaker_cooldown` seconds, then one is tried again (and a success closes the breaker).
    """

    def __init__(
        self,
        api_url: str | None = None,
        api_key: str | None = None,
        *,
        transport: httpx.BaseTransport | None = None,
        queue_size: int = 1000,
        retries: int = 3,
        backoff: float = 0.2,
        timeout: float = 2.0,
        breaker_threshold: int = 5,
        breaker_cooldown: float = 30.0,
    ) -> None:
        self.api_url = (api_url or os.environ.get("MCM_API_URL") or DEFAULT_API_URL).rstrip("/")
        self.api_key = api_key or os.environ.get("MCM_API_KEY", "")
        self._client = httpx.Client(transport=transport, timeout=timeout)
        self._queue: queue.Queue[Any] = queue.Queue(maxsize=queue_size)
        self._retries = retries
        self._backoff = backoff
        self._breaker_threshold = breaker_threshold
        self._breaker_cooldown = breaker_cooldown
        self._failures_in_a_row = 0
        self._open_until = 0.0  # monotonic time until which runs are dropped without trying
        self._pending = 0  # queued and not yet sent or dropped
        self._idle = threading.Condition()
        self.sent = 0
        self.dropped = 0
        self._thread = threading.Thread(target=self._loop, name="mcm-recorder", daemon=True)
        self._thread.start()

    def submit(self, payload: dict[str, Any]) -> bool:
        """Queue a run. Never blocks; returns False (and counts a drop) when the queue is full."""
        with self._idle:
            try:
                self._queue.put_nowait(payload)
            except queue.Full:
                self.dropped += 1
                log.warning("run recorder queue is full; dropping run %s", payload.get("run_id"))
                return False
            self._pending += 1
            return True

    def flush(self, timeout: float = 5.0) -> bool:
        """Wait until everything queued has been sent or dropped. True if it finished in time."""
        with self._idle:
            return self._idle.wait_for(lambda: self._pending == 0, timeout=timeout)

    def close(self) -> None:
        """Send what is queued (briefly), stop the thread and close the HTTP client."""
        self.flush(2.0)
        self._queue.put(_STOP)
        self._thread.join(timeout=2.0)
        self._client.close()

    def _loop(self) -> None:
        while True:
            item = self._queue.get()
            if item is _STOP:
                return
            try:
                self._deliver(item)
            except Exception:  # the loop must never die
                log.exception("run recorder failed unexpectedly")
            finally:
                with self._idle:
                    self._pending -= 1
                    self._idle.notify_all()

    def _deliver(self, payload: dict[str, Any]) -> None:
        if time.monotonic() < self._open_until:  # the API was unreachable just now: do not wait on it
            self.dropped += 1
            return
        if self._deliver_once(payload):
            self._failures_in_a_row = 0
            return
        self._failures_in_a_row += 1
        if self._failures_in_a_row >= self._breaker_threshold:
            self._open_until = time.monotonic() + self._breaker_cooldown
            log.warning("the API has been unreachable for %d runs; dropping runs for %.0f s",
                        self._failures_in_a_row, self._breaker_cooldown)

    def _deliver_once(self, payload: dict[str, Any]) -> bool:
        """Send one run with retries. False only when the API could not be reached at all."""
        headers = {"X-API-Key": self.api_key}
        for attempt in range(1, self._retries + 1):
            try:
                response = self._client.post(f"{self.api_url}/v1/runs", json=payload, headers=headers)
                if response.status_code < 300:
                    self.sent += 1
                    return True
                if response.status_code < 500 and response.status_code != 429:
                    # A rejection (bad key, unknown job, invalid run) will not improve on retry; the API
                    # is up, so this is not a reason to open the breaker.
                    self.dropped += 1
                    log.warning("run %s rejected: %s %s", payload["run_id"], response.status_code, response.text[:200])
                    return True
            except httpx.HTTPError as exc:
                log.debug("send attempt %d failed: %s", attempt, exc)
            if attempt < self._retries:
                time.sleep(self._backoff * attempt)
        self.dropped += 1
        log.warning("could not reach the API; dropping run %s", payload["run_id"])
        return False


_default_sender: Sender | None = None
_default_lock = threading.Lock()


def default_sender() -> Sender:
    global _default_sender
    with _default_lock:
        if _default_sender is None:
            _default_sender = Sender()
            atexit.register(_default_sender.close)  # send what is queued, then stop the thread and client
        return _default_sender


def provider_for(base_url: Any) -> str | None:
    """The provider behind an endpoint address, or None when it is not a known one.

    Local Ollama (port 11434) is "ollama". Anything else should be named by hand.
    """
    parts = urlsplit(str(base_url or ""))
    host = (parts.hostname or "").lower()
    if host in KNOWN_HOSTS:
        return KNOWN_HOSTS[host]
    if host in ("localhost", "127.0.0.1") and parts.port == 11434:
        return "ollama"
    return None


def _get(obj: Any, *path: str) -> Any:
    """Read obj.a.b or obj['a']['b'], returning None when any step is missing."""
    for name in path:
        if obj is None:
            return None
        obj = obj.get(name) if isinstance(obj, dict) else getattr(obj, name, None)
    return obj


def read_response(response: Any, *, include_arguments: bool = False) -> dict[str, Any]:
    """Pull model, usage and output out of an Anthropic-, OpenAI- (Chat or Responses), DeepSeek- or
    Gemini-shaped response (object or dict).

    `tokens_in` is uncached input only, so cost is never billed twice. Verified against the providers' docs
    and SDKs (2026-11-17): OpenAI counts cached and cache-write tokens INSIDE prompt_tokens / input_tokens
    (https://developers.openai.com/api/docs/guides/prompt-caching); Anthropic's input_tokens EXCLUDES cache
    reads and writes (https://platform.claude.com/docs/en/build-with-claude/prompt-caching); DeepSeek
    prompt_tokens = prompt_cache_hit_tokens + prompt_cache_miss_tokens
    (https://api-docs.deepseek.com/api/create-chat-completion); Gemini prompt_token_count includes cached
    content (python-genai types.py). Thinking and reasoning tokens are already inside the output total for
    Anthropic, OpenAI and DeepSeek; Gemini reports thoughts separately, so they are added to output.

    Not modelled (needs a price or a field the run does not carry): OpenAI 12-hour cache writes (2.5x; all
    writes are priced at the 30-minute 1.25x), Anthropic data-residency 1.1x, Batch 50%, fast mode, web
    search $10 per 1,000 and the Haiku 5.5 over-100K price, DeepSeek peak pricing, Gemini storage fees.

    Tool calls are reduced to their names and ids; arguments are included only when `include_arguments`.
    """
    out: dict[str, Any] = {"model_version": _get(response, "model")}

    usage = _get(response, "usage")
    if usage is None:  # Gemini keeps usage under usage_metadata (SDK) or usageMetadata (REST)
        usage = _get(response, "usage_metadata") or _get(response, "usageMetadata")
    # One read of the provider's usage block into the canonical ledger (usage_ledger.py documents which fields
    # are inside or additional to which). The four old columns are derived from it; the ledger's own fields
    # keep "not reported" apart from zero.
    ledger = read_usage(usage)
    out.update(legacy_columns(ledger))
    out["usage_shape"] = ledger["shape"]
    if ledger["raw"]:
        out["usage_raw"] = ledger["raw"]
    if ledger["fields"]["reasoning"] is not None:
        out["reasoning_tokens"] = ledger["fields"]["reasoning"]
    if ledger["fields"]["tool_use_input"] is not None:
        out["tool_use_input_tokens"] = ledger["fields"]["tool_use_input"]

    content = _get(response, "content")  # Anthropic: a list of blocks
    choices = _get(response, "choices")  # OpenAI: a list of choices
    if isinstance(content, list):
        texts = [t for t in (_get(block, "text") for block in content) if isinstance(t, str)]
        if texts:
            out["output"] = "".join(texts)
    elif isinstance(choices, list) and choices:
        text = _get(choices[0], "message", "content")
        if isinstance(text, str):
            out["output"] = text

    candidates = _get(response, "candidates")  # Gemini: candidates[0].content.parts[].text
    if "output" not in out and isinstance(candidates, list) and candidates:
        parts = _get(candidates[0], "content", "parts")
        if isinstance(parts, list):
            texts = [t for t in (_get(part, "text") for part in parts) if isinstance(t, str)]
            if texts:
                out["output"] = "".join(texts)

    calls = _read_tool_calls(content, choices, candidates, _get(response, "output"))
    if calls:
        out["tool_calls"] = sanitize_tool_calls(calls, keep_arguments=include_arguments)
    return out


# OpenAI Responses `output[]` item types that are a tool call, exactly as the SDK spells them
# (openai-python types/responses/response_output_item.py). Hosted tools carry no `name`: the type is the tool.
# `mcp_list_tools` and `mcp_approval_request` are not calls, so they are left out.
_RESPONSES_CALL_TYPES = frozenset({
    "function_call", "custom_tool_call", "mcp_call", "web_search_call", "file_search_call", "computer_call",
    "code_interpreter_call", "local_shell_call", "shell_call", "apply_patch_call", "tool_search_call",
    "image_generation_call",
})


def _mcp_name(server: Any, name: Any) -> Any:
    """`mcp__server__tool`, the spelling insights/agent_kinds.MCP_NAME recognises as a tool server."""
    if not name or not server or str(name).startswith("mcp__"):
        return name
    return f"mcp__{server}__{name}"


def _read_tool_calls(content: Any, choices: Any, candidates: Any, output: Any) -> list[dict[str, Any]]:
    """Tool calls as {id, name, arguments}; the caller drops the arguments unless the project opted in.

    Sources (anthropic-sdk-python and openai-python types, python-genai types.py):
    - Anthropic content blocks `tool_use`, `server_tool_use` {id, name, input} and the beta `mcp_tool_use`
      {id, name, server_name, input} (its name gets the server so MCP detection works).
    - OpenAI Chat message.tool_calls: {type: "function", function: {name, arguments}} or
      {type: "custom", custom: {name, input}}.
    - OpenAI Responses output[] items (see _RESPONSES_CALL_TYPES); `mcp_call` has `server_label`.
    - Gemini candidates[].content.parts[].functionCall {name, args, id?} (REST) / function_call (SDK).
    """
    calls: list[dict[str, Any]] = []
    failed: dict[Any, bool] = {}  # MCP results by the call they answer: a result is never a call of its own
    if isinstance(content, list):
        for b in content:
            kind = _get(b, "type")
            if kind in ("tool_use", "server_tool_use"):
                calls.append({"id": _get(b, "id"), "name": _get(b, "name"), "arguments": _get(b, "input")})
            elif kind == "mcp_tool_use":
                call = {"id": _get(b, "id"), "name": _mcp_name(_get(b, "server_name"), _get(b, "name")), "arguments": _get(b, "input")}
                if _get(b, "server_name"):  # provider-reported only when the response itself names the server
                    call.update(server=_get(b, "server_name"), source="provider")
                calls.append(call)
            elif kind == "mcp_tool_result":
                failed[_get(b, "tool_use_id")] = bool(_get(b, "is_error"))
        for call in calls:
            if call.get("source") == "provider" and call.get("id") in failed:
                call["failed"] = failed[call["id"]]
    if isinstance(choices, list) and choices:
        for c in _get(choices[0], "message", "tool_calls") or []:
            if _get(c, "function", "name") is not None or _get(c, "custom") is None:
                calls.append({"id": _get(c, "id"), "name": _get(c, "function", "name"),
                              "arguments": _get(c, "function", "arguments")})
            else:
                calls.append({"id": _get(c, "id"), "name": _get(c, "custom", "name"),
                              "arguments": _get(c, "custom", "input")})
    if isinstance(output, list):
        for item in output:
            kind = _get(item, "type")
            if kind not in _RESPONSES_CALL_TYPES:
                continue
            name = _get(item, "name") or kind
            call = {"id": _get(item, "call_id") or _get(item, "id"), "name": name,
                    "arguments": _get(item, "arguments") if _get(item, "arguments") is not None else _get(item, "input")}
            if kind == "mcp_call":
                call["name"] = _mcp_name(_get(item, "server_label"), name)
                if _get(item, "server_label"):
                    call.update(server=_get(item, "server_label"), source="provider", failed=_get(item, "error") is not None)
            calls.append(call)
    if isinstance(candidates, list) and candidates:
        parts = _get(candidates[0], "content", "parts")
        for part in parts if isinstance(parts, list) else []:
            call = _get(part, "functionCall") or _get(part, "function_call")
            if call is not None and _get(call, "name"):
                calls.append({"id": _get(call, "id"), "name": _get(call, "name"), "arguments": _get(call, "args")})
    return calls


def clean_feature(value: Any) -> str | None:
    """The optional feature label a call is sent with, made safe for the server's rules (letters, digits, spaces and . _ - only, at most
    100 characters, starting with a letter or digit). Anything else becomes an underscore. None when nothing usable is left, so a
    strange label never makes the whole call be refused."""
    if value is None:
        return None
    text = "".join(c if (c.isascii() and (c.isalnum() or c in "._ -")) else "_" for c in str(value).strip())[:100].strip(" ._-")
    return text or None


def estimate_tools_tokens(tools: Any) -> int | None:
    """Estimated tokens of the tool definitions: len(json.dumps(tools, sort_keys=True)) // 4.
    None when they cannot be serialised."""
    try:
        return len(json.dumps(tools, sort_keys=True, default=str)) // 4
    except (TypeError, ValueError):
        return None


def was_cut_off(response: Any) -> bool:
    """True when the answer stopped at its output limit rather than finishing: OpenAI-shaped
    `finish_reason == "length"`, or Anthropic-shaped `stop_reason == "max_tokens"`."""
    if _get(response, "stop_reason") == "max_tokens":
        return True
    choices = _get(response, "choices")
    return isinstance(choices, list) and bool(choices) and _get(choices[0], "finish_reason") == "length"


class RunRecorder:
    """Context manager around one model call. Observes; never intercepts."""

    def __init__(
        self,
        job: str,
        *,
        prompt_version: str | None = None,
        provider: str | None = None,
        sender: Sender | None = None,
        send_tool_arguments: bool = False,
    ) -> None:
        self.job = job
        self.prompt_version = prompt_version
        self.provider = provider
        self.send_tool_arguments = send_tool_arguments  # off by default: arguments can hold sensitive data
        self._sender = sender
        self._started = 0.0
        self._payload: dict[str, Any] | None = None

    def __enter__(self) -> RunRecorder:
        self._started = time.perf_counter()
        self._payload = None
        return self

    def capture(
        self,
        response: Any = None,
        *,
        prompt: str,
        model: str | None = None,
        model_version: str | None = None,
        agent: str | None = None,
        feature: str | None = None,
        trace_id: str | None = None,
        span_id: str | None = None,
        parent_span_id: str | None = None,
        tools: list[Any] | None = None,
        **explicit: Any,
    ) -> None:
        """Record this call. Never raises.

        `response` is the provider response; usage, resolved model and output are read from it.
        `prompt` is the text that was sent. `model` is the model that was asked for (defaults to the
        resolved one). Anything the response does not carry can be passed as a keyword: tokens_in,
        tokens_out, cache_read_tokens, cache_write_tokens, cost_usd, output, tool_calls, latency_ms, provider,
        effort (the reasoning effort the call asked for, e.g. "low", so it is compared as its own option).

        `feature` is optional: your own name for the feature or workflow this call serves (for example "support_summary"), so the cost
        can be shown per feature. It is your label, not a verified identity, and nothing is ever inferred from the prompt to fill it.
        Letters, digits, spaces and . _ - only, at most 100 characters; anything else becomes an underscore.

        For multi-agent and tool-heavy apps, all optional: `agent` (which agent or role made the call,
        at most 100 characters), `trace_id` (one id shared by every call that serves the same user
        task, at most 200), `span_id` (this call's own id) with `parent_span_id` (the span_id of the call that
        started it, so a task can be shown as a tree; each at most 200) and `tools` (the tool or function definitions sent with the request).
        From `tools` the recorder sends `tools_tokens`, an ESTIMATE: len(json.dumps(tools,
        sort_keys=True)) // 4, because providers do not report the size of tool definitions
        separately (they are inside tokens_in).
        """
        try:
            data = read_response(response, include_arguments=self.send_tool_arguments) if response is not None else {}
            data.update({k: v for k, v in explicit.items() if v is not None})
            if "tool_calls" in data:  # an explicitly passed list gets the same rule as one read from a response
                data["tool_calls"] = sanitize_tool_calls(data["tool_calls"], keep_arguments=self.send_tool_arguments)
            if agent:
                data["agent"] = str(agent)[:100]
            cleaned = clean_feature(feature)
            if cleaned:
                data["feature"] = cleaned
            if trace_id:
                data["trace_id"] = str(trace_id)[:200]
            if span_id:
                data["span_id"] = str(span_id)[:200]
            if parent_span_id:
                data["parent_span_id"] = str(parent_span_id)[:200]
            if tools:
                data["tools_tokens"] = estimate_tools_tokens(tools)
            resolved = model_version or data.pop("model_version", None) or model or "unknown"
            data["model_version"] = resolved
            self._payload = {
                "run_id": str(uuid.uuid4()),
                "job": self.job,
                "prompt": prompt,
                "model": model or resolved,
                "prompt_version": self.prompt_version,
                **({"provider": self.provider} if self.provider else {}),
                **data,
            }
        except Exception:
            log.exception("could not read the model response; this run will not be recorded")
            self._payload = None

    def __exit__(self, exc_type: object, exc: object, tb: object) -> bool:
        try:
            if self._payload is not None:
                self._payload.setdefault("latency_ms", int((time.perf_counter() - self._started) * 1000))
                (self._sender or default_sender()).submit(self._payload)
        except Exception:
            log.exception("could not queue the run; the application is unaffected")
        return False  # never swallow the application's own exceptions
