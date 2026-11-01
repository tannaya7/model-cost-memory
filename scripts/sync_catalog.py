"""Refresh the model catalog now (the scheduler also does this daily).

  python scripts/sync_catalog.py                      # fetch the public price list
  python scripts/sync_catalog.py --file prices.json   # use a saved copy, no network

Reads DATABASE_URL from the environment or from .env.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
from pathlib import Path

from agent_memory.catalog.sync import fetch_price_list, sync_catalog
from agent_memory.config import load_dotenv_file
from agent_memory.db import dispose_engine, session_factory


async def main(args: argparse.Namespace) -> int:
    data = json.loads(Path(args.file).read_text(encoding="utf8")) if args.file else await fetch_price_list(args.url)
    try:
        async with session_factory()() as session:
            result = await sync_catalog(session, data)
    finally:
        await dispose_engine()
    print(f"{result.added} added, {result.updated} updated, {result.unchanged} unchanged, "
          f"{result.skipped_manual} manual rows left alone")
    for model, old, new in result.status_changes:
        print(f"  status change: {model}: {old} -> {new}")
    return 0


if __name__ == "__main__":
    load_dotenv_file()
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--url", help="price list URL (default: CATALOG_SOURCE_URL)")
    parser.add_argument("--file", help="read the price list from this JSON file instead")
    sys.exit(asyncio.run(main(parser.parse_args())))
