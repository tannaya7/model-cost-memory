"""Run the staleness experiment and write its report (PRD US-007, technical plan 9).

  python scripts/staleness_experiment.py                      # embedded Postgres (needs pgserver)
  python scripts/staleness_experiment.py --seeds 5 --days 120 --database-url URL

Writes reports/staleness_experiment.md (the table and the headline number) and .json (every checkpoint).
Never point it at a database that holds real data: every seed writes its own simulated project.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
from dataclasses import asdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
ROOT = Path(__file__).resolve().parents[1]


async def evaluate(url: str, args: argparse.Namespace):
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

    from agent_memory.config import normalize_database_url
    from agent_memory.simulation.staleness import experiment

    engine = create_async_engine(normalize_database_url(url))
    try:
        return await experiment(async_sessionmaker(engine, expire_on_commit=False), seeds=args.seeds, days=args.days)
    finally:
        await engine.dispose()


def report(results, args) -> str:
    from agent_memory.simulation.staleness import CURATION_DAYS

    half = CURATION_DAYS + (args.days - CURATION_DAYS) // 2
    mean = lambda which, start=0: sum(r.accuracy(which, from_day=start) for r in results) / len(results)  # noqa: E731
    lines = [
        "# Staleness experiment",
        "",
        f"{len(results)} simulated timelines of {args.days} days. Workload drifts from 5% to 60% long documents; a",
        "new version of the mid-priced model arrives on day 45. Every 7 days both evidence sets are asked for a",
        "recommendation and scored against the known right answer (the cheapest model within 3 points of the best",
        "true pass rate).",
        "",
        f"- **Frozen**: a curated evaluation set of the first {CURATION_DAYS} days, judged once and never updated.",
        "- **Maintained**: this system's stored recommendation, kept current by decay, re-tests and consolidation.",
        "",
        "| | Accuracy, whole timeline | Accuracy, second half |",
        "|---|---|---|",
        f"| Frozen | {mean('frozen'):.0%} | {mean('frozen', half):.0%} |",
        f"| Maintained | {mean('maintained'):.0%} | {mean('maintained', half):.0%} |",
        "",
        f"**Headline:** in the second half of the timeline the maintained memory picked the right model "
        f"{mean('maintained', half):.0%} of the time, the frozen set {mean('frozen', half):.0%}.",
        "",
        "## Checkpoints (first timeline)",
        "",
        "| Day | Right answer | Frozen | Maintained |",
        "|---|---|---|---|",
    ]
    for c in results[0].checkpoints:
        mark = lambda x: f"{x} ✓" if x == c.truth else f"{x} ✗"  # noqa: E731
        lines.append(f"| {c.day} | {c.truth} | {mark(c.frozen)} | {mark(c.maintained)} |")
    lines += ["", "Reproduce with `python scripts/staleness_experiment.py`. Simulated data; the engine, decay,",
              "consolidation and regression code are the production code, run with simulated time.", ""]
    return "\n".join(lines)


def main(args: argparse.Namespace) -> int:
    from agent_memory.simulation.throwaway import ThrowawayDatabase

    with ThrowawayDatabase(args.database_url) as url:
        results = asyncio.run(evaluate(url, args))
    text = report(results, args)
    out = ROOT / "reports" / "staleness_experiment"
    out.parent.mkdir(exist_ok=True)
    out.with_suffix(".md").write_text(text, encoding="utf8")
    out.with_suffix(".json").write_text(json.dumps([asdict(r) for r in results], indent=2) + "\n", encoding="utf8")
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")  # the table uses check marks
    print(text)
    return 0


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--database-url", help="a throwaway database (default: embedded Postgres)")
    parser.add_argument("--seeds", type=int, default=3)
    parser.add_argument("--days", type=int, default=120)
    sys.exit(main(parser.parse_args()))
