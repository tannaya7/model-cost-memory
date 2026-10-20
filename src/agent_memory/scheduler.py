"""Scheduler process: runs the maintenance jobs on a timer (APScheduler, one instance by design).

  outbox-janitor   every minute   hands back stuck outbox rows, purges old finished ones
  decay            every hour     rescoring runs and archiving the ones that have faded
  catalog-sync     daily + at start   refreshes model prices, statuses and shutdown dates

Consolidation, the regression sweep, re-tests and alert delivery join in Weeks 8-10.

Run it with:  python -m agent_memory.scheduler
"""

from __future__ import annotations

import asyncio
import logging
from datetime import UTC, datetime

import httpx
from apscheduler.schedulers.asyncio import AsyncIOScheduler
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from .catalog.sync import fetch_price_list, sync_catalog
from .config import Settings, get_settings, load_dotenv_file
from .logging_config import configure_logging
from .pipeline.decay import recompute
from .pipeline.janitor import run_janitor

log = logging.getLogger("agent_memory.scheduler")


async def run_decay(sessions: async_sessionmaker[AsyncSession], settings: Settings | None = None) -> None:
    async with sessions() as session:
        await recompute(session, settings=settings or get_settings())


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
        await sync_catalog(session, data)
    return True


def build_scheduler(sessions: async_sessionmaker[AsyncSession], settings: Settings | None = None) -> AsyncIOScheduler:
    settings = settings or get_settings()
    scheduler = AsyncIOScheduler()
    common = {"max_instances": 1, "coalesce": True, "replace_existing": True}
    scheduler.add_job(run_janitor, "interval", seconds=60, args=[sessions, settings], id="outbox-janitor", **common)
    scheduler.add_job(run_decay, "interval", hours=1, args=[sessions, settings], id="decay", **common)
    scheduler.add_job(
        run_catalog_sync, "cron", hour=3, minute=30, args=[sessions, settings], id="catalog-sync", **common
    )
    scheduler.add_job(  # and once at start, so a fresh server has prices straight away
        run_catalog_sync, "date", run_date=datetime.now(UTC), args=[sessions, settings], id="catalog-sync-startup"
    )
    return scheduler


async def _main() -> None:
    from .db import dispose_engine, session_factory

    load_dotenv_file()
    configure_logging()
    scheduler = build_scheduler(session_factory())
    scheduler.start()
    log.info("scheduler started with jobs: %s", [j.id for j in scheduler.get_jobs()])
    try:
        await asyncio.Event().wait()  # run until interrupted
    finally:
        scheduler.shutdown(wait=False)
        await dispose_engine()


if __name__ == "__main__":
    try:
        asyncio.run(_main())
    except KeyboardInterrupt:
        pass
