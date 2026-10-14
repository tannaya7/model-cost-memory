"""Operator script: create a project and print its API key once (only the hash is stored).

  python scripts/create_project.py my-company
  python scripts/create_project.py my-company --webhook https://hooks.example.com/abc --cap 10

Reads DATABASE_URL from the environment or from .env.
"""

from __future__ import annotations

import argparse
import asyncio
import sys

from agent_memory.config import load_dotenv_file
from agent_memory.db import dispose_engine, session_factory
from agent_memory.projects import ProjectExists, create_project


async def main(args: argparse.Namespace) -> int:
    try:
        async with session_factory()() as session:
            project, key = await create_project(
                session, args.project_id, webhook_url=args.webhook, retest_monthly_cap_usd=args.cap
            )
    except ProjectExists:
        print(f"A project named '{args.project_id}' already exists.", file=sys.stderr)
        return 1
    except ValueError as exc:
        print(f"Error: {exc}", file=sys.stderr)
        return 2
    finally:
        await dispose_engine()
    print(f"Project:  {project.project_id}")
    print(f"API key:  {key}")
    print("Copy the key now. It is not stored and cannot be shown again.")
    return 0


if __name__ == "__main__":
    load_dotenv_file()
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("project_id", help="3-40 characters: lowercase letters, digits and hyphens")
    parser.add_argument("--webhook", help="URL that receives regression alerts")
    parser.add_argument("--cap", type=float, default=10, help="monthly re-test spending cap in USD (default 10)")
    sys.exit(asyncio.run(main(parser.parse_args())))
