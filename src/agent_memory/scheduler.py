"""Scheduler process: runs the maintenance jobs on a timer (APScheduler, one instance by design).

  outbox-janitor   every minute   hands back stuck outbox rows, purges old finished ones
  decay            every hour     rescoring runs and archiving the ones that have faded
  consolidation    every 15 min   stores each changed verdict, superseding the previous one
  regression       every 15 min   version regressions and silent drops; raises alerts
  alert-delivery   every minute   posts due alerts to project webhooks, with backoff
  retests          every 30 s     runs queued re-tests (budget and monthly cap checked before each call)
  retest-unsure    every hour     queues a re-test when the engine is unsure about a cheaper model
  catalog-sync     daily, and once directly at start   refreshes prices, statuses and shutdown dates; alerts
                                  for recommended models that were deprecated or retired, and
                                  re-tests for new models cheaper than what a job uses now
  news             every hour     fetches the AI news feeds (news/); the web app can ask sooner
  retention        daily          clears the prompt, answer, tool calls and answer key of runs older
                                  than their project's retention (retention.py)

Every job leaves a heartbeat (heartbeat.py): GET /healthz/scheduler answers 503 when one is overdue,
and OPERATOR_WEBHOOK_URL, when set, hears about each failure.

Only one scheduler runs jobs at a time: it holds a Postgres advisory lock (become_leader); a second
one waits as a standby.

Run it with:  python -m agent_memory.scheduler
"""

from __future__ import annotations

import asyncio
import logging
from datetime import UTC, datetime

import httpx
from apscheduler.schedulers.asyncio import AsyncIOScheduler
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncConnection, AsyncEngine, AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.pool import NullPool

from .alerts.notifier import deliver_pending
from .alerts.service import catalog_alerts
from .catalog.sync import fetch_price_list, sync_catalog
from .config import Settings, check_startup, get_settings, load_dotenv_file, normalize_database_url
from .heartbeat import LEADER, record, tracked
from .logging_config import configure_logging
from .pipeline.consolidation import consolidate_all
from .pipeline.decay import recompute
from .pipeline.janitor import run_janitor
from .pipeline.regression import sweep_all
from .news.service import refresh as news_refresh
from .retention import clear_old_content
from .retest.runner import run_queued, start_for_new_models, start_when_unsure

log = logging.getLogger("agent_memory.scheduler")


async def run_decay(sessions: async_sessionmaker[AsyncSession], settings: Settings | None = None) -> None:
    async with sessions() as session:
        await recompute(session, settings=settings or get_settings())


async def run_consolidation(sessions: async_sessionmaker[AsyncSession], settings: Settings | None = None) -> None:
    async with sessions() as session:
        await consolidate_all(session, settings=settings or get_settings())


async def run_regression_sweep(sessions: async_sessionmaker[AsyncSession], settings: Settings | None = None) -> None:
    async with sessions() as session:
        await sweep_all(session, settings=settings or get_settings())


async def run_alert_delivery(sessions: async_sessionmaker[AsyncSession], settings: Settings | None = None) -> None:
    async with sessions() as session:
        await deliver_pending(session)


async def run_retests(sessions: async_sessionmaker[AsyncSession], settings: Settings | None = None) -> None:
    await run_queued(sessions, settings=settings or get_settings())


async def run_retest_unsure(sessions: async_sessionmaker[AsyncSession], settings: Settings | None = None) -> None:
    async with sessions() as session:
        await start_when_unsure(session, settings=settings or get_settings())


async def run_retention(sessions: async_sessionmaker[AsyncSession], settings: Settings | None = None) -> int:
    async with sessions() as session:
        return await clear_old_content(session)


async def run_news(sessions: async_sessionmaker[AsyncSession], settings: Settings | None = None) -> bool:
    return (await news_refresh(sessions)).refreshed  # False only when every feed failed


async def run_catalog_sync(
    sessions: async_sessionmaker[AsyncSession],
    settings: Settings | None = None,
    *,
    transport: httpx.AsyncBaseTransport | None = None,
) -> bool:
    """Refresh the catalog. If the public list cannot be fetched the last known statuses are kept."""
    settings = settings or get_settings()
    try:
        data = await fetch_price_list(settings.catalog_source_url, transport=transport)
    except (httpx.HTTPError, ValueError) as exc:
        log.warning("catalog sync skipped: could not fetch the price list (%s); keeping the last known statuses", exc)
        return False
    async with sessions() as session:
        result = await sync_catalog(session, data)
        if result.status_changes:
            await catalog_alerts(session, result.status_changes, now=datetime.now(UTC))
            await session.commit()
        if result.added_models:
            await start_for_new_models(session, result.added_models, settings=settings)
    return True


def build_scheduler(sessions: async_sessionmaker[AsyncSession], settings: Settings | None = None) -> AsyncIOScheduler:
    settings = settings or get_settings()
    scheduler = AsyncIOScheduler()
    common = {"max_instances": 1, "coalesce": True, "replace_existing": True}
    jobs = [
        (run_janitor, {"seconds": 60}, "outbox-janitor"),
        (run_decay, {"hours": 1}, "decay"),
        (run_consolidation, {"minutes": 15}, "consolidation"),
        (run_regression_sweep, {"minutes": 15}, "regression"),
        (run_alert_delivery, {"seconds": 60}, "alert-delivery"),
        (run_retests, {"seconds": 30}, "retests"),
        (run_retest_unsure, {"hours": 1}, "retest-unsure"),
        (run_news, {"hours": 1}, "news"),
    ]
    for fn, every, job_id in jobs:
        scheduler.add_job(tracked(job_id, fn), "interval", **every, args=[sessions, settings], id=job_id, **common)
    scheduler.add_job(tracked("catalog-sync", run_catalog_sync), "cron", hour=3, minute=30,
                      args=[sessions, settings], id="catalog-sync", **common)
    scheduler.add_job(tracked("retention", run_retention), "cron", hour=4, minute=0,
                      args=[sessions, settings], id="retention", **common)
    return scheduler


LEADER_LOCK = "mcm:scheduler"
STANDBY_CHECK_SECONDS = 30


async def become_leader(engine: AsyncEngine, *, wait: bool = True) -> AsyncConnection | None:
    """Take the scheduler lock: a Postgres advisory lock held on its own connection for the life of the
    process. Only the holder runs jobs, so a second scheduler started by mistake can never double a
    re-test's spend. A standby checks every STANDBY_CHECK_SECONDS and takes over if the leader dies (its
    connection drops and Postgres releases the lock). Returns the connection holding the lock, or None
    when `wait` is False and another process holds it."""
    while True:
        conn = await engine.connect()
        got = (await conn.execute(text("SELECT pg_try_advisory_lock(hashtext(:k))"), {"k": LEADER_LOCK})).scalar()
        if got:
            await conn.commit()  # keep the connection idle; the lock belongs to the session, not a transaction
            return conn
        await conn.close()
        if not wait:
            return None
        log.info("another scheduler is running; standing by")
        await asyncio.sleep(STANDBY_CHECK_SECONDS)


async def _main() -> None:
    from .db import dispose_engine, session_factory

    load_dotenv_file()
    configure_logging()
    settings = get_settings()
    check_startup(settings)  # the scheduler makes the outbound calls, so it refuses unsafe settings too
    lock_engine = create_async_engine(normalize_database_url(settings.database_url), poolclass=NullPool)
    leader = await become_leader(lock_engine)
    sessions = session_factory()
    await record(sessions, LEADER)  # overdue checks count from now, not from a previous leader's last run
    # Prices first, called directly: as a one-off scheduled job it could be dropped as a misfire if
    # start-up took a moment, leaving a fresh server without prices.
    await tracked("catalog-sync", run_catalog_sync)(sessions, settings)
    scheduler = build_scheduler(sessions, settings)
    scheduler.start()
    log.info("scheduler started with jobs: %s", [j.id for j in scheduler.get_jobs()])
    try:
        await asyncio.Event().wait()  # run until interrupted
    finally:
        scheduler.shutdown(wait=False)
        await leader.close()
        await lock_engine.dispose()
        await dispose_engine()


if __name__ == "__main__":
    try:
        asyncio.run(_main())
    except KeyboardInterrupt:
        pass
