"""The optional, opt-in AI summary of what a task does (migration 0019).

Off unless BOTH the server has a summary key (the same rule and client as the recommendation summary) AND
the project switched it on (projects.task_summary_consent). It reads 3 to 5 of the task's stored sample
calls (text that already exists; retention may have removed it), sanitises them, and asks the small model
for two sentences. The result is stored under a fingerprint of the samples, so it is written again only
when the samples change. It shares the daily call limit with the recommendation summary.

Never in the way: it returns a state ("ready", "pending", "off", "unavailable", "no_samples", "deleted")
and never raises. A failed call is retried after RETRY_AFTER.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import re
from datetime import UTC, datetime
from pathlib import Path
from urllib.parse import urlparse

from sqlalchemy import func, select, update
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from ..config import Settings
from ..models import Job, Project, RecommendationSummary, Run, TaskSummary
from .summary import CALL_SECONDS, DEADLINE_SECONDS, RETRY_AFTER, _call, api_key

log = logging.getLogger("agent_memory.task_summary")
_writing: set[asyncio.Task] = set()

PROMPT_FILE = Path(__file__).resolve().parents[1] / "prompts" / "task_summary.md"
MIN_SAMPLES = 3
MAX_SAMPLES = 5
SAMPLE_CHARS = 600  # per prompt and per answer
SCAN_ROWS = 200
DELETED = "deleted"  # prompt_version of a row the user deleted: not written again until the samples change

_EMAIL = re.compile(r"[\w.+-]+@[\w-]+(?:\.[\w-]+)+")
_URL = re.compile(r"https?://\S+|www\.\S+")
_SECRET = re.compile(r"\b(?:sk|pk|key|token|ghp|xox[a-z])[-_][A-Za-z0-9_-]{8,}\b|\b[A-Za-z0-9_-]{32,}\b")
_NUMBER = re.compile(r"\+?\d[\d\s().-]{6,}\d")


def sanitize(text: str) -> str:
    """Replace emails, links, secret-looking tokens and long numbers (phones, cards, ids) with placeholders,
    then cut to SAMPLE_CHARS. Names and free text cannot be recognised; the user is told that."""
    text = _EMAIL.sub("[email]", text)
    text = _URL.sub("[link]", text)
    text = _SECRET.sub("[secret]", text)
    text = _NUMBER.sub("[number]", text)
    return " ".join(text.split())[:SAMPLE_CHARS]


def provider_name(settings: Settings) -> str:
    """The host the samples go to, for the consent text."""
    return urlparse(settings.summary_base_url).hostname or settings.summary_base_url


def _prompt() -> tuple[str, str]:
    raw = PROMPT_FILE.read_bytes()
    version = hashlib.sha1(b"blob %d\0" % len(raw) + raw).hexdigest()
    text = raw.decode("utf8")
    if text.startswith("<!--"):
        text = text.split("-->", 1)[1]
    return text.strip(), version


async def pick_samples(session: AsyncSession, job: Job) -> list[tuple[str, str, str]]:
    """Up to MAX_SAMPLES (prompt hash, prompt, answer): the oldest calls whose text is still stored, one per
    distinct prompt. Oldest first so the choice stays put until retention removes it."""
    rows = (await session.execute(
        select(Run.prompt_hash, Run.prompt, Run.output)
        .where(Run.job_id == job.job_id, Run.project_id == job.project_id, Run.run_kind == "PRODUCTION",
               Run.content_removed_at.is_(None), Run.prompt.is_not(None))
        .order_by(Run.created_at, Run.run_id).limit(SCAN_ROWS))).all()
    seen: set[str] = set()
    out: list[tuple[str, str, str]] = []
    for h, prompt, output in rows:
        if h in seen or not prompt.strip():
            continue
        seen.add(h)
        out.append((h, prompt, output or ""))
        if len(out) == MAX_SAMPLES:
            break
    return out


def fingerprint(samples: list[tuple[str, str, str]], settings: Settings, version: str) -> str:
    ident = json.dumps([sorted(h for h, _, _ in samples), settings.summary_model, version])
    return hashlib.sha256(ident.encode()).hexdigest()


async def _claim(session: AsyncSession, job: Job, fp: str, version: str, settings: Settings, now: datetime) -> bool:
    """Reserve the call, within the daily limit. False when another request holds it, it failed too
    recently, or today's calls are used up."""
    day = now.replace(hour=0, minute=0, second=0, microsecond=0)
    used = (await session.execute(select(func.coalesce(func.sum(RecommendationSummary.attempts), 0))
                                  .where(RecommendationSummary.attempted_at >= day))).scalar_one()
    used += (await session.execute(select(func.coalesce(func.sum(TaskSummary.attempts), 0))
                                   .where(TaskSummary.attempted_at >= day))).scalar_one()
    if used >= settings.summary_daily_limit:
        log.info("task summary skipped: daily limit reached")
        return False
    stmt = insert(TaskSummary).values(job_id=job.job_id, fingerprint=fp, prompt_version=version, attempts=1,
                                      attempted_at=now)
    stmt = stmt.on_conflict_do_update(
        index_elements=["job_id"],
        set_={"fingerprint": fp, "summary": None, "prompt_version": version, "attempts": 1, "attempted_at": now},
        where=(TaskSummary.fingerprint != fp)
        | (TaskSummary.summary.is_(None) & (TaskSummary.prompt_version != DELETED)
           & (TaskSummary.attempted_at < now - RETRY_AFTER)),
    ).returning(TaskSummary.job_id)
    won = (await session.execute(stmt)).scalar_one_or_none() is not None
    await session.commit()
    return won


async def _write(sessions: async_sessionmaker[AsyncSession], job_id, fp: str, settings: Settings,
                 instructions: str, payload: str) -> str | None:
    try:
        text = await asyncio.wait_for(_call(settings, instructions, payload), CALL_SECONDS + 1)
    except Exception:
        log.warning("task summary call failed", exc_info=True)
        return None
    if not text:
        return None
    try:
        async with sessions() as s:
            await s.execute(update(TaskSummary).where(TaskSummary.job_id == job_id, TaskSummary.fingerprint == fp)
                            .values(summary=text))
            await s.commit()
    except Exception:
        log.exception("task summary could not be stored")
        return None
    return text


async def task_summary_state(session: AsyncSession, project: Project, job: Job, settings: Settings,
                             *, now: datetime | None = None) -> tuple[str, str | None]:
    """(state, text). Never raises."""
    if not api_key():
        return "unavailable", None
    if not project.task_summary_consent:
        return "off", None
    try:
        return await _state(session, job, settings, now or datetime.now(UTC))
    except Exception:
        log.exception("task summary skipped after an unexpected error")
        await session.rollback()
        return "unavailable", None


async def _state(session: AsyncSession, job: Job, settings: Settings, now: datetime) -> tuple[str, str | None]:
    instructions, version = _prompt()
    samples = await pick_samples(session, job)
    if len(samples) < MIN_SAMPLES:
        return "no_samples", None
    fp = fingerprint(samples, settings, version)
    stored = await session.get(TaskSummary, job.job_id, populate_existing=True)
    same = stored is not None and stored.fingerprint == fp
    if same and stored.summary:
        return "ready", stored.summary
    if same and stored.prompt_version == DELETED:
        return "deleted", None
    payload = json.dumps({"samples": [{"prompt": sanitize(p), "answer": sanitize(o)} for _, p, o in samples]})
    if not await _claim(session, job, fp, version, settings, now):
        # another request is writing it (a fresh, empty row) or a limit stopped us
        waiting = same and stored.attempted_at > now - RETRY_AFTER
        return ("pending" if waiting else "unavailable"), None
    sessions = async_sessionmaker(session.bind, expire_on_commit=False)
    task = asyncio.create_task(_write(sessions, job.job_id, fp, settings, instructions, payload))
    _writing.add(task)
    task.add_done_callback(_writing.discard)
    try:
        text = await asyncio.wait_for(asyncio.shield(task), DEADLINE_SECONDS)
    except TimeoutError:
        return "pending", None
    return ("ready", text) if text else ("unavailable", None)


async def delete_summary(session: AsyncSession, job: Job) -> None:
    """Remove the stored text. A marker stays so the same samples are not summarised again; the caller commits."""
    await session.execute(update(TaskSummary).where(TaskSummary.job_id == job.job_id)
                          .values(summary=None, prompt_version=DELETED))
