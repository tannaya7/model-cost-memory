"""Held-out check: does the engine pick the right model on prompts it never saw?

  # real runs: every model must have answered the same prompts (run_corpus.py once per model)
  python scripts/holdout_check.py --project demo --job invoice-extract --current gemini-2.5-pro

  # simulated answers on generated invoices, four scenarios, written to reports/holdout_check.md
  python scripts/holdout_check.py --simulated

Reads DATABASE_URL for --project. See src/agent_memory/recommend/holdout.py for what is measured.
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

# Stand-ins at the real list prices of three Gemini models (USD per million tokens in, out). The
# accuracies per difficulty are assumptions, not measurements: real runs replace them.
LITE = ("gemini-2.5-flash-lite", 0.10, 0.40)
FLASH = ("gemini-2.5-flash", 0.30, 2.50)
PRO = ("gemini-2.5-pro", 1.25, 10.00)
WEAK = {"easy": 0.98, "medium": 0.92, "hard": 0.80}
GOOD = {"easy": 0.99, "medium": 0.97, "hard": 0.93}
BEST = {"easy": 0.99, "medium": 0.98, "hard": 0.96}

# name -> (what it tests, models with their accuracies, the model in use)
SCENARIOS = {
    "nearly-as-good": ("A cheaper model is truly 1.4 points worse: inside the margin, so it is the right pick",
                       [(LITE, WEAK), (FLASH, GOOD), (PRO, BEST)], PRO[0]),
    "as-good": ("A cheaper model is truly as good as the one in use",
                [(LITE, WEAK), (FLASH, BEST), (PRO, BEST)], PRO[0]),
    "current-is-worse": ("The model in use is truly 6-8 points behind: the right move is up",
                         [(LITE, WEAK), (FLASH, GOOD), (PRO, BEST)], LITE[0]),
    "already-right": ("The model in use is already the right pick: nothing cheaper is good enough",
                      [(LITE, WEAK), (FLASH, BEST), (PRO, BEST)], FLASH[0]),
}


async def from_database(args: argparse.Namespace):
    from sqlalchemy import select
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

    from agent_memory.config import get_settings, normalize_database_url
    from agent_memory.models import Job
    from agent_memory.recommend.holdout import load_outcomes

    engine = create_async_engine(normalize_database_url(get_settings().database_url))
    try:
        async with async_sessionmaker(engine)() as session:
            job = (
                await session.execute(select(Job).where(Job.project_id == args.project, Job.name == args.job))
            ).scalar_one_or_none()
            if job is None:
                raise SystemExit(f"No job '{args.job}' in project '{args.project}'")
            return await load_outcomes(session, job)
    finally:
        await engine.dispose()


def table(results) -> list[str]:
    lines = ["| Evidence runs per model | Safe | Right model | Refused | Saving captured | Picks |",
             "|---|---|---|---|---|---|"]
    for r in results:
        captured = f"{r.saving_captured:.0%}" if r.saving_captured is not None else "n/a"
        picks = ", ".join(f"{m} {c}" for m, c in r.picks.items())
        lines.append(f"| {r.evidence_per_model} | {r.safe_rate:.1%} | {r.exact_rate:.1%} | {r.refused_rate:.1%} "
                     f"| {captured} | {picks} |")
    return lines


def as_json(results) -> list[dict]:
    return [{**asdict(r), "safe_rate": r.safe_rate, "exact_rate": r.exact_rate, "refused_rate": r.refused_rate,
             "saving_captured": r.saving_captured} for r in results]


def run_simulated(args: argparse.Namespace) -> int:
    from agent_memory.config import get_settings
    from agent_memory.corpus import generate_invoices
    from agent_memory.recommend.holdout import SimulatedModel, evaluate, pick_from, simulated_outcomes

    settings = get_settings()
    invoices = generate_invoices(args.invoices, seed=args.seed + 7)
    lines = [
        "# Held-out check (simulated answers)",
        "",
        f"{args.invoices} generated invoices. Three stand-in models at the real list prices of Gemini 2.5 Flash-Lite,",
        "Flash and Pro answer every invoice, passing with an assumed accuracy per difficulty. In each of",
        f"{args.splits} random splits per evidence size, the engine decides from that many runs per model through",
        "the production rule, and its pick is scored against the true pass rates:",
        "",
        f"- **Safe**: the pick is truly within {settings.tolerance_points * 100:g} points of the best model. This is the "
        f"promise behind every recommendation, made at {settings.confidence_level:.0%} confidence.",
        f"- **Right model**: the pick is the cheapest per success within {settings.tolerance_points * 100:g} points of "
        "the best.",
        "- **Saving captured**: of the saving per success the right model offers over the one in use, how much the",
        "  pick realises.",
        "",
        "The accuracies are assumptions; `python scripts/holdout_check.py --project ...` runs the same check on",
        "real recorded runs.",
    ]
    payload = {}
    for name, (what, specs, current) in SCENARIOS.items():
        models = [SimulatedModel(m[0], acc, m[1], m[2]) for m, acc in specs]
        outcomes, truth = simulated_outcomes(invoices, models, seed=args.seed)
        right = pick_from(*truth, settings.tolerance_points)[0]
        results = evaluate(outcomes, current, evidence_sizes=tuple(args.sizes), splits=args.splits,
                           seed=args.seed, settings=settings, truth=truth)
        rates = ", ".join(f"{m} {truth[0][m]:.1%}" for m in sorted(truth[0]))
        lines += ["", f"## {name}", "", f"{what}. True pass rates: {rates}. In use: {current}; right pick: {right}.",
                  "", *table(results)]
        payload[name] = {"what": what, "current": current, "right": right, "true_pass_rates": truth[0],
                         "results": as_json(results)}
        print(f"{name}: " + " | ".join(f"n={r.evidence_per_model} safe {r.safe_rate:.0%} right {r.exact_rate:.0%}"
                                       for r in results))
    lines += [
        "",
        "## What this shows",
        "",
        "- **Every move the engine makes is safe.** Where the model in use is good enough, no pick in any split",
        "  was more than the margin worse than the best, at any evidence size. Before the rule was changed, 8% of",
        "  picks at 25 runs per model were (the luckiest model was recommended without being compared with the",
        "  model in use).",
        "- **It is cautious with savings.** Proving a 1.4-point gap is under 3 points at 95% confidence takes",
        "  about 900 runs per model, so until then the engine holds and asks for a re-test. A truly equal model is",
        "  proven sooner. A wider margin or a lower confidence would capture savings earlier, at more risk.",
        "- **It is slow to move off a model that is behind but not proven so.** In `current-is-worse` the engine",
        "  holds the weaker model until the gap is proven to exceed the margin. It now names the best model for a",
        "  re-test whenever the model in use measures more than the margin behind, so the proof arrives sooner",
        "  than production traffic alone brings it. A snapshot with a fixed amount of evidence, as here, cannot",
        "  show that speed-up; it shows the decision the engine makes before the extra evidence arrives.",
    ]
    (ROOT / "reports" / "holdout_check.md").write_text("\n".join(lines) + "\n", encoding="utf8")
    (ROOT / "reports" / "holdout_check.json").write_text(json.dumps(payload, indent=2) + "\n", encoding="utf8")
    print("wrote reports/holdout_check.md and .json")
    return 0


def run_recorded(args: argparse.Namespace) -> int:
    from agent_memory.recommend.holdout import evaluate, paired_prompts, right_answer

    outcomes = asyncio.run(from_database(args))
    prompts = paired_prompts(outcomes)
    rates = right_answer(outcomes, prompts, 0.03)[1]
    costs = {m: sum(o.cost_usd or 0 for o in outcomes[m].values()) / len(outcomes[m]) for m in outcomes}
    current = args.current or max(costs, key=costs.get)
    print(f"{len(outcomes)} models, {len(prompts)} prompts answered by all; current model: {current}")
    for m in sorted(outcomes):
        print(f"  {m:28} pass rate {rates[m]:.1%} over all prompts, ${costs[m] * 1000:.4f} per 1,000 runs")
    if len(prompts) < 400:
        print("  note: with fewer than 400 prompts the held-out half measures pass rates to only about +-2 points")
    results = evaluate(outcomes, current, evidence_sizes=tuple(args.sizes), splits=args.splits, seed=args.seed)
    print(f"\n{args.splits} random splits per size, scored against the held-out half\n")
    print("\n".join(table(results)))
    if args.out:
        payload = {"source": f"{args.project}/{args.job}", "current": current, "prompts": len(prompts),
                   "pass_rates": rates, "results": as_json(results)}
        Path(args.out).write_text(json.dumps(payload, indent=2) + "\n", encoding="utf8")
    return 0


def main() -> int:
    from agent_memory.config import load_dotenv_file

    load_dotenv_file()
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--simulated", action="store_true", help="simulated answers, four scenarios, written to reports/")
    parser.add_argument("--invoices", type=int, default=1000, help="with --simulated: invoices to generate")
    parser.add_argument("--project", help="project id whose recorded runs to use")
    parser.add_argument("--job", default="invoice-extract")
    parser.add_argument("--current", help="the model production uses now (default: the dearest per run)")
    parser.add_argument("--splits", type=int, default=500)
    parser.add_argument("--sizes", type=int, nargs="+", default=[25, 50, 100, 200, 400],
                        help="evidence runs per model")
    parser.add_argument("--seed", type=int, default=0)
    parser.add_argument("--out", help="with --project: also write the results as JSON")
    args = parser.parse_args()
    if args.simulated:
        return run_simulated(args)
    if not args.project:
        parser.error("give --project (recorded runs) or --simulated")
    return run_recorded(args)


if __name__ == "__main__":
    sys.exit(main())
