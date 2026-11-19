"""Checks the savings method by simulation, where the true answer is known.

    python scripts/validate_savings_method.py [--reps 200] [--boot 500]

For each scenario it draws many synthetic before/after windows, runs `savings_method.analyse` and reports how often each status
comes out. What a good method does:
- no real change: a saving is shown rarely (the false-positive rate; we want it about 5% or less)
- a real saving: it is found, and the shown range contains the truth most of the time
- only the prompt mix moved: no saving is invented (the naive before/after number is shown for contrast)
- cheaper but less correct: never shown as a saving
- too little data: "not enough comparable data", never a number
- a bad stretch just before the change: checking earlier days stops it being counted as a saving

This is a check on the statistics under stated assumptions, not on real customers' data.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from agent_memory.insights import savings_method as sm  # noqa: E402

BASE = np.array([1.0, 2.5, 6.0, 14.0])  # relative cost of a call by prompt-size bucket
MIX_FLAT = np.array([0.45, 0.30, 0.18, 0.07])
MIX_SHIFTED = np.array([0.20, 0.30, 0.30, 0.20])


def draw(rng, n, mix=MIX_FLAT, mult=1.0, pass_p=0.9, sigma=0.5) -> sm.Calls:
    bucket = rng.choice(4, size=n, p=mix)
    cost = BASE[bucket] * mult * rng.lognormal(0.0, sigma, n) * 0.001
    passed = rng.random(n) < pass_p
    return sm.Calls(cost=cost, passed=passed, bucket=bucket, checked=n, calls_total=n)


def naive(before: sm.Calls, after: sm.Calls) -> float:
    return before.cost.sum() / before.passed.sum() - after.cost.sum() / after.passed.sum()


def run(name, reps, boot, make, truth=None):
    rng = np.random.default_rng(20261119)
    counts = dict.fromkeys(sm.STATUSES, 0)
    covered = 0
    naive_pos = 0
    for r in range(reps):
        before, after, extra = make(rng)
        a = sm.analyse(before, after, seed=int(rng.integers(1 << 31)), boot=boot, baselines=extra)
        counts[a.status] += 1
        if truth is not None and a.saving_low is not None and a.saving_low <= truth <= a.saving_high:
            covered += 1
        naive_pos += naive(before, after) > 0
    shown = sum(v for k, v in counts.items() if k not in ("not_enough_data", "waiting"))
    row = {k: round(100 * v / reps, 1) for k, v in counts.items() if v}
    cover = f"  range holds the truth in {round(100 * covered / max(shown, 1))}% of shown results" if truth is not None else ""
    print(f"{name:<52} {row}{cover}  | naive before/after says 'cheaper' in {round(100 * naive_pos / reps)}%")
    return counts


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--reps", type=int, default=200)
    parser.add_argument("--boot", type=int, default=500)
    args = parser.parse_args()
    n = 320  # about 20 checked calls a day for 16 days
    R, B = args.reps, args.boot
    print(f"{R} simulated tasks per scenario, {n} checked calls per window, bootstrap {B}\n")
    mean_cost = float((BASE * MIX_FLAT).sum() * np.exp(0.125) * 0.001 / 0.9)  # cost per correct answer in the base case

    run("1. no real change", R, B, lambda g: (draw(g, n), draw(g, n), {}))
    run("2. real saving of 25%", R, B, lambda g: (draw(g, n), draw(g, n, mult=0.75),{}), truth=mean_cost * 0.25)
    run("3. real saving of 10%", R, B, lambda g: (draw(g, n), draw(g, n, mult=0.90),{}), truth=mean_cost * 0.10)
    run("4. cost went UP by 30%", R, B, lambda g: (draw(g, n), draw(g, n, mult=1.30),{}))
    run("5. only the prompt mix shifted (no real change)", R, B, lambda g: (draw(g, n), draw(g, n, mix=MIX_SHIFTED),{}))
    run("6. cheaper by 30% but pass rate 90% -> 72%", R, B, lambda g: (draw(g, n), draw(g, n, mult=0.7, pass_p=0.72),{}))
    run("7. too little data (60 checked calls)", R, B, lambda g: (draw(g, 60), draw(g, 60, mult=0.7), {}))

    def bad_stretch(g):  # the 28-day baseline is normal for 14 days, then 25% costly for the last 14 days; after = normal
        normal, bad = draw(g, n), draw(g, n, mult=1.25)
        both = sm.Calls(cost=np.concatenate([normal.cost, bad.cost]), passed=np.concatenate([normal.passed, bad.passed]),
                        bucket=np.concatenate([normal.bucket, bad.bucket]), checked=2 * n, calls_total=2 * n)
        return bad, draw(g, n), {"longer": both, "earlier": normal}

    run("8. bad stretch just before the change, no real change", R, B, bad_stretch)
    return 0


if __name__ == "__main__":
    sys.exit(main())
