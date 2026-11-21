"""Operator script: delete a project and everything recorded under it. It cannot be undone.

  python scripts/delete_project.py my-company --yes

For an erasure request, or a project created with create_project.py (which has no owner to delete it
from the web app). Removes jobs, runs with their prompts and answers, re-tests, recommendations, alerts,
the stored provider key and usage limits, then the project; its key stops working at once.
Reads DATABASE_URL from the environment or from .env.
"""

from __future__ import annotations

import argparse
import asyncio
import sys

from agent_memory.config import load_dotenv_file
from agent_memory.db import dispose_engine, session_factory
from agent_memory.retention import delete_project, remaining_rows


async def main(args: argparse.Namespace) -> int:
    try:
        async with session_factory()() as session:
            before = await remaining_rows(session, args.project_id)
            if not before["projects"]:
                print(f"There is no project named '{args.project_id}'.", file=sys.stderr)
                return 1
            print(f"Project '{args.project_id}': {before['jobs']} jobs, {before['runs']} runs, "
                  f"{before['retests']} re-tests.")
            if not args.yes:
                print("Nothing deleted. Run again with --yes to delete it all.")
                return 2
            await delete_project(session, args.project_id)
            await session.commit()
            left = {table: n for table, n in (await remaining_rows(session, args.project_id)).items() if n}
    finally:
        await dispose_engine()
    if left:
        print(f"Some rows remain: {left}", file=sys.stderr)
        return 3
    print("Deleted. Nothing referring to the project remains.")
    return 0


if __name__ == "__main__":
    load_dotenv_file()
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("project_id")
    parser.add_argument("--yes", action="store_true", help="really delete (without it, only counts are shown)")
    sys.exit(asyncio.run(main(parser.parse_args())))
