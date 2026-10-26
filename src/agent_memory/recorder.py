"""RunRecorder: the SDK an engineer wraps around an existing model call.

    from agent_memory.recorder import RunRecorder

    with RunRecorder(job="invoice-extract") as rec:
        response = client.messages.create(model="...", messages=[...])   # the app's own call, unchanged
        rec.capture(response, prompt=prompt)                              # reads usage, model and output

It copies the run to POST /v1/runs in a background thread. It adds well under 5 ms to the call, never
waits for the network, and never raises into the application: if the API is down the run is dropped
after a short retry and a warning is logged. The production call itself never goes through us.

Configuration comes from the environment: MCM_API_URL (default http://127.0.0.1:8000) and MCM_API_KEY.
"""

from __future__ import annotations

import atexit
import logging
import os
import queue
import threading
import time
import uuid
from typing import Any

import httpx

from .privacy import sanitize_tool_calls

log = logging.getLogger("agent_memory.recorder")

DEFAULT_API_URL = "http://127.0.0.1:8000"
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


def _get(obj: Any, *path: str) -> Any:
    """Read obj.a.b or obj['a']['b'], returning None when any step is missing."""
    for name in path:
        if obj is None:
            return None
        obj = obj.get(name) if isinstance(obj, dict) else getattr(obj, name, None)
    return obj


def _int(value: Any) -> int:
    return int(value) if isinstance(value, (int, float)) and not isinstance(value, bool) else 0


def read_response(response: Any, *, include_arguments: bool = False) -> dict[str, Any]:
    """Pull model, usage and output out of an Anthropic- or OpenAI-shaped response (object or dict).

    `tokens_in` is uncached input only: OpenAI counts cached tokens inside `prompt_tokens`, so they
    are subtracted here to keep cost exact (docs/ARCHITECTURE.md, cost calculation).

    Tool calls are reduced to their names and ids; arguments are included only when `include_arguments`.
    """
    out: dict[str, Any] = {"model_version": _get(response, "model")}

    usage = _get(response, "usage")
    if _get(usage, "input_tokens") is not None:  # Anthropic
        out["tokens_in"] = _int(_get(usage, "input_tokens"))
        out["tokens_out"] = _int(_get(usage, "output_tokens"))
        out["cache_read_tokens"] = _int(_get(usage, "cache_read_input_tokens"))
        out["cache_write_tokens"] = _int(_get(usage, "cache_creation_input_tokens"))
    elif _get(usage, "prompt_tokens") is not None:  # OpenAI and compatible servers (incl. Ollama)
        cached = _int(_get(usage, "prompt_tokens_details", "cached_tokens"))
        out["tokens_in"] = max(_int(_get(usage, "prompt_tokens")) - cached, 0)
        out["tokens_out"] = _int(_get(usage, "completion_tokens"))
        out["cache_read_tokens"] = cached

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

    calls: list[dict[str, Any]] = []
    if isinstance(content, list):  # Anthropic: tool_use blocks
        calls += [
            {"id": _get(b, "id"), "name": _get(b, "name"), "arguments": _get(b, "input")}
            for b in content if _get(b, "type") == "tool_use"
        ]
    if isinstance(choices, list) and choices:  # OpenAI: message.tool_calls
        calls += [
            {"id": _get(c, "id"), "name": _get(c, "function", "name"), "arguments": _get(c, "function", "arguments")}
            for c in (_get(choices[0], "message", "tool_calls") or [])
        ]
    if calls:
        out["tool_calls"] = sanitize_tool_calls(calls, keep_arguments=include_arguments)
    return out


class RunRecorder:
    """Context manager around one model call. Observes; never intercepts."""

    def __init__(
        self,
        job: str,
        *,
        prompt_version: str | None = None,
        sender: Sender | None = None,
        send_tool_arguments: bool = False,
    ) -> None:
        self.job = job
        self.prompt_version = prompt_version
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
        **explicit: Any,
    ) -> None:
        """Record this call. Never raises.

        `response` is the provider response; usage, resolved model and output are read from it.
        `prompt` is the text that was sent. `model` is the model that was asked for (defaults to the
        resolved one). Anything the response does not carry can be passed as a keyword: tokens_in,
        tokens_out, cache_read_tokens, cache_write_tokens, cost_usd, output, tool_calls, latency_ms.
        """
        try:
            data = read_response(response, include_arguments=self.send_tool_arguments) if response is not None else {}
            data.update({k: v for k, v in explicit.items() if v is not None})
            if "tool_calls" in data:  # an explicitly passed list gets the same rule as one read from a response
                data["tool_calls"] = sanitize_tool_calls(data["tool_calls"], keep_arguments=self.send_tool_arguments)
            resolved = model_version or data.pop("model_version", None) or model or "unknown"
            data["model_version"] = resolved
            self._payload = {
                "run_id": str(uuid.uuid4()),
                "job": self.job,
                "prompt": prompt,
                "model": model or resolved,
                "prompt_version": self.prompt_version,
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
