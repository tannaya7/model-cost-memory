"""Model notices from the providers' own pages: read them, keep what they say with a checked-at date and an exact
link, and tell a project about the notices that concern models it actually uses.

What this guarantees:
  - A notice comes only from a provider's own deprecation page (SOURCES), never from a third-party list, and it
    carries the date it was checked and a link to the section of the page that holds it.
  - It is worded the way that provider words it ("not sooner than", "earliest possible", "scheduled"). We never turn a
    provider's earliest-possible or tentative date into a promise.
  - It is raised only for a model the project ran in the last 30 days, matched by exact model id.
  - Where the calls are served matters: a notice about a provider's own API is applied to calls that name that provider,
    or that name none (said so in the text). Calls that name another host (a cloud partner, a router) get no alert,
    because the partner sets its own dates.
  - A source that has never been read, or cannot be read, raises nothing. A source last read over 7 days ago still
    informs, and says how old its reading is.
  - Notices are information. Nothing is migrated, replaced or switched, and they leave the app only if the owner
    opted in (projects.notice_alert_webhook).
"""

from __future__ import annotations

import logging
from collections import defaultdict
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from datetime import UTC, date, datetime, timedelta
from urllib.parse import urlsplit

import httpx
from sqlalchemy import func, select, update
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from ..alerts.service import raise_alert
from ..insights.projection import zone
from ..models import Alert, Job, ModelNotice, NoticeSource, Project, Run
from ..options import split_option
from ..versions import normalize
from . import parse

log = logging.getLogger("agent_memory.notices")

RECENT_USE_DAYS = 30  # a model counts as "in use" if a production call named it this recently
ALERT_WITHIN_DAYS = 60  # a tentative or earliest-possible date alerts once it is this near (our choice)
STALE_AFTER = timedelta(days=7)  # a reading older than this is flagged as old
MAX_BYTES = 3_000_000
FETCH_TIMEOUT = 20.0


@dataclass(frozen=True)
class SourceDef:
    source_id: str
    name: str
    provider: str  # whose own platform the page speaks for
    url: str
    parse: Callable[[str], list[parse.ParsedNotice]]
    first_party: frozenset[str]  # provider names a call records when it is served by that platform itself
    covers: str  # what the page says about other platforms


SOURCES: tuple[SourceDef, ...] = (
    SourceDef("anthropic", "Anthropic: Model deprecations", "anthropic",
              "https://platform.claude.com/docs/en/about-claude/model-deprecations", parse.parse_anthropic,
              frozenset({"anthropic"}),
              "Applies to Anthropic-operated platforms. Amazon Bedrock and Google-managed Google Cloud set their own "
              "retirement schedules, so their dates can differ."),
    SourceDef("google", "Google: Gemini deprecations", "google", "https://aistudio.google.com/docs/deprecations",
              parse.parse_google, frozenset({"gemini", "google"}),
              "Applies to the Gemini API. Dates are the earliest possible shutdown dates; other platforms are not covered."),
    SourceDef("openai", "OpenAI: Deprecations", "openai", "https://developers.openai.com/api/docs/deprecations",
              parse.parse_openai, frozenset({"openai"}),
              "Applies to the OpenAI API. Partner platforms are not covered."),
)
BY_ID = {s.source_id: s for s in SOURCES}
PROVIDER_NAMES = {"anthropic": "Anthropic", "google": "Google", "openai": "OpenAI"}

Fetcher = Callable[[str], Awaitable[str]]


async def default_fetch(url: str) -> str:
    """The page as markdown. Only the fixed addresses in SOURCES are ever requested, over https; nothing about any
    project is sent. The three providers answer a request for `text/markdown` with their docs page in markdown."""
    parts = urlsplit(url)
    if parts.scheme != "https" or parts.hostname not in {urlsplit(s.url).hostname for s in SOURCES}:
        raise ValueError("not an official notice address")
    async with httpx.AsyncClient(timeout=FETCH_TIMEOUT, follow_redirects=True, max_redirects=3) as client:
        response = await client.get(url, headers={"Accept": "text/markdown", "User-Agent": "model-cost-memory-notice-check"})
        response.raise_for_status()
        if len(response.content) > MAX_BYTES:
            raise ValueError("the page is larger than expected")
        return response.text


def notice_url(source: SourceDef, anchor: str | None) -> str:
    """The exact section of the provider's page that holds the notice."""
    return f"{source.url}#{anchor}" if anchor else source.url


# ---------------------------------------------------------------- reading the pages

async def sync_sources(
    session: AsyncSession, *, now: datetime | None = None, fetch: Fetcher | None = None,
    sources: tuple[SourceDef, ...] = SOURCES,
) -> dict[str, str]:
    """Read each source and store what it says. Returns {source_id: status}. A failed or unreadable reading keeps the
    notices from the last good one and records why; it never empties them."""
    now = now or datetime.now(UTC)
    fetch = fetch or default_fetch
    result: dict[str, str] = {}
    for source in sources:
        await session.execute(
            insert(NoticeSource).values(source_id=source.source_id, name=source.name, provider=source.provider, url=source.url)
            .on_conflict_do_update(index_elements=["source_id"], set_={"name": source.name, "url": source.url}))
        try:
            text = await fetch(source.url)
        except Exception as exc:  # noqa: BLE001 - any failure is recorded, never raised into the scheduler
            log.warning("notice source %s could not be read: %s", source.source_id, exc)
            await _record(session, source, "FETCH_FAILED", now, detail=f"{type(exc).__name__}: {str(exc)[:200]}")
            result[source.source_id] = "FETCH_FAILED"
            continue
        try:
            found = source.parse(text)
        except Exception as exc:  # noqa: BLE001
            log.warning("notice source %s did not parse: %s", source.source_id, exc)
            found = []
        if not found:
            await _record(session, source, "UNREADABLE", now, detail="The page was fetched but no model notices could be "
                                                                     "read from it. Its layout may have changed.")
            result[source.source_id] = "UNREADABLE"
            continue
        stored = {(r.model, r.status, r.notice_date): r for r in (await session.execute(
            select(ModelNotice).where(ModelNotice.source_id == source.source_id))).scalars()}
        for row in stored.values():
            row.listed = False  # listed again below if this reading still shows it
        seen: set[tuple] = set()
        for n in found:
            key = (n.model, n.status, n.date)
            if key in seen:
                continue  # the same row twice on a page is one notice
            seen.add(key)
            row = stored.get(key)
            if row is None:
                session.add(ModelNotice(
                    source_id=source.source_id, provider=source.provider, model=n.model, status=n.status,
                    notice_date=n.date, wording=n.wording, deprecated_on=n.deprecated_on, replacement=n.replacement,
                    section=n.section, notice_url=notice_url(source, n.anchor), listed=True, first_seen_at=now,
                    last_seen_at=now, checked_at=now))
            else:
                row.wording, row.deprecated_on, row.replacement = n.wording, n.deprecated_on, n.replacement
                row.section, row.notice_url = n.section, notice_url(source, n.anchor)
                row.listed, row.last_seen_at, row.checked_at = True, now, now
        await session.flush()
        await _record(session, source, "OK", now, detail=None, count=len(seen))
        result[source.source_id] = "OK"
    await session.commit()
    return result


async def _record(session: AsyncSession, source: SourceDef, status: str, now: datetime, *, detail: str | None,
                  count: int | None = None) -> None:
    values: dict = {"status": status, "last_checked_at": now, "detail": detail}
    if status == "OK":
        values["last_ok_at"] = now
        values["notice_count"] = count or 0
    await session.execute(update(NoticeSource).where(NoticeSource.source_id == source.source_id).values(**values))


# ---------------------------------------------------------------- wording

def _day(d: date) -> str:
    return f"{d.day} {d:%b %Y}"


def describe(n: ModelNotice, today: date) -> str:
    """One sentence in the provider's own terms. A tentative or earliest-possible date is never worded as a promise."""
    who = PROVIDER_NAMES.get(n.provider, n.provider.title())
    d = n.notice_date
    if n.status in ("Retired", "Shutdown") and d:
        verb = "retired" if n.status == "Retired" else "shut down"
        return f"{who} lists {n.model} as {verb} on {_day(d)}."
    if d is None:
        return f"{who} lists {n.model} as {n.status.lower()} and has not given a retirement date."
    if n.wording == parse.EARLIEST_POSSIBLE:
        if d < today:
            return (f"{who}'s earliest possible shutdown date for {n.model} ({_day(d)}) has passed. {who} says it will give "
                    "advance notice of the exact date, so check its page for whether the model is still served.")
        return (f"{who} lists {_day(d)} as the earliest possible shutdown date for {n.model}, and says it will give "
                "advance notice of the exact date.")
    if n.wording == parse.NOT_SOONER_THAN:
        return f"{who} lists {n.model} as retiring not sooner than {_day(d)}."
    if n.wording == parse.TENTATIVE:
        past = " That date has passed." if d < today else ""
        return f"{who} lists a tentative retirement date of {_day(d)} for {n.model}.{past}"
    return f"{who} lists {n.model} to shut down on {_day(d)}." if d >= today else f"{who} lists {n.model} as shut down on {_day(d)}."


def worth_telling(n: ModelNotice, today: date) -> bool:
    """A provider that has announced a deprecation, retirement or shutdown is always worth telling once. A tentative or
    earliest-possible date on a model that is otherwise active is told only when it is near."""
    if n.status in ("Deprecated", "Retired", "Shutdown"):
        return True
    return n.notice_date is not None and n.notice_date <= today + timedelta(days=ALERT_WITHIN_DAYS)


def source_age_note(source: NoticeSource, now: datetime) -> str | None:
    if source.last_ok_at is None:
        return None
    age = now - source.last_ok_at
    return f"This source was last read {age.days} days ago." if age > STALE_AFTER else None


# ---------------------------------------------------------------- who uses what

@dataclass
class Use:
    project_id: str
    model: str  # as the app named it
    names: tuple[str, ...]  # the exact ids it matches: the model and its resolved version, normalised
    provider: str | None
    calls: int
    top_job_id: object


async def _uses(session: AsyncSession, now: datetime, project_id: str | None = None) -> list[Use]:
    q = (select(Run.project_id, Run.job_id, Run.model, Run.model_version, Run.provider, func.count())
         .where(Run.run_kind == "PRODUCTION", Run.created_at >= now - timedelta(days=RECENT_USE_DAYS), Run.created_at <= now)
         .group_by(Run.project_id, Run.job_id, Run.model, Run.model_version, Run.provider))
    if project_id is not None:
        q = q.where(Run.project_id == project_id)
    by: dict[tuple, dict] = defaultdict(lambda: {"calls": 0, "jobs": defaultdict(int)})
    for pid, job_id, model, version, provider, n in (await session.execute(q)).all():
        names = tuple(dict.fromkeys(normalize(split_option(x)[0]) for x in (version, model) if x))
        e = by[(pid, names, (provider or "").lower() or None)]
        e["calls"] += n
        e["jobs"][job_id] += n
        e.setdefault("model", split_option(model)[0])
    return [Use(pid, e["model"], names, provider, e["calls"], max(e["jobs"], key=e["jobs"].get))
            for (pid, names, provider), e in by.items()]


def applies_to(source: SourceDef, run_provider: str | None) -> str:
    """"yes" when the call names this platform, "unknown" when it names none, "no" when it names another host."""
    if run_provider is None:
        return "unknown"
    return "yes" if run_provider in source.first_party else "no"


# ---------------------------------------------------------------- telling projects

async def check_notices(session: AsyncSession, *, now: datetime | None = None) -> list[Alert]:
    """MODEL_NOTICE for each (project, model, notice) the provider's own page announces for a model the project uses.
    Raised once per notice (a changed date or status is a new notice). Information only."""
    now = now or datetime.now(UTC)
    sources = {s.source_id: s for s in (await session.execute(select(NoticeSource))).scalars()}
    usable = {sid for sid, s in sources.items() if s.last_ok_at is not None and sid in BY_ID}  # never read: raises nothing
    if not usable:
        return []
    notices = (await session.execute(
        select(ModelNotice).where(ModelNotice.listed.is_(True), ModelNotice.source_id.in_(usable)))).scalars().all()
    by_model: dict[str, list[ModelNotice]] = defaultdict(list)
    for n in notices:
        by_model[n.model].append(n)
    tz_of: dict[str, object] = {}
    raised: list[Alert] = []
    for use in await _uses(session, now):
        for name in use.names:
            for n in by_model.get(name, []):
                source = BY_ID[n.source_id]
                where = applies_to(source, use.provider)
                if where == "no":
                    continue  # served by another host: that host sets its own dates
                project = await session.get(Project, use.project_id)
                tz = tz_of.setdefault(use.project_id, zone(project.budget_timezone if project else None))
                today = now.astimezone(tz).date()
                if not worth_telling(n, today):
                    continue
                key = f"MODEL_NOTICE|{n.source_id}|{n.model}|{n.status}|{n.notice_date}"
                if await _already(session, use.project_id, key):
                    continue
                job = await session.get(Job, use.top_job_id)
                src = sources[n.source_id]
                tail = [f"Checked {_day(src.last_ok_at)} on {source.name}: {n.notice_url}."]
                if n.replacement:
                    tail.append(f"The provider lists {n.replacement} as its suggested replacement. We change nothing.")
                tail.append("This is information only: no model is switched or replaced for you.")
                if where == "unknown":
                    tail.append("We could not tell where your calls are served. If you use a partner platform, its dates may differ.")
                age = source_age_note(src, now)
                if age:
                    tail.append(age)
                summary = f"{describe(n, today)} Your AI task {job.name} ran it in the last {RECENT_USE_DAYS} days. " + " ".join(tail)
                alert = await raise_alert(
                    session, job, "MODEL_NOTICE", key,
                    {"model": n.model, "provider": n.provider, "status": n.status,
                     "date": n.notice_date.isoformat() if n.notice_date else None, "date_wording": n.wording,
                     "source": source.name, "notice_url": n.notice_url, "checked_at": src.last_ok_at.isoformat(),
                     "served_by_known": where == "yes", "replacement_listed": n.replacement,
                     "informational": True, "summary": summary}, now=now)
                if alert:
                    raised.append(alert)
    await session.commit()
    return raised


async def _already(session: AsyncSession, project_id: str, key: str) -> bool:
    """Was this notice already raised for the project, resolved or not?"""
    q = (select(Alert.alert_id).join(Job, Job.job_id == Alert.job_id)
         .where(Job.project_id == project_id, Alert.kind == "MODEL_NOTICE", Alert.dedupe_key == key).limit(1))
    return (await session.execute(q)).first() is not None


@dataclass
class ProjectNotice:
    notice: ModelNotice
    text: str
    served_by_known: bool
    stale_note: str | None


async def project_notices(session: AsyncSession, project: Project, *, now: datetime | None = None
                          ) -> tuple[list[ProjectNotice], list[ModelNotice], list[NoticeSource]]:
    """For the settings page: notices about models this project uses (applicable), notices that exist but are not
    applied because the project's calls name another host, and the state of each source."""
    now = now or datetime.now(UTC)
    today = now.astimezone(zone(project.budget_timezone)).date()
    sources = {s.source_id: s for s in (await session.execute(select(NoticeSource))).scalars()}
    notices = (await session.execute(select(ModelNotice).where(ModelNotice.listed.is_(True)))).scalars().all()
    by_model: dict[str, list[ModelNotice]] = defaultdict(list)
    for n in notices:
        if n.source_id in sources and sources[n.source_id].last_ok_at is not None:
            by_model[n.model].append(n)
    shown: list[ProjectNotice] = []
    elsewhere: list[ModelNotice] = []
    seen: set = set()
    for use in await _uses(session, now, project.project_id):
        for name in use.names:
            for n in by_model.get(name, []):
                if (n.notice_id, use.provider) in seen:
                    continue
                seen.add((n.notice_id, use.provider))
                where = applies_to(BY_ID[n.source_id], use.provider)
                if where == "no":
                    elsewhere.append(n)
                else:
                    shown.append(ProjectNotice(n, describe(n, today), where == "yes", source_age_note(sources[n.source_id], now)))
    shown.sort(key=lambda p: (p.notice.notice_date is None, p.notice.notice_date or date.max))
    ordered = [sources[s.source_id] if s.source_id in sources else NoticeSource(source_id=s.source_id, name=s.name, provider=s.provider, url=s.url, status="NEVER", notice_count=0)
               for s in SOURCES]
    return shown, elsewhere, ordered
