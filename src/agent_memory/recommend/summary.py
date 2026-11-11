"""The optional two-sentence summary of a recommendation (technical plan 3.10, 5.2).

The only place the system calls a model for itself. Off unless ANTHROPIC_API_KEY is set. It receives
the computed figures only (never runs or prompts), and it never decides anything: if the call fails,
times out, or the text does not name the recommended model, the recommendation is returned without
a summary.

**Once per verdict.** A summary is stored (`recommendation_summaries`) under a key made of the job, the
summary model, the prompt's version and what the verdict *says*: the verdict, the model in use, the
recommended model, and each model's status. The figures sent are those of the moment it was written;
new runs that move a pass rate without changing the verdict reuse it, so polling a busy job does not
pay for a call each time and a restart forgets nothing. The figures beside it in the response are
always current.

**A daily limit.** At most `summary_daily_limit` calls a day (UTC) across the server, counted in the
database. A failed call is retried for the same verdict after RETRY_AFTER, never sooner.

The prompt file's git blob hash is returned with every summary, so a changed prompt is visible.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import os
from datetime import UTC, datetime, timedelta
from pathlib import Path

from sqlalchemy import func, select, update
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from ..config import Settings
from ..models import Job, RecommendationSummary
from .engine import JobRecommendation

log = logging.getLogger("agent_memory.summary")

PROMPT_FILE = Path(__file__).resolve().parents[1] / "prompts" / "recommendation_summary.md"
DEADLINE_SECONDS = 4.0  # a recommendation never waits longer than this for its summary
RETRY_AFTER = timedelta(hours=1)
MAX_TOKENS = 300  # two sentences; thinking is off, so all of it is answer


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


def verdict_identity(result: JobRecommendation) -> dict:
    """What the verdict says, without the figures that move with every run."""
    d = result.decision
    return {
        "verdict": d.verdict,
        "current_model": d.current.model if d.current else None,
        "recommended_model": d.recommended.model if d.recommended else None,
        "models": sorted([m.model, m.status, m.catalog_status] for m in d.models),
    }


def summary_key(job: Job, result: JobRecommendation, settings: Settings, prompt_version: str) -> str:
    identity = json.dumps([str(job.job_id), settings.summary_model, prompt_version, verdict_identity(result)],
                          sort_keys=True)
    return hashlib.sha256(identity.encode()).hexdigest()


async def _call(settings: Settings, instructions: str, payload: str) -> str | None:
    import anthropic

    client = anthropic.AsyncAnthropic(timeout=DEADLINE_SECONDS, max_retries=0)
    try:
        response = await client.messages.create(
            model=settings.summary_model, max_tokens=MAX_TOKENS, system=instructions,
            # Two sentences of arithmetic already done: no thinking (allowed on Haiku 5.5 at low effort),
            # so the whole token budget goes to the answer and it is never cut off mid-thought.
            thinking={"type": "disabled"}, output_config={"effort": "low"},
            messages=[{"role": "user", "content": payload}],
        )
    except anthropic.RateLimitError:
        log.warning("summary unavailable: rate limited")
        return None
    except anthropic.APIStatusError as exc:  # 4xx/5xx, e.g. a wrong model name or a rejected parameter
        log.error("summary call rejected: HTTP %s %s", exc.status_code, exc.message,
                  extra={"request_id": getattr(exc, "request_id", None)})
        return None
    except anthropic.APIConnectionError as exc:  # includes timeouts
        log.warning("summary unavailable: %s", type(exc).__name__)
        return None
    finally:
        await client.close()
    if response.stop_reason != "end_turn":
        log.warning("summary dropped: stop_reason %s", response.stop_reason,
                    extra={"request_id": getattr(response, "_request_id", None)})
        return None
    return "".join(block.text for block in response.content if block.type == "text").strip() or None


async def _claim(session: AsyncSession, key: str, job: Job, version: str, settings: Settings,
                 now: datetime) -> bool:
    """Reserve this verdict's call, within the daily limit. False when another request holds it, it
    failed too recently, or today's calls are used up."""
    day = now.replace(hour=0, minute=0, second=0, microsecond=0)
    used = (await session.execute(
        select(func.coalesce(func.sum(RecommendationSummary.attempts), 0))
        .where(RecommendationSummary.attempted_at >= day))).scalar_one()
    if used >= settings.summary_daily_limit:
        log.info("summary skipped: daily limit reached", extra={"limit": settings.summary_daily_limit})
        return False
    inserted = (await session.execute(
        insert(RecommendationSummary).values(summary_key=key, job_id=job.job_id, prompt_version=version,
                                             attempts=1, attempted_at=now)
        .on_conflict_do_nothing(index_elements=["summary_key"]).returning(RecommendationSummary.summary_key)
    )).scalar_one_or_none()
    if inserted is None:  # an earlier attempt failed: retry only once it is old enough
        retried = (await session.execute(
            update(RecommendationSummary)
            .where(RecommendationSummary.summary_key == key, RecommendationSummary.summary.is_(None),
                   RecommendationSummary.attempted_at < now - RETRY_AFTER)
            .values(attempts=RecommendationSummary.attempts + 1, attempted_at=now)
            .returning(RecommendationSummary.summary_key)
        )).scalar_one_or_none()
        if retried is None:
            await session.commit()  # nothing was written; commit (not rollback) keeps loaded rows usable
            return False
    await session.commit()
    return True


async def summarize(session: AsyncSession, job: Job, result: JobRecommendation,
                    settings: Settings, *, now: datetime | None = None) -> tuple[str | None, str | None]:
    """(summary, prompt version), or (None, None) when off, failed, limited, or not trustworthy."""
    if not os.environ.get("ANTHROPIC_API_KEY") or result.decision.verdict == "INSUFFICIENT_EVIDENCE":
        return None, None
    now = now or datetime.now(UTC)
    instructions, version = _prompt()
    key = summary_key(job, result, settings, version)
    stored = await session.get(RecommendationSummary, key)
    if stored is not None and stored.summary is not None:
        return stored.summary, stored.prompt_version
    if not await _claim(session, key, job, version, settings, now):
        return None, None
    payload = json.dumps(figures(result), sort_keys=True)
    try:
        text = await asyncio.wait_for(_call(settings, instructions, payload), DEADLINE_SECONDS + 1)
    except TimeoutError:
        log.warning("summary unavailable: deadline passed")
        text = None
    except Exception:  # never let the optional summary break the recommendation
        log.exception("summary call failed")
        text = None
    recommended = result.decision.recommended.model if result.decision.recommended else None
    if text is not None and recommended and recommended not in text:  # the figures win; drop the summary
        log.warning("summary dropped: it does not name the recommended model", extra={"recommended": recommended})
        text = None
    if text is None:
        return None, None
    await session.execute(update(RecommendationSummary).where(RecommendationSummary.summary_key == key)
                          .values(summary=text))
    await session.commit()
    return text, version
