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

**Opt-in, per project.** The figures (model names, pass rates, ranges, costs; never a prompt, an answer or run text) leave
the server only when the project's owner turned `ai_summary_consent` on. Without it nothing is sent and an earlier
summary is not shown either.

**The figures win.** The summary is generated interpretation, never a source of numbers. Before it is stored it is checked
against the figures it was given (`ungrounded`): a number that is not one of them (or a difference between two of them),
a model name that was not in them, money wording on a subscription project, a dollar figure without "list price" on a
mixed one, or a claim of cause or certainty drops the whole summary. The recommendation beside it is unchanged.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import os
import re
from datetime import UTC, datetime, timedelta
from pathlib import Path

from sqlalchemy import func, select, update
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from ..config import Settings
from ..models import Job, Project, RecommendationSummary
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


def summary_host() -> str | None:
    """Where the figures would go, for the consent screen; None when this server has no summary service at all."""
    if not api_key():
        return None
    from urllib.parse import urlparse

    from ..config import get_settings

    return urlparse(get_settings().summary_base_url).hostname or None


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


# What the summary writer is told about how the project pays, so money wording is stopped at the source and not
# only hidden afterwards on screen. "per_use" adds nothing: it is how every summary was written before.
MODE_NOTES = {
    "subscription": (
        "This project pays a flat subscription fee. Never mention dollars, money, cost, price, saving, a bill or a "
        "budget, and never describe a model as cheaper or more expensive. Talk only about correct answers, the "
        "models, the evidence and the risk. The figures contain no money."),
    "both": (
        "This project pays per use for some AI and with a subscription for the rest. Every dollar figure is a list "
        "price estimate: say 'at list prices' beside it, and never call it a bill or a saving that will be paid."),
}
_MONEY_WORDS = re.compile(r"\$|\b(sav\w*|cost\w*|bill\w*|spen[dt]\w*|budget\w*|pay|paid|price\w*|cheap\w*|expensive)\b", re.I)


_NUMBER = re.compile(r"(?<![\w.])\$?(\d[\d,]*(?:\.\d+)?)")
_MODEL_LIKE = re.compile(r"[A-Za-z][\w.]*-[\w.-]*\d[\w.-]*")  # gpt-5-mini, claude-3-5: a name with a hyphen and a digit
_CAUSE_OR_CERTAINTY = re.compile(
    r"\b(because of|caused by|due to|as a result of|guarantee\w*|certain(?:ly)?|definitely|always|never fail\w*|"
    r"will (?:save|cut|reduce)|you will (?:save|pay)|proves?|proven to)\b", re.I)
_FREE_INTEGERS = {0, 1, 2, 3}  # "two sentences", "one in three": counts of words, not metrics


def _numbers_in(value, out: list[float]) -> None:
    if isinstance(value, bool) or value is None:
        return
    if isinstance(value, (int, float)):
        out.append(float(value))
    elif isinstance(value, dict):
        for v in value.values():
            _numbers_in(v, out)
    elif isinstance(value, list):
        for v in value:
            _numbers_in(v, out)


def _allowed_numbers(figs: dict) -> list[float]:
    """Every number the writer may repeat: each figure, a rate as a percentage, and the gap between any two rates."""
    base: list[float] = []
    _numbers_in(figs, base)
    allowed = list(base)
    rates = [r for r in base if 0 <= r <= 1]
    allowed += [r * 100 for r in rates]
    allowed += [abs(a - b) * 100 for a in rates for b in rates]
    return allowed


def _within(x: float, a: float, decimals: int) -> bool:
    """Is `x`, written to `decimals` places, a correct rounding of the real figure `a`? 96.76 may be written 97, 96.8 or
    96.76. A figure under a dime (a price per call) is written to two significant figures, so it may be off by up to
    5%. Anything else is a different number."""
    if a >= 1:
        return abs(x - a) <= 0.5 * 10 ** (-decimals) + 1e-9
    if a >= 0.1:
        return abs(x - a) <= max(0.005, 0.5 * 10 ** (-decimals)) + 1e-9
    return abs(x - a) <= max(0.0005, abs(a) * 0.05)


def _matches(x: float, allowed: list[float], decimals: int) -> bool:
    return any(_within(x, a, decimals) for a in allowed)


def ungrounded(text: str, figs: dict, mode: str = "per_use") -> str | None:
    """Why this generated text may not be shown, or None when it stays inside the figures it was given. It cannot make
    a number, a model, a cause or a promise of its own."""
    names = {m["model"] for m in figs.get("models", [])}
    names |= {figs.get(k) for k in ("current_model", "recommended_model") if figs.get(k)}
    plain = text
    for n in sorted(names, key=len, reverse=True):  # digits inside a model's name are not metrics
        plain = plain.replace(n, " ")
    for found in _MODEL_LIKE.findall(plain):
        if found.lower().strip(".,;:") not in {n.lower() for n in names}:
            return f"names a model that was not in the figures: {found}"
    allowed = _allowed_numbers(figs)
    for raw in _NUMBER.findall(plain):
        value = float(raw.replace(",", ""))
        if value in _FREE_INTEGERS and "." not in raw:
            continue
        decimals = len(raw.split(".")[1]) if "." in raw else 0
        if not _matches(value, allowed, decimals):
            return f"states a number that is not in the figures: {raw}"
    if _CAUSE_OR_CERTAINTY.search(text):
        return "claims a cause or a certainty the figures cannot support"
    if mode == "subscription" and _MONEY_WORDS.search(text):
        return "mentions money on a subscription project"
    if mode == "both" and "$" in text and "list price" not in text.lower():
        return "gives a dollar figure without saying it is a list price"
    return None


def figures(result: JobRecommendation, mode: str = "per_use") -> dict:
    """What the model is allowed to see: numbers and model names, nothing else. On a subscription no money
    figure and no warning that talks about money is passed, so none can be repeated."""
    money = mode != "subscription"
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
             **({"cost_per_success_usd": _num(m.cost_per_success_usd, 6) if m.cost_per_success_usd else None}
                if money else {}),
             "checked_runs": m.n_runs}
            for m in d.models
        ],
        "warnings": d.warnings if money else [w for w in d.warnings if not _MONEY_WORDS.search(w)],
        # The rule the verdict follows, so the writer can state it without inventing it.
        "rules": {"margin_points": _num(result.settings.tolerance_points * 100, 1),
                  "confidence_percent": _num(result.settings.confidence_level * 100, 1)},
    }
    if mode != "per_use":
        out["billing"] = "flat subscription" if mode == "subscription" else "per use and subscription"
    if result.forecast:
        if money:
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


def summary_key(job: Job, result: JobRecommendation, settings: Settings, prompt_version: str,
                mode: str = "per_use") -> str:
    parts = [str(job.job_id), settings.summary_model, prompt_version, verdict_identity(result)]
    if mode != "per_use":  # a per-use key is unchanged, so no stored summary is lost; the other modes get their own
        parts.append(mode)
    identity = json.dumps(parts, sort_keys=True)
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
                 instructions: str, payload: str, recommended: str | None, mode: str = "per_use") -> str | None:
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
    if text is not None:
        reason = ungrounded(text, json.loads(payload), mode)
        if reason:  # the figures win; the recommendation is shown without a summary
            log.warning("summary dropped: it %s", reason)
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
    project = await session.get(Project, job.project_id)
    if project is None or not project.ai_summary_consent:  # nothing is sent, and no earlier summary is shown
        return None, None
    mode = project.billing_mode if project is not None and project.billing_mode in MODE_NOTES else "per_use"
    if mode in MODE_NOTES:
        instructions = f"{instructions}\n\n{MODE_NOTES[mode]}"
    payload = json.dumps(figures(result, mode), sort_keys=True)  # before the claim, so a bad figure costs no attempt
    key = summary_key(job, result, settings, version, mode)
    stored = await session.get(RecommendationSummary, key, populate_existing=True)
    if stored is not None and stored.summary is not None:
        return stored.summary, stored.prompt_version
    if not await _claim(session, key, job, version, settings, now):
        return None, None
    recommended = result.decision.recommended.model if result.decision.recommended else None
    sessions = async_sessionmaker(session.bind, expire_on_commit=False)
    task = asyncio.create_task(_write(sessions, key, settings, instructions, payload, recommended, mode))
    _writing.add(task)
    task.add_done_callback(_writing.discard)
    try:
        text = await asyncio.wait_for(asyncio.shield(task), DEADLINE_SECONDS)
    except TimeoutError:
        log.info("summary still being written; it is shown from the next request")
        return None, None
    return (text, version) if text else (None, None)
