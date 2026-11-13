"""The optional two-sentence summary of a recommendation (technical plan 3.10, 5.2).

The only place the system calls a model for itself, through any OpenAI-compatible endpoint (Gemini's
free tier by default). Off unless SUMMARY_API_KEY, or failing that GEMINI_API_KEY, is set. It receives
the computed figures only (never runs or prompts), and it never decides anything: if the call fails
(a free tier is sometimes overloaded), times out, is cut off, or the text does not name the
recommended model, the recommendation is returned without a summary.

**Once per verdict.** A summary is stored (`recommendation_summaries`) under a key made of the job, the
summary model, the prompt's version and what the verdict *says*: the verdict, the model in use, the
recommended model, and each model's status. The figures sent are those of the moment it was written;
new runs that move a pass rate without changing the verdict reuse it, so polling a busy job does not
pay for a call each time and a restart forgets nothing. The figures beside it in the response are
always current.

**Never in the way.** A recommendation waits at most DEADLINE_SECONDS for its summary. A free tier often
takes longer (3-27 s measured on 12 Nov 2026), so the call carries on in the background for up to
CALL_SECONDS and stores its answer; the next request for that recommendation shows it.

**A daily limit.** At most `summary_daily_limit` calls a day (UTC) across the server, counted in the
database. A failed call (a free tier answers "high demand" now and then) is retried for the same verdict
after RETRY_AFTER, never sooner.

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
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from ..config import Settings
from ..models import Job, RecommendationSummary
from .engine import JobRecommendation

log = logging.getLogger("agent_memory.summary")
_writing: set[asyncio.Task] = set()  # summaries still being written after their request returned

PROMPT_FILE = Path(__file__).resolve().parents[1] / "prompts" / "recommendation_summary.md"
DEADLINE_SECONDS = 4.0  # a recommendation never waits longer than this for its summary
CALL_SECONDS = 30.0  # the call itself may take this long; past the deadline it finishes in the background
RETRY_AFTER = timedelta(minutes=10)
MAX_TOKENS = 600  # two sentences (about 100 tokens) plus room for minimal thinking


def api_key() -> str | None:
    """The summary's key: its own, or the server's Gemini key. None switches summaries off."""
    return os.environ.get("SUMMARY_API_KEY") or os.environ.get("GEMINI_API_KEY") or None


def _prompt() -> tuple[str, str]:
    """The instructions (comments stripped) and the file's git blob hash."""
    raw = PROMPT_FILE.read_bytes()
    version = hashlib.sha1(b"blob %d\0" % len(raw) + raw).hexdigest()
    text = raw.decode("utf8")
    if text.startswith("<!--"):
        text = text.split("-->", 1)[1]
    return text.strip(), version


def _num(value, places: int) -> float | None:
    """A plain rounded float. Figures read from Postgres arrive as Decimal, which JSON cannot encode."""
    return round(float(value), places) if value is not None else None


def figures(result: JobRecommendation) -> dict:
    """What the model is allowed to see: numbers and model names, nothing else."""
    d = result.decision
    out = {
        "verdict": d.verdict,
        "current_model": d.current.model if d.current else None,
        "recommended_model": d.recommended.model if d.recommended else None,
        "models": [
            {"model": m.model, "status": m.status, "catalog_status": m.catalog_status,
             "pass_rate": _num(m.sample.pass_rate, 4) if m.sample else None,
             "pass_rate_range": [_num(m.pass_rate_low, 4), _num(m.pass_rate_high, 4)]
             if m.pass_rate_low is not None else None,
             "cost_per_success_usd": _num(m.cost_per_success_usd, 6) if m.cost_per_success_usd else None,
             "checked_runs": m.n_runs}
            for m in d.models
        ],
        "warnings": d.warnings,
    }
    if result.forecast:
        out["monthly_saving_usd"] = _num(result.forecast.monthly_saving_usd, 2)
        out["extra_failures_per_month"] = _num(result.forecast.extra_failures_per_month, 1)
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
    import openai

    client = openai.AsyncOpenAI(base_url=settings.summary_base_url, api_key=api_key(),
                                timeout=CALL_SECONDS, max_retries=0)
    # Two sentences of arithmetic already done: the least thinking the model allows, so the answer is
    # quick and the token budget is not spent before it is written.
    extra = {"reasoning_effort": settings.summary_effort} if settings.summary_effort else {}
    try:
        response = await client.chat.completions.create(
            model=settings.summary_model, max_tokens=MAX_TOKENS,
            messages=[{"role": "system", "content": instructions}, {"role": "user", "content": payload}],
            **extra,
        )
    except openai.RateLimitError:
        log.warning("summary unavailable: rate limited")
        return None
    except openai.APIStatusError as exc:  # 4xx/5xx: a wrong model name, a rejected parameter, an overloaded tier
        log.error("summary call rejected: HTTP %s %s", exc.status_code, exc.message,
                  extra={"request_id": getattr(exc, "request_id", None)})
        return None
    except openai.APIConnectionError as exc:  # includes timeouts
        log.warning("summary unavailable: %s", type(exc).__name__)
        return None
    finally:
        await client.close()
    choice = response.choices[0] if response.choices else None
    if choice is None or choice.finish_reason != "stop":
        log.warning("summary dropped: finish_reason %s", choice.finish_reason if choice else None)
        return None
    return (choice.message.content or "").strip() or None


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


async def _write(sessions: async_sessionmaker[AsyncSession], key: str, settings: Settings,
                 instructions: str, payload: str, recommended: str | None) -> str | None:
    """Ask for the summary and store it. Runs on past its request if it has to, so it uses its own session."""
    try:
        text = await asyncio.wait_for(_call(settings, instructions, payload), CALL_SECONDS + 1)
    except TimeoutError:
        log.warning("summary unavailable: no answer in %ss", CALL_SECONDS)
        return None
    except Exception:  # never let the optional summary break anything
        log.exception("summary call failed")
        return None
    if text is not None and recommended and recommended not in text:  # the figures win; drop the summary
        log.warning("summary dropped: it does not name the recommended model", extra={"recommended": recommended})
        text = None
    if text is None:
        return None
    try:
        async with sessions() as s:
            await s.execute(update(RecommendationSummary).where(RecommendationSummary.summary_key == key)
                            .values(summary=text))
            await s.commit()
    except Exception:
        log.exception("summary could not be stored")
        return None
    return text


async def summarize(session: AsyncSession, job: Job, result: JobRecommendation,
                    settings: Settings, *, now: datetime | None = None) -> tuple[str | None, str | None]:
    """(summary, prompt version), or (None, None) when off, failed, limited, not trustworthy, or still
    being written (it is shown from the next request on). Never raises: the summary is optional."""
    if not api_key() or result.decision.verdict == "INSUFFICIENT_EVIDENCE":
        return None, None
    try:
        return await _summarize(session, job, result, settings, now)
    except Exception:
        log.exception("summary skipped after an unexpected error")
        await session.rollback()
        return None, None


async def _summarize(session: AsyncSession, job: Job, result: JobRecommendation, settings: Settings,
                     now: datetime | None) -> tuple[str | None, str | None]:
    now = now or datetime.now(UTC)
    instructions, version = _prompt()
    payload = json.dumps(figures(result), sort_keys=True)  # before the claim, so a bad figure costs no attempt
    key = summary_key(job, result, settings, version)
    stored = await session.get(RecommendationSummary, key, populate_existing=True)
    if stored is not None and stored.summary is not None:
        return stored.summary, stored.prompt_version
    if not await _claim(session, key, job, version, settings, now):
        return None, None
    recommended = result.decision.recommended.model if result.decision.recommended else None
    sessions = async_sessionmaker(session.bind, expire_on_commit=False)
    task = asyncio.create_task(_write(sessions, key, settings, instructions, payload, recommended))
    _writing.add(task)
    task.add_done_callback(_writing.discard)
    try:
        text = await asyncio.wait_for(asyncio.shield(task), DEADLINE_SECONDS)
    except TimeoutError:
        log.info("summary still being written; it is shown from the next request")
        return None, None
    return (text, version) if text else (None, None)
