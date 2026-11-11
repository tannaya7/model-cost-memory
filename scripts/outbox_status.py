"""Is the sync worker healthy? One query over the outbox.

  python scripts/outbox_status.py        # prints the counts; exits 1 if the outbox is not healthy

Healthy means: no failed rows, none stuck in PROCESSING, and nothing waiting for more than five minutes.
Reads DATABASE_URL from the environment or from .env, so it can be used as a cron or monitoring check.
"""

from __future__ import annotations

import asyncio
import sys

from agent_memory.config import get_settings, load_dotenv_file
from agent_memory.db import dispose_engine, session_factory
from agent_memory.pipeline.janitor import outbox_health


async def main() -> int:
    try:
        async with session_factory()() as session:
            health = await outbox_health(session, stuck_minutes=get_settings().outbox_stuck_minutes)
    finally:
        await dispose_engine()
    oldest = "none waiting" if health.oldest_pending_seconds is None else f"{health.oldest_pending_seconds:.0f}s"
    print(f"pending {health.pending} · processing {health.processing} · done {health.done} · failed {health.failed}")
    print(f"stuck {health.stuck} · oldest waiting: {oldest} · most retries on a live row: {health.max_retry_count}")
    print("HEALTHY" if health.healthy else "NOT HEALTHY")
    return 0 if health.healthy else 1


if __name__ == "__main__":
    load_dotenv_file()
    sys.exit(asyncio.run(main()))
