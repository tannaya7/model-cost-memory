"""Scheduler process: runs the maintenance jobs on a timer (APScheduler, one instance by design).

  outbox-janitor   every minute   hands back stuck outbox rows, purges old finished ones
  decay            every hour     rescoring runs and archiving the ones that have faded
  consolidation    every 15 min   stores each changed verdict, superseding the previous one
  regression       every 15 min   version regressions and silent drops; raises alerts
  alert-delivery   every minute   posts due alerts to project webhooks, with backoff
  retests          every 30 s     runs queued re-tests (budget and monthly cap checked before each call)
  retest-unsure    every hour     queues a re-test when the engine is unsure about a cheaper model
  catalog-sync     daily + at start   refreshes model prices, statuses and shutdown dates; alerts
                                  for recommended models that were deprecated or retired, and
                                  re-tests for new models cheaper than what a job uses now

Run it with:  python -m agent_memory.scheduler
"""

from __future__ import annotations

import asyncio
import logging
from datetime import UTC, datetime

import httpx
from apscheduler.schedulers.asyncio import AsyncIOScheduler
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from .alerts.notifier import deliver_pending
from .alerts.service import catalog_alerts
from .catalog.sync import fetch_price_list, sync_catalog
from .config import Settings, get_settings, load_dotenv_file
from .logging_config import configure_logging
from .pipeline.consolidation import consolidate_all
from .pipeline.decay import recompute
from .pipeline.janitor import run_janitor
from .pipeline.regression import sweep_all
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
    scheduler.add_job(run_janitor, "interval", seconds=60, args=[sessions, settings], id="outbox-janitor", **common)
    scheduler.add_job(run_decay, "interval", hours=1, args=[sessions, settings], id="decay", **common)
    scheduler.add_job(
        run_consolidation, "interval", minutes=15, args=[sessions, settings], id="consolidation", **common
    )
    scheduler.add_job(
        run_regression_sweep, "interval", minutes=15, args=[sessions, settings], id="regression", **common
    )
    scheduler.add_job(
        run_alert_delivery, "interval", seconds=60, args=[sessions, settings], id="alert-delivery", **common
    )
    scheduler.add_job(run_retests, "interval", seconds=30, args=[sessions, settings], id="retests", **common)
    scheduler.add_job(
        run_retest_unsure, "interval", hours=1, args=[sessions, settings], id="retest-unsure", **common
    )
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
