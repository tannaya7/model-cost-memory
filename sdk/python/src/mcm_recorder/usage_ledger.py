"""The canonical token ledger: what each provider reported, mapped to distinct fields.

A provider's usage block is read ONCE here into named fields. Each field is an int, or None when the provider
did not expose it. None means "unknown / not reported", never zero. The old four run columns (tokens_in,
tokens_out, cache_read_tokens, cache_write_tokens) are derived from the ledger in `legacy_columns`, and only
that step turns "unknown" into 0, because those columns are plain integers.

Field meanings (one set for every provider):
  input_total      all input the provider counted, cached and written tokens included, where it reports one
  uncached_input   input billed at the ordinary input price (what `runs.tokens_in` holds)
  cache_read       input read from the prompt cache (billed at the cache-read price)
  cache_write      input written to the cache; cache_write_1h is the part kept for 1 hour (Anthropic only)
  tool_use_input   Gemini only: tokens of tool-execution results handed back to the model. How Google bills
                   them is NOT documented, so they are kept apart and never priced
  reasoning        reasoning/thinking tokens, where the provider reports them separately
  output_billed    output as billed, reasoning included (what `runs.tokens_out` holds)
  total_reported   the provider's own total, kept to check our parts against

Included in, or additional to, another field (verified 2026-11-17 against the SDK sources and docs listed in
research_notes/Provider facts retry/provider_usage_and_pricing.md; the dated checks are repeated in INCLUSION):
  anthropic  cache_read and cache_write are ADDITIONAL to input_tokens; reasoning is INSIDE output_tokens
  openai     cached and cache-write tokens are INSIDE prompt_tokens / input_tokens; reasoning is INSIDE the output
  deepseek   prompt_tokens = cache hit + cache miss; reasoning is INSIDE completion_tokens
  gemini     cached tokens are INSIDE promptTokenCount; thoughts are ADDITIONAL to candidates; tool-use prompt
             tokens are ADDITIONAL to the prompt

Pure and offline: no provider is called.
"""

from __future__ import annotations

from typing import Any

# The shapes this module can read. "none" = the response carried no usage block at all (nothing was reported).
SHAPES = ("anthropic_messages", "openai_responses", "openai_chat", "deepseek_chat", "gemini", "none")

INCLUSION: dict[str, dict[str, str]] = {
    "anthropic_messages": {
        "cache_read": "additional to input_tokens", "cache_write": "additional to input_tokens",
        "reasoning": "inside output_tokens", "total": "not reported",
    },
    "openai_responses": {
        "cache_read": "inside input_tokens", "cache_write": "inside input_tokens",
        "reasoning": "inside output_tokens", "total": "total_tokens = input + output",
    },
    "openai_chat": {
        "cache_read": "inside prompt_tokens", "cache_write": "inside prompt_tokens",
        "reasoning": "inside completion_tokens", "total": "total_tokens = prompt + completion",
    },
    "deepseek_chat": {
        "cache_read": "inside prompt_tokens (prompt = hit + miss)", "cache_write": "not reported",
        "reasoning": "inside completion_tokens", "total": "total_tokens = prompt + completion",
    },
    "gemini": {
        "cache_read": "inside promptTokenCount", "cache_write": "not reported",
        "reasoning": "additional to candidatesTokenCount", "tool_use_input": "additional to promptTokenCount",
        "total": "prompt + candidates + tool-use prompt + thoughts",
    },
    "none": {},
}

# Enum-like strings worth keeping from the raw block (they change the price); nothing else that is text.
_KEEP_STRINGS = ("service_tier", "inference_geo", "speed")
_MAX_KEYS = 40
_MAX_DEPTH = 3
_MAX_INT = 2_000_000_000


def _get(obj: Any, *path: str) -> Any:
    """obj.a.b or obj['a']['b'], None when any step is missing (the same walk the recorder uses)."""
    for name in path:
        if obj is None:
            return None
        obj = obj.get(name) if isinstance(obj, dict) else getattr(obj, name, None)
    return obj


def _num(value: Any) -> int | None:
    """A provider count as an int, or None when it is absent, null, negative, boolean or not a number.

    Zero is a real value and stays 0; only a missing or unusable value becomes None (unknown)."""
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    if value != value or value < 0 or value > _MAX_INT:  # NaN, negative or absurd
        return None
    return int(value)


def _first(usage: Any, *names: str) -> int | None:
    """The first of several spellings (SDK snake_case, REST camelCase) that holds a usable number."""
    for name in names:
        number = _num(_get(usage, name))
        if number is not None:
            return number
    return None


def _as_dict(obj: Any) -> dict[str, Any] | None:
    if isinstance(obj, dict):
        return obj
    for method in ("model_dump", "to_dict", "dict"):  # pydantic and SDK objects
        fn = getattr(obj, method, None)
        if callable(fn):
            try:
                dumped = fn()
            except Exception:  # noqa: BLE001 - a odd object must never break recording
                continue
            if isinstance(dumped, dict):
                return dumped
    attrs = getattr(obj, "__dict__", None)
    return dict(attrs) if isinstance(attrs, dict) else None


def sanitize_raw(usage: Any) -> dict[str, Any] | None:
    """The provider's usage block, reduced to numbers (plus a few price-changing labels), bounded in size.

    Kept so a figure can be audited or re-read later if a provider changes its shape. Never holds text from a
    prompt or answer: a value is kept only if it is a non-negative number or one of _KEEP_STRINGS."""
    source = _as_dict(usage)
    if source is None:
        return None
    budget = [_MAX_KEYS]

    def walk(node: dict[str, Any], depth: int) -> dict[str, Any]:
        kept: dict[str, Any] = {}
        for key, value in node.items():
            if budget[0] <= 0:
                break
            if not isinstance(key, str) or len(key) > 60:
                continue
            if isinstance(value, bool):
                continue
            if isinstance(value, (int, float)):
                number = _num(value)
                if number is not None:
                    kept[key] = number
                    budget[0] -= 1
            elif isinstance(value, str) and key in _KEEP_STRINGS and len(value) <= 40:
                kept[key] = value
                budget[0] -= 1
            elif depth < _MAX_DEPTH and (isinstance(value, dict) or _as_dict(value) is not None):
                inner = walk(_as_dict(value) or {}, depth + 1)
                if inner:
                    kept[key] = inner
        return kept

    result = walk(source, 1)
    return result or None


def _sub(total: int | None, *parts: int | None) -> int | None:
    """total minus the parts that are known; None when the total itself is unknown. Never below 0."""
    if total is None:
        return None
    return max(total - sum(p for p in parts if p is not None), 0)


def read_usage(usage: Any) -> dict[str, Any]:
    """Read one provider usage block into the canonical ledger.

    Returns {"shape", "fields", "raw", "notes"}; `fields` maps each field to an int or None. A response with
    no usage block gives shape "none" and every field None."""
    shape = "none"
    f: dict[str, int | None] = dict.fromkeys(
        ("input_total", "uncached_input", "cache_read", "cache_write", "cache_write_1h", "tool_use_input",
         "reasoning", "output_billed", "total_reported"), None)
    notes: list[str] = []

    if usage is None:
        return {"shape": "none", "fields": f, "raw": None, "notes": ["the response carried no usage block"]}

    if _num(_get(usage, "input_tokens")) is not None and _get(usage, "input_tokens_details") is not None:
        shape = "openai_responses"  # input_tokens + input_tokens_details: ResponseUsage
        f["input_total"] = _num(_get(usage, "input_tokens"))
        f["cache_read"] = _num(_get(usage, "input_tokens_details", "cached_tokens"))
        f["cache_write"] = _num(_get(usage, "input_tokens_details", "cache_write_tokens"))
        f["uncached_input"] = _sub(f["input_total"], f["cache_read"], f["cache_write"])
        f["output_billed"] = _num(_get(usage, "output_tokens"))
        f["reasoning"] = _num(_get(usage, "output_tokens_details", "reasoning_tokens"))
        f["total_reported"] = _num(_get(usage, "total_tokens"))
    elif _num(_get(usage, "input_tokens")) is not None or _num(_get(usage, "cache_read_input_tokens")) is not None:
        shape = "anthropic_messages"
        f["uncached_input"] = _num(_get(usage, "input_tokens"))
        f["cache_read"] = _num(_get(usage, "cache_read_input_tokens"))
        f["cache_write"] = _num(_get(usage, "cache_creation_input_tokens"))
        one_hour = _num(_get(usage, "cache_creation", "ephemeral_1h_input_tokens"))
        if one_hour is not None and f["cache_write"] is not None:
            f["cache_write_1h"] = min(one_hour, f["cache_write"])
        elif one_hour is not None:  # a split without the total: trust the split
            f["cache_write"] = one_hour + (_num(_get(usage, "cache_creation", "ephemeral_5m_input_tokens")) or 0)
            f["cache_write_1h"] = one_hour
        f["output_billed"] = _num(_get(usage, "output_tokens"))
        # Thinking is inside output_tokens ("the inclusive, authoritative total used for billing"); the SDK's
        # output_tokens_details sub-field names were not verified, so the split is left unknown (raw keeps it).
        known = [v for v in (f["uncached_input"], f["cache_read"], f["cache_write"]) if v is not None]
        if known and len(known) == 3:  # Anthropic reports no total, so the input total is derived
            f["input_total"] = sum(known)
    elif _num(_get(usage, "prompt_cache_hit_tokens")) is not None:
        shape = "deepseek_chat"
        hit = _num(_get(usage, "prompt_cache_hit_tokens"))
        miss = _num(_get(usage, "prompt_cache_miss_tokens"))
        f["input_total"] = _num(_get(usage, "prompt_tokens"))
        f["cache_read"] = hit
        f["uncached_input"] = miss if miss is not None else _sub(f["input_total"], hit)
        f["output_billed"] = _num(_get(usage, "completion_tokens"))
        f["reasoning"] = _num(_get(usage, "completion_tokens_details", "reasoning_tokens"))
        f["total_reported"] = _num(_get(usage, "total_tokens"))
    elif _num(_get(usage, "prompt_tokens")) is not None or _num(_get(usage, "completion_tokens")) is not None:
        shape = "openai_chat"  # OpenAI Chat Completions and compatible servers (Ollama, Groq, ...)
        f["input_total"] = _num(_get(usage, "prompt_tokens"))
        f["cache_read"] = _num(_get(usage, "prompt_tokens_details", "cached_tokens"))
        f["cache_write"] = _num(_get(usage, "prompt_tokens_details", "cache_write_tokens"))
        f["uncached_input"] = _sub(f["input_total"], f["cache_read"], f["cache_write"])
        f["output_billed"] = _num(_get(usage, "completion_tokens"))
        f["reasoning"] = _num(_get(usage, "completion_tokens_details", "reasoning_tokens"))
        f["total_reported"] = _num(_get(usage, "total_tokens"))
    elif _first(usage, "prompt_token_count", "promptTokenCount") is not None or _first(
            usage, "candidates_token_count", "candidatesTokenCount") is not None:
        shape = "gemini"
        prompt = _first(usage, "prompt_token_count", "promptTokenCount")
        f["input_total"] = prompt
        f["cache_read"] = _first(usage, "cached_content_token_count", "cachedContentTokenCount")
        f["uncached_input"] = _sub(prompt, f["cache_read"])
        f["tool_use_input"] = _first(usage, "tool_use_prompt_token_count", "toolUsePromptTokenCount")
        f["reasoning"] = _first(usage, "thoughts_token_count", "thoughtsTokenCount")
        candidates = _first(usage, "candidates_token_count", "candidatesTokenCount")
        if candidates is not None or f["reasoning"] is not None:
            f["output_billed"] = (candidates or 0) + (f["reasoning"] or 0)  # thoughts are billed as output
        f["total_reported"] = _first(usage, "total_token_count", "totalTokenCount")
        if f["tool_use_input"]:
            notes.append(f"{f['tool_use_input']} tool-use prompt tokens are kept apart and not priced: Google "
                         "does not document how they are billed, so the cost may be understated")
    else:
        notes.append("the usage block has an unrecognised shape; nothing was read from it")

    _reconcile(shape, f, notes)
    return {"shape": shape, "fields": f, "raw": sanitize_raw(usage), "notes": notes}


def _reconcile(shape: str, f: dict[str, int | None], notes: list[str]) -> None:
    """Compare the provider's own total with the sum of our parts, and say so when they differ.

    A difference is a note, not an error: it can come from a field this module does not know (audio, accepted
    predictions) and it must not stop a run from being recorded."""
    reported = f["total_reported"]
    if reported is None:
        return
    if shape == "gemini":
        parts = [f["input_total"], f["output_billed"], f["tool_use_input"]]
    elif shape in ("openai_chat", "openai_responses", "deepseek_chat"):
        parts = [f["input_total"], f["output_billed"]]
    else:
        return
    if any(p is None for p in parts[:2]):
        return
    ours = sum(p for p in parts if p is not None)
    if ours != reported:
        notes.append(f"the provider's total ({reported}) differs from the sum of its parts ({ours})")


def legacy_columns(ledger: dict[str, Any]) -> dict[str, int]:
    """The four integer run columns derived from the ledger.

    When a usage block was read, all four are returned and an unreported one becomes 0 here (the old columns are
    plain integers, and callers rely on them being present); the ledger fields and `usage_shape` still tell a
    stored 0 from a missing one. When no usage block was read, nothing is returned, so the counts stay unset."""
    if ledger["shape"] == "none":
        return {}
    f = ledger["fields"]
    out = {
        "tokens_in": f["uncached_input"] or 0,
        "tokens_out": f["output_billed"] or 0,
        "cache_read_tokens": f["cache_read"] or 0,
        "cache_write_tokens": f["cache_write"] or 0,
    }
    if f["cache_write_1h"]:
        out["cache_write_1h_tokens"] = f["cache_write_1h"]
    return out
