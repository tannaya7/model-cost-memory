"""Correct the model catalog by hand. A manual row is never changed by the daily sync.

  python scripts/catalog_override.py set local-llm:3b --provider ollama --price-in 0 --price-out 0
  python scripts/catalog_override.py set some-model --shutdown 2027-03-01      # a retirement the list lags on
  python scripts/catalog_override.py clear some-model                          # hand it back to the sync

Reads DATABASE_URL from the environment or from .env.
"""

from __future__ import annotations

import argparse
import asyncio
import sys
from datetime import date

from agent_memory.catalog.sync import clear_override, set_override
from agent_memory.config import load_dotenv_file
from agent_memory.db import dispose_engine, session_factory


async def main(args: argparse.Namespace) -> int:
    try:
        async with session_factory()() as session:
            if args.command == "clear":
                done = await clear_override(session, args.model, args.version)
                print("handed back to the sync" if done else "no manual row with that name")
                return 0 if done else 1
            row = await set_override(
                session, args.model, args.version, provider=args.provider, status=args.status,
                shutdown_date=date.fromisoformat(args.shutdown) if args.shutdown else None,
                price_in_per_mtok=args.price_in, price_out_per_mtok=args.price_out,
            )
            print(f"{row.model} ({row.model_version}): {row.provider}, {row.status}, shutdown {row.shutdown_date}, "
                  f"in {row.price_in_per_mtok} / out {row.price_out_per_mtok} per million tokens [manual]")
            return 0
    except ValueError as exc:
        print(f"Error: {exc}", file=sys.stderr)
        return 2
    finally:
        await dispose_engine()


if __name__ == "__main__":
    load_dotenv_file()
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    sub = parser.add_subparsers(dest="command", required=True)
    setp = sub.add_parser("set", help="create or correct a row")
    setp.add_argument("model")
    setp.add_argument("--version")
    setp.add_argument("--provider")
    setp.add_argument("--status", choices=["ACTIVE", "DEPRECATED", "RETIRED"])
    setp.add_argument("--shutdown", help="YYYY-MM-DD")
    setp.add_argument("--price-in", type=float, help="US dollars per million input tokens")
    setp.add_argument("--price-out", type=float, help="US dollars per million output tokens")
    clearp = sub.add_parser("clear", help="hand a manual row back to the sync")
    clearp.add_argument("model")
    clearp.add_argument("--version")
    sys.exit(asyncio.run(main(parser.parse_args())))
