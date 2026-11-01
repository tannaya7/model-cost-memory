"""Fill a demo project with 90 days of simulated history, ending today.

  python scripts/seed_demo.py --database-url URL                 # project "demo"
  python scripts/seed_demo.py --database-url URL --project-id public-demo --days 90

Two jobs, both clearly described as simulated:
  invoice-extract   workload drift and a new model version: the recommendation changes over time
  receipt-scan      a provider upgrade that quietly lowers the pass rate: a regression alert

The runs go through the real decay, consolidation and regression code with simulated time, so every
screen (recommendation, evidence, history, alerts, spend, breakdowns) has something real to show
without spending anything on a model. Prints the project key once. Set DEMO_PROJECT_ID to the
project id to let anyone read it without signing in.
"""

from __future__ import annotations

import argparse
import asyncio
import sys
from datetime import UTC, datetime, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))


async def seed(url: str, project_id: str, days: int) -> str:
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

    from agent_memory.config import normalize_database_url
    from agent_memory.models import Project
    from agent_memory.projects import create_project
    from agent_memory.simulation.harness import Simulator
    from agent_memory.simulation.staleness import drift_scenario
    from agent_memory.simulation.world import Scenario, SimModel, Version

    engine = create_async_engine(normalize_database_url(url))
    sessions = async_sessionmaker(engine, expire_on_commit=False)
    start = (datetime.now(UTC) - timedelta(days=days)).replace(hour=0, minute=0, second=0, microsecond=0)
    try:
        async with sessions() as session:
            if await session.get(Project, project_id) is not None:
                raise SystemExit(f"Project '{project_id}' already exists; choose another --project-id")
            _, key = await create_project(session, project_id, name="Demo (simulated data)")

        drift = drift_scenario(seed=7, days=days, runs_per_day=60, retest_per_day=20)
        receipts = Scenario(
            job="receipt-scan", production="acme-large", days=days, runs_per_day=40, retest_per_day=0, seed=11,
            models=(SimModel("acme-large", 0.02, (
                Version("acme-large-2026-01-01", 0, 0.97, 0.95),
                Version("acme-large-2026-04-01", days - 20, 0.86, 0.84),  # the quiet regression
            )),),
        )
        for scenario, description in (
            (drift, "Simulated: invoice totals; long documents become more common and a better mid-priced "
                    "model version arrives"),
            (receipts, "Simulated: receipt totals; the provider's latest version quietly passes less often"),
        ):
            async with sessions() as session:
                sim = Simulator(session, scenario, project_id=project_id, start=start)
                await sim.setup(description=description)
                for day in range(scenario.days):
                    await sim.day(day)
                print(f"  {scenario.job}: {scenario.days} days simulated")
        return key
    finally:
        await engine.dispose()


def main(args: argparse.Namespace) -> int:
    from agent_memory.simulation.throwaway import migrate

    migrate(args.database_url)
    key = asyncio.run(seed(args.database_url, args.project_id, args.days))
    print(f"Project:  {args.project_id}")
    print(f"API key:  {key}")
    print(f"To show it publicly without sign-in: DEMO_PROJECT_ID={args.project_id}")
    return 0


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--database-url", required=True, help="the database to seed (it is migrated first)")
    parser.add_argument("--project-id", default="demo")
    parser.add_argument("--days", type=int, default=90)
    sys.exit(main(parser.parse_args()))
