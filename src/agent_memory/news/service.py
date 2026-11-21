"""Refreshing the news, and listing it for a project with the stories that mention its models marked.

A refresh fetches every feed at once; one feed failing does not stop the others, and only a refresh in
which every feed failed counts as a failure. It records a heartbeat named "news" (heartbeat.py), which is
both "updated N minutes ago" in the web app and the check that stops refreshes closer than
MIN_REFRESH_GAP apart, however many people press the button.

"Affects your models": a story mentions a model when the model's name, split into words and numbers,
appears in the title or summary in the same order. So `gemini-3.5-flash` matches "Gemini 3.5 Flash", and
`claude-haiku-5-5` matches "Claude Haiku 5.5"; a bare "Gemini" does not, so the mark stays specific.
"""

from __future__ import annotations

import asyncio
import logging
import re
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta

import httpx
from sqlalchemy import delete, select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from ..heartbeat import record
from ..models import NewsItem, Run, SchedulerHeartbeat
from .feeds import FEEDS, TIMEOUT_SECONDS, USER_AGENT, Feed, Item, fetch

log = logging.getLogger("agent_memory.news")

JOB = "news"
KEEP_DAYS = 30
MIN_REFRESH_GAP = timedelta(minutes=10)
MODELS_WINDOW = timedelta(days=90)  # a project's models are those it ran in this window
SCAN_LIMIT = 500  # newest items considered when listing


@dataclass
class RefreshResult:
    added: int = 0
    failed: list[str] = field(default_factory=list)
    refreshed: bool = True


async def refresh(sessions: async_sessionmaker[AsyncSession], *, feeds: tuple[Feed, ...] = FEEDS,
                  transport: httpx.AsyncBaseTransport | None = None, now: datetime | None = None) -> RefreshResult:
    now = now or datetime.now(UTC)
    result = RefreshResult()
    async with httpx.AsyncClient(timeout=TIMEOUT_SECONDS, transport=transport, follow_redirects=True,
                                 headers={"User-Agent": USER_AGENT}) as client:
        outcomes = await asyncio.gather(*(fetch(client, f, now=now) for f in feeds), return_exceptions=True)
    items: list[Item] = []
    for feed, outcome in zip(feeds, outcomes, strict=True):
        if isinstance(outcome, BaseException):
            log.warning("news feed failed", extra={"source": feed.source, "error": f"{type(outcome).__name__}: {outcome}"[:200]})
            result.failed.append(feed.source)
        else:
            items.extend(outcome)
    async with sessions() as session:
        if items:
            unique = {i.item_id: i for i in items}.values()
            inserted = await session.execute(
                insert(NewsItem).values([
                    dict(item_id=i.item_id, source=i.source, kind=i.kind, title=i.title, link=i.link,
                         summary=i.summary, published_at=i.published_at, fetched_at=now) for i in unique
                ]).on_conflict_do_nothing(index_elements=["item_id"]).returning(NewsItem.item_id)
            )
            result.added = len(inserted.all())
        await session.execute(delete(NewsItem).where(NewsItem.published_at < now - timedelta(days=KEEP_DAYS)))
        await session.commit()
    if len(result.failed) == len(feeds):
        await record(sessions, JOB, error="every news feed failed", now=now)
        result.refreshed = False
    else:
        await record(sessions, JOB, now=now)
    log.info("news refreshed", extra={"added": result.added, "failed": result.failed})
    return result


async def last_refreshed(session: AsyncSession) -> datetime | None:
    return (await session.execute(
        select(SchedulerHeartbeat.last_ok_at).where(SchedulerHeartbeat.job == JOB))).scalar_one_or_none()


def _words(value: str) -> list[str]:
    return re.findall(r"[a-z]+|\d+", value.lower())


def mentions(text: str, model: str) -> bool:
    """Does `text` name `model`: its words and numbers, consecutive and in order?"""
    want, have = _words(model), _words(text)
    if len(want) < 2:  # a one-word name ("llama") is too broad to mark a story
        return False
    return any(have[i:i + len(want)] == want for i in range(len(have) - len(want) + 1))


async def project_models(session: AsyncSession, project_id: str, *, job_id=None,
                         now: datetime | None = None) -> list[str]:
    """Models the project (or one of its jobs) ran in the last MODELS_WINDOW."""
    since = (now or datetime.now(UTC)) - MODELS_WINDOW
    query = select(Run.model).where(Run.project_id == project_id, Run.created_at >= since).distinct()
    if job_id is not None:
        query = query.where(Run.job_id == job_id)
    return sorted({m for (m,) in await session.execute(query)})


@dataclass
class Listed:
    item: NewsItem
    affects: list[str]


async def list_news(session: AsyncSession, project_id: str, *, source: str | None = None, mine: bool = False,
                    model: str | None = None, job_id=None, since: datetime | None = None,
                    until: datetime | None = None, limit: int = 60,
                    now: datetime | None = None) -> tuple[list[Listed], list[str]]:
    """The newest items, each with the watched models it mentions; and the watched models.

    The watched models are the project's (the default), one job's (`job_id`), or a single `model`, as an
    alert asks about. Asking about a job or a model returns only the stories that name it. `since` and
    `until` keep to a window, e.g. around when an alert was raised."""
    if model:
        models = [model]
    else:
        models = await project_models(session, project_id, job_id=job_id, now=now)
    if model or job_id is not None:
        mine = True
    query = select(NewsItem).order_by(NewsItem.published_at.desc()).limit(SCAN_LIMIT)
    if source:
        query = query.where(NewsItem.source == source)
    if since:
        query = query.where(NewsItem.published_at >= since)
    if until:
        query = query.where(NewsItem.published_at <= until)
    out: list[Listed] = []
    for item in (await session.execute(query)).scalars():
        text = f"{item.title} {item.summary}"
        affects = [m for m in models if mentions(text, m)]
        if mine and not affects:
            continue
        out.append(Listed(item, affects))
        if len(out) >= limit:
            break
    return out, models
