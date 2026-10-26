"""Measure regression detection on the simulated-time harness (technical plan 9).

  python scripts/simulate.py                       # embedded Postgres in a temp folder (needs pgserver)
  python scripts/simulate.py --database-url URL    # an existing, throwaway database
  python scripts/simulate.py --trials 20 --kind SILENT_DROP --out reports/silent_drop.json

For each injected drop (0 is the control) it runs N independent trials and prints the detection rate
and the median days to detect; the control's rate is the false-positive rate. Every trial writes its
own simulated project, so never point this at a database that holds real data.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import statistics
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))


async def evaluate(url: str, args: argparse.Namespace):
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

    from agent_memory.config import normalize_database_url
    from agent_memory.simulation.evaluation import detection

    engine = create_async_engine(normalize_database_url(url))
    try:
        return await detection(
            async_sessionmaker(engine, expire_on_commit=False), drops=tuple(args.drops), trials=args.trials,
            kind=args.kind, runs_per_day=args.runs_per_day,
        )
    finally:
        await engine.dispose()


def main(args: argparse.Namespace) -> int:
    from agent_memory.simulation.throwaway import ThrowawayDatabase

    with ThrowawayDatabase(args.database_url) as url:
        results = asyncio.run(evaluate(url, args))

    print(f"{args.kind}: {args.trials} trials per drop, {args.runs_per_day} runs a day")
    print(f"{'drop':>7}  {'flagged':>8}  {'rate':>6}  {'median days to detect':>22}")
    rows = []
    for r in results:
        median = statistics.median(r.days_to_detect) if r.days_to_detect else None
        label = "control" if r.drop == 0 else f"{r.drop:.0%}"
        print(f"{label:>7}  {r.flagged:>3}/{r.trials:<4}  {r.rate:>6.0%}  {median if median is not None else '-':>22}")
        rows.append({"drop": r.drop, "trials": r.trials, "flagged": r.flagged, "rate": r.rate,
                     "days_to_detect": r.days_to_detect})
    if args.out:
        Path(args.out).parent.mkdir(parents=True, exist_ok=True)
        Path(args.out).write_text(json.dumps({"kind": args.kind, "runs_per_day": args.runs_per_day,
                                              "results": rows}, indent=2) + "\n", encoding="utf8")
        print("wrote", args.out)
    return 0


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--database-url", help="a throwaway database (default: embedded Postgres)")
    parser.add_argument("--kind", choices=["VERSION_REGRESSION", "SILENT_DROP"], default="VERSION_REGRESSION")
    parser.add_argument("--trials", type=int, default=10)
    parser.add_argument("--drops", type=float, nargs="+", default=[0.0, 0.05, 0.10, 0.15])
    parser.add_argument("--runs-per-day", type=int, default=50)
    parser.add_argument("--out", help="also write the results as JSON")
    sys.exit(main(parser.parse_args()))
