"""Scheduler process: runs the maintenance jobs on a timer (APScheduler, one instance by design).

Today: the outbox janitor (every minute). Decay, consolidation, regression sweep, catalog sync,
re-tests and alert delivery join in Weeks 6-10.

Run it with:  python -m agent_memory.scheduler
"""

from __future__ import annotations

import asyncio
import logging

from apscheduler.schedulers.asyncio import AsyncIOScheduler
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from .config import Settings, get_settings, load_dotenv_file
from .pipeline.janitor import run_janitor

log = logging.getLogger("agent_memory.scheduler")


def build_scheduler(sessions: async_sessionmaker[AsyncSession], settings: Settings | None = None) -> AsyncIOScheduler:
    settings = settings or get_settings()
    scheduler = AsyncIOScheduler()
    scheduler.add_job(
        run_janitor, "interval", seconds=60, args=[sessions, settings], id="outbox-janitor",
        max_instances=1, coalesce=True, replace_existing=True,
    )
    return scheduler


async def _main() -> None:
    from .db import dispose_engine, session_factory

    load_dotenv_file()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
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
