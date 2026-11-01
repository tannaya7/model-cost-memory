"""Run the staleness experiment and write its report (PRD US-007, technical plan 9).

  python scripts/staleness_experiment.py                      # embedded Postgres (needs pgserver)
  python scripts/staleness_experiment.py --seeds 5 --days 120 --database-url URL

Three set-ups, each over --seeds timelines: the drifting world with 30 and with 10 re-test runs per
model per day (what freshness costs), and a world where nothing changes (the control). Writes
reports/staleness_experiment.md (the tables) and .json (every checkpoint and daily answer).
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

SETUPS = (("drift", 30), ("drift", 10), ("stable", 30))  # (world, re-test runs per model per day)
METHODS = (("frozen", "Frozen"), ("rechecked", "Re-checked monthly"), ("maintained", "Maintained"))


async def evaluate(url: str, args: argparse.Namespace) -> dict:
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

    from agent_memory.config import normalize_database_url
    from agent_memory.simulation.staleness import experiment

    engine = create_async_engine(normalize_database_url(url))
    sessions = async_sessionmaker(engine, expire_on_commit=False)
    try:
        out = {}
        for world, retest in SETUPS:
            print(f"running {world} world, {retest} re-test runs per model per day ...", flush=True)
            out[(world, retest)] = await experiment(sessions, seeds=args.seeds, days=args.days, world=world,
                                                    retest_per_day=retest)
        return out
    finally:
        await engine.dispose()


def mean(values) -> float:
    values = list(values)
    return sum(values) / len(values) if values else 0.0


def right_answer_changes(world: str, seed: int, days: int) -> int:
    from agent_memory.config import get_settings
    from agent_memory.simulation.staleness import CURATION_DAYS, SCENARIOS
    from agent_memory.simulation.world import truth

    scenario, margin = SCENARIOS[world](seed, days=days), get_settings().tolerance_points
    answers = [truth(scenario, day, margin) for day in range(CURATION_DAYS, days)]
    return sum(a != b for a, b in zip(answers, answers[1:], strict=False))


def report(results: dict, args) -> str:
    from agent_memory.simulation.staleness import CURATION_DAYS, RECHECK_EVERY

    half = CURATION_DAYS + (args.days - CURATION_DAYS) // 2
    drift, drift_low, stable = results[("drift", 30)], results[("drift", 10)], results[("stable", 30)]
    acc = lambda rs, m, start=0: mean(r.accuracy(m, from_day=start) for r in rs)  # noqa: E731
    month = lambda usd: usd / args.days * 30  # noqa: E731
    seeds = len(drift)

    lines = [
        "# Staleness experiment",
        "",
        f"Over the whole timeline the maintained memory picked the right model {acc(drift, 'maintained'):.0%} of the "
        f"time, against {acc(drift, 'frozen'):.0%} for a frozen test set and {acc(drift, 'rechecked'):.0%} for one "
        f"re-checked every {RECHECK_EVERY} days. Keeping it fresh cost "
        f"{mean(r.retest_usd for r in drift) / mean(r.production_usd for r in drift):.0%} of production spend. "
        f"Where nothing changes, its answer changed {mean(r.changes() for r in stable):.1f} times per timeline.",
        "",
        f"{seeds} simulated timelines of {args.days} days per set-up. In the drifting world the share of long "
        "documents grows from 5% to 60%, so the cheap model stops being good enough, and a better version of the "
        "mid-priced model arrives on day 45. Every 7 days each answer is scored against the known right answer "
        "(the cheapest model within 3 points of the best true pass rate).",
        "",
        f"- **Frozen**: a curated test set of the first {CURATION_DAYS} days, judged once and never updated.",
        f"- **Re-checked monthly**: the same engine asked every {RECHECK_EVERY} days, its answer kept until the "
        "next check, the way a team re-runs its test set each month. It sees all the evidence at each check, so it "
        "is a generous baseline.",
        "- **Maintained**: this system's stored recommendation, kept current every day by decay, re-tests and "
        "consolidation.",
        "",
        "## Drifting world",
        "",
        "| | Accuracy, whole timeline | Accuracy, second half |",
        "|---|---|---|",
    ]
    for key, label in METHODS:
        lines.append(f"| {label} | {acc(drift, key):.0%} | {acc(drift, key, half):.0%} |")
    lines += [
        "",
        f"The right answer changes {mean(right_answer_changes('drift', r.seed, args.days) for r in drift):.1f} times "
        f"per timeline; the maintained answer changed {mean(r.changes() for r in drift):.1f} times "
        f"(range {min(r.changes() for r in drift)}-{max(r.changes() for r in drift)}).",
        "",
        f"### Accuracy at each checkpoint, mean of {seeds} timelines",
        "",
        "| Day | " + " | ".join(label for _, label in METHODS) + " |",
        "|---|" + "---|" * len(METHODS),
    ]
    for i, point in enumerate(drift[0].checkpoints):
        cells = [f"{mean(r.checkpoints[i].__dict__[key] == r.checkpoints[i].truth for r in drift):.0%}"
                 for key, _ in METHODS]
        lines.append(f"| {point.day} | " + " | ".join(cells) + " |")

    lines += [
        "",
        "## What freshness costs",
        "",
        "Re-test runs keep the evidence on the models not in production current. Spend is per 30 days at the "
        "simulated prices (production: 100 runs a day).",
        "",
        "| Re-test runs per model per day | Re-test spend | Production spend | Re-test share | Maintained accuracy, "
        "whole timeline |",
        "|---|---|---|---|---|",
    ]
    for retest, rs in ((30, drift), (10, drift_low)):
        r_usd, p_usd = mean(r.retest_usd for r in rs), mean(r.production_usd for r in rs)
        lines.append(f"| {retest} | ${month(r_usd):.2f} | ${month(p_usd):.2f} | {r_usd / p_usd:.0%} | "
                     f"{acc(rs, 'maintained'):.0%} |")

    lines += [
        "",
        "## Control: a world where nothing changes",
        "",
        "Same models, no drift, no new version: the right answer is the same every day.",
        "",
        "| | Accuracy, whole timeline | Answer changes per timeline |",
        "|---|---|---|",
        f"| Frozen | {acc(stable, 'frozen'):.0%} | 0 |",
        f"| Re-checked monthly | {acc(stable, 'rechecked'):.0%} | "
        f"{mean(sum(a.rechecked != b.rechecked for a, b in zip(r.checkpoints, r.checkpoints[1:], strict=False)) for r in stable):.1f} |",
        f"| Maintained | {acc(stable, 'maintained'):.0%} | {mean(r.changes() for r in stable):.1f} "
        f"(range {min(r.changes() for r in stable)}-{max(r.changes() for r in stable)}) |",
        "",
        "## Checkpoints, first drifting timeline",
        "",
        "| Day | Right answer | " + " | ".join(label for _, label in METHODS) + " |",
        "|---|---|" + "---|" * len(METHODS),
    ]
    for c in drift[0].checkpoints:
        mark = lambda x: f"{x} ✓" if x == c.truth else f"{x} ✗"  # noqa: E731
        lines.append(f"| {c.day} | {c.truth} | " + " | ".join(mark(getattr(c, key)) for key, _ in METHODS) + " |")
    lines += ["", "Reproduce with `python scripts/staleness_experiment.py --seeds 5`. Simulated data; the engine, "
              "decay, consolidation and regression code are the production code, run with simulated time.", ""]
    return "\n".join(lines)


def main(args: argparse.Namespace) -> int:
    from agent_memory.simulation.throwaway import ThrowawayDatabase

    with ThrowawayDatabase(args.database_url) as url:
        results = asyncio.run(evaluate(url, args))
    text = report(results, args)
    out = ROOT / "reports" / "staleness_experiment"
    out.parent.mkdir(exist_ok=True)
    out.with_suffix(".md").write_text(text, encoding="utf8")
    payload = {f"{world}-{retest}": [asdict(r) | {"changes": r.changes()} for r in rs]
               for (world, retest), rs in results.items()}
    out.with_suffix(".json").write_text(json.dumps(payload, indent=2) + "\n", encoding="utf8")
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")  # the table uses check marks
    print(text)
    return 0


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--database-url", help="a throwaway database (default: embedded Postgres)")
    parser.add_argument("--seeds", type=int, default=5)
    parser.add_argument("--days", type=int, default=120)
    sys.exit(main(parser.parse_args()))
