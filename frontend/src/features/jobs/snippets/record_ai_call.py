import json
import os
import threading
import urllib.request
import uuid


def _tokens(usage):
    """Token counts from an OpenAI-style or Anthropic-style usage block. A missing number counts as 0."""
    u = usage if isinstance(usage, dict) else getattr(usage, "model_dump", lambda: {})()
    u = u or {}
    cached = (u.get("prompt_tokens_details") or {}).get("cached_tokens") or u.get("cache_read_input_tokens") or 0
    written = u.get("cache_creation_input_tokens") or 0
    if "prompt_tokens" in u:  # OpenAI style: cached tokens are counted inside prompt_tokens
        return max((u.get("prompt_tokens") or 0) - cached, 0), u.get("completion_tokens") or 0, cached, written
    return u.get("input_tokens") or 0, u.get("output_tokens") or 0, cached, written  # Anthropic style


def record_ai_call(task, prompt, answer, model, model_version, provider, usage=None, latency_ms=None, prompt_version=None):
    """Send a copy of one finished AI call to the dashboard. It runs in the background and never raises,
    so it cannot slow down or break your app."""

    def send():
        try:
            tokens_in, tokens_out, cache_read, cache_write = _tokens(usage)
            body = {
                "run_id": str(uuid.uuid4()),  # a new id for each call
                "job": task,  # the task name from the list
                "prompt": prompt, "output": answer, "model": model,
                "model_version": model_version,  # the exact model name the provider returned
                "provider": provider,  # for example "openai"
                "tokens_in": tokens_in, "tokens_out": tokens_out,
                "cache_read_tokens": cache_read, "cache_write_tokens": cache_write,
                "latency_ms": latency_ms, "prompt_version": prompt_version,
            }
            request = urllib.request.Request(
                os.environ["MCM_API_URL"].rstrip("/") + "/v1/runs",
                data=json.dumps({k: v for k, v in body.items() if v is not None}).encode(),
                headers={"X-API-Key": os.environ["MCM_API_KEY"], "Content-Type": "application/json"},
                method="POST",
            )
            urllib.request.urlopen(request, timeout=5).close()
        except Exception:
            pass  # the dashboard being unreachable must never break your app

    threading.Thread(target=send, daemon=True).start()
