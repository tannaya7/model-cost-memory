"""Promising ('worth a trial'): pure rule, checkpoints, stage-2 sample size, golden Proven regression, simulation."""

import itertools
import json
import random
from datetime import UTC, datetime, timedelta
from pathlib import Path

from agent_memory.recommend.engine import ModelInput, decide
from agent_memory.recommend.promising import (
    Group, checkpoints, is_promising, needed_per_model, weighted,
)
from agent_memory.recommend.stats import Sample, assess, difference, z_for

T0 = datetime(2026, 10, 1, tzinfo=UTC)
KW = dict(margin=0.03, stability_days=7.5, proven_z=z_for(0.99))


def series(rate, n, *, start=T0, days=10.0, seed=1):
    """n single-answer groups spread over `days`, with a deterministic pass pattern at `rate`."""
    rng = random.Random(seed)
    return [Group(at=start + timedelta(days=days * i / max(n - 1, 1)), n=1, passes=int(rng.random() < rate))
            for i in range(n)]


def evenly(rate, n, *, start=T0, days=10.0):
    """Exactly round(rate*n) passes, spread evenly."""
    fails = n - round(rate * n)
    stride = n / fails if fails else None
    failing = {int(i * stride) for i in range(fails)} if fails else set()
    return [Group(at=start + timedelta(days=days * i / (n - 1)), n=1, passes=0 if i in failing else 1) for i in range(n)]


NOW = T0 + timedelta(days=10)


def test_golden_proven_outputs_unchanged():
    golden = json.loads((Path(__file__).parent / "golden_proven.json").read_text())
    got = {}

    def mk(name, p, n, cost):
        return ModelInput(model=name, model_version=name + "-1", n_runs=int(n), failures=round(n * (1 - p)),
                          sample=Sample(p, n, n), mean_cost_usd=cost)

    for pc, pm, nc, nm in itertools.product([.9, .95, .99, 1.0, .8], [.9, .95, .99, 1.0], [10, 60, 150, 400, 2000],
                                            [30, 150, 800]):
        ins = [mk("big", pc, nc, .03), mk("mini", pm, nm, .001)]
        for cur in ("big", "mini"):
            for adv in (None, "mini"):
                d = decide(ins, cur, floor=25.0, margin=.03, confidence=.95, switch_confidence=.99, advised=adv)
                got[f"{pc}|{pm}|{nc}|{nm}|{cur}|{adv}"] = {
                    "v": d.verdict, "rec": d.recommended.model if d.recommended else None,
                    "st": {m.model: [m.status, m.eligible, m.pass_rate_low, m.pass_rate_high] for m in d.models},
                    "w": len(d.warnings), "n": d.next_step, "rt": d.retest_candidates, "pr": d.progress}
        a, b = Sample(pc, nc, nc), Sample(pm, nm, nm)
        for z in (1.96, 2.576):
            got[f"A{pc}|{pm}|{nc}|{nm}|{z}"] = [assess(a, b, margin=.03, z=z), list(difference(a, b, z))]
    assert json.loads(json.dumps(got)) == golden
    assert all(d is None for d in [])  # no promising without history is covered below


def test_checkpoints_every_fifty_in_run_order():
    cps = checkpoints(series(.9, 170))
    assert len(cps) == 3 and cps == sorted(cps)


def test_promising_when_close_and_enough_data():
    cand, cur = evenly(.97, 400), evenly(.97, 400)
    assert is_promising(cand, cur, now=NOW, **KW)


def test_not_with_thin_data():
    assert not is_promising(evenly(.95, 60), evenly(.95, 60), now=NOW, **KW)  # fewer than 2 checkpoints / n < 100
    assert not is_promising(evenly(.97, 400), evenly(.97, 60), now=NOW, **KW)  # model in use thin


def test_not_before_seven_days():
    cand = evenly(.97, 400, days=5)
    cur = evenly(.97, 400, days=5)
    assert not is_promising(cand, cur, now=T0 + timedelta(days=5), **KW)


def test_not_when_clearly_worse():
    assert not is_promising(evenly(.80, 400), evenly(.95, 400), now=NOW, **KW)


def test_needs_two_consecutive_checkpoints():
    # Good early, then the last 100 answers are poor: the last checkpoint fails, so no Promising.
    good = evenly(.97, 400)
    bad = [Group(at=T0 + timedelta(days=8 + i / 100), n=1, passes=int(i % 2 == 0)) for i in range(100)]
    cur = evenly(.97, 500)
    assert not is_promising(good + bad, cur, now=NOW, **KW)


def test_never_with_proven():
    cand, cur = evenly(.97, 6000), evenly(.97, 6000)
    c, r = weighted(cand, NOW, 7.5), weighted(cur, NOW, 7.5)
    assert assess(c, r, margin=.03, z=KW["proven_z"]) == "GOOD_ENOUGH"
    assert not is_promising(cand, cur, now=NOW, **KW)


def test_decide_shows_promising_only_on_hold_and_never_a_downgrade():
    def mk(name, g, cost):
        s = weighted(g, NOW, 7.5)
        return ModelInput(model=name, model_version=name + "-1", n_runs=len(g), failures=0, sample=s,
                          mean_cost_usd=cost, history=g)
    # Close but not proven at the switch confidence: HOLD with Promising.
    ins = [mk("big", evenly(.97, 400), .03), mk("mini", evenly(.97, 400), .001)]
    d = decide(ins, "big", floor=25.0, margin=.03, confidence=.95, switch_confidence=.99, now=NOW)
    assert d.verdict == "HOLD"
    if True:
        assert d.promising is not None and d.promising.model == "mini" and d.promising.current == "big"
    big = [mk("big", evenly(.97, 6000), .03), mk("mini", evenly(.97, 6000), .001)]
    d2 = decide(big, "big", floor=25.0, margin=.03, confidence=.95, switch_confidence=.99, now=NOW)
    assert d2.verdict == "DOWNGRADE" and d2.promising is None


def test_decide_without_history_has_no_promising():
    ins = [ModelInput("a", "a-1", 100, 5, Sample(.95, 100, 100), .03), ModelInput("b", "b-1", 100, 5, Sample(.95, 100, 100), .001)]
    assert decide(ins, "a", floor=25.0, margin=.03, confidence=.95, switch_confidence=.99, now=NOW).promising is None


def test_needed_per_model():
    n = needed_per_model(.95, .95, margin=.03, z=2.576, floor=25)
    assert 300 < n < 1500
    assert needed_per_model(.95, .95, margin=.03, z=2.576, floor=25) >= needed_per_model(.95, .95, margin=.03, z=1.96, floor=25)
    assert needed_per_model(1.0, 1.0, margin=.03, z=2.576, floor=25) >= 25
    assert needed_per_model(0.0, 0.0, margin=.03, z=2.576, floor=25) is not None
    assert needed_per_model(.5, .95, margin=.03, z=2.576, floor=25) is None  # never within the margin
    assert needed_per_model(float("nan"), .9, margin=.03, z=2.576, floor=25) is None
    assert needed_per_model(.99, .90, margin=.03, z=2.576, floor=25) >= 25  # floor


def _simulate(true_gap, runs=300, p=0.95, per_week=150):
    """Share of seeds for which Promising shows after 4 weeks of 150 answers a week per model, true rate 95%."""
    shows = 0
    for seed in range(runs):
        rng = random.Random(seed)
        cand, cur = [], []
        for week in range(1, 5):
            for _ in range(per_week):
                at = T0 + timedelta(days=7 * (week - 1) + rng.random() * 7)
                cand.append(Group(at, 1, int(rng.random() < p + true_gap)))
                cur.append(Group(at, 1, int(rng.random() < p)))
        # one look per seed: at the end of week 6
        now = T0 + timedelta(days=28)
        shows += is_promising(sorted(cand, key=lambda g: g.at), cur, now=now, **KW)
    return shows / runs


def test_simulation_rates(capsys):
    worse = _simulate(-0.05, runs=200)
    equal = _simulate(0.0, runs=200)
    print(f"SIM promising rate: truly 5 points worse = {worse:.3f}; truly equal = {equal:.3f}")
    assert worse < 0.05
    assert equal > worse
