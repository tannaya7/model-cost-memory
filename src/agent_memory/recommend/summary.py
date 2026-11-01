"""The optional two-sentence summary of a recommendation (technical plan 3.10, 5.2).

The only place the system calls a model for itself. Off unless ANTHROPIC_API_KEY is set. It receives
the computed figures only (never runs or prompts), and it never decides anything: if the call fails,
times out, or the text does not name the recommended model, the recommendation is returned without
a summary. Summaries are cached by the figures they describe, so polling does not cost a call each
time. The prompt file's git blob hash is returned with every summary, so a changed prompt is visible.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import os
from pathlib import Path

from cachetools import TTLCache

from ..config import Settings
from .engine import JobRecommendation

log = logging.getLogger("agent_memory.summary")

PROMPT_FILE = Path(__file__).resolve().parents[1] / "prompts" / "recommendation_summary.md"
DEADLINE_SECONDS = 4.0  # a recommendation never waits longer than this for its summary
_cache: TTLCache = TTLCache(maxsize=1024, ttl=3600)


def _prompt() -> tuple[str, str]:
    """The instructions (comments stripped) and the file's git blob hash."""
    raw = PROMPT_FILE.read_bytes()
    version = hashlib.sha1(b"blob %d\0" % len(raw) + raw).hexdigest()
    text = raw.decode("utf8")
    if text.startswith("<!--"):
        text = text.split("-->", 1)[1]
    return text.strip(), version


def figures(result: JobRecommendation) -> dict:
    """What the model is allowed to see: numbers and model names, nothing else."""
    d = result.decision
    out = {
        "verdict": d.verdict,
        "current_model": d.current.model if d.current else None,
        "recommended_model": d.recommended.model if d.recommended else None,
        "models": [
            {"model": m.model, "status": m.status, "catalog_status": m.catalog_status,
             "pass_rate": round(m.sample.pass_rate, 4) if m.sample else None,
             "pass_rate_range": [round(m.pass_rate_low, 4), round(m.pass_rate_high, 4)]
             if m.pass_rate_low is not None else None,
             "cost_per_success_usd": round(m.cost_per_success_usd, 6) if m.cost_per_success_usd else None,
             "checked_runs": m.n_runs}
            for m in d.models
        ],
        "warnings": d.warnings,
    }
    if result.forecast:
        out["monthly_saving_usd"] = round(result.forecast.monthly_saving_usd, 2)
        out["extra_failures_per_month"] = round(result.forecast.extra_failures_per_month, 1)
    return out


async def _call(settings: Settings, instructions: str, payload: str) -> str | None:
    import anthropic

    client = anthropic.AsyncAnthropic(timeout=DEADLINE_SECONDS, max_retries=0)
    try:
        response = await client.messages.create(
            model=settings.summary_model, max_tokens=300, system=instructions,
            output_config={"effort": "low"},  # two sentences of arithmetic already done
            messages=[{"role": "user", "content": payload}],
        )
    except anthropic.APIError as exc:  # connection, timeout, rate limit, 4xx/5xx: no summary, no error
        log.warning("summary unavailable: %s", type(exc).__name__)
        return None
    finally:
        await client.close()
    if response.stop_reason != "end_turn":
        return None
    return "".join(block.text for block in response.content if block.type == "text").strip() or None


async def summarize(result: JobRecommendation, settings: Settings) -> tuple[str | None, str | None]:
    """(summary, prompt version), or (None, None) when off, failed, or not trustworthy."""
    if not os.environ.get("ANTHROPIC_API_KEY") or result.decision.verdict == "INSUFFICIENT_EVIDENCE":
        return None, None
    instructions, version = _prompt()
    payload = json.dumps(figures(result), sort_keys=True)
    key = (settings.summary_model, version, payload)
    if key in _cache:
        return _cache[key], version
    try:
        text = await asyncio.wait_for(_call(settings, instructions, payload), DEADLINE_SECONDS + 1)
    except TimeoutError:
        return None, None
    recommended = result.decision.recommended.model if result.decision.recommended else None
    if text is None or (recommended and recommended not in text):  # the figures win; drop the summary
        return None, None
    _cache[key] = text
    return text, version
