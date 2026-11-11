"""Held-out check: is the engine's pick right on prompts it never saw? (technical plan 9, AI evaluation)

Input is a labelled set where every model answered the same prompts: for each model, each prompt's
outcome (pass or fail) and cost. Many times over, the prompts are split at random into an evidence
part and a held-out part:

    1. the engine decides from evidence prompts only, through the production rule (engine.decide)
    2. on the held-out prompts, the right pick is worked out the same way the simulation scores
       itself: of the models within `margin` of the best held-out pass rate, the cheapest per success
    3. the engine's pick is scored against it

    safe      the pick's held-out pass rate is within `margin` of the best: the promise a user relies
              on when they act on a recommendation
    exact     the pick is the held-out right answer
    refused   the engine said INSUFFICIENT_EVIDENCE (production keeps the current model; that is
              scored as the pick)
    saving    of the saving per success the right answer offers over the current model, how much
              the pick realises, summed over splits

Repeating at several evidence sizes shows how many runs per model the engine needs before its picks
can be trusted. The held-out part is itself a sample, so "right" is measured with noise too: with 100
held-out prompts a pass rate is only known to about +-2 points, close to the 3-point margin. Use a
labelled set of several hundred prompts. When the true pass rates are known (simulated answers),
pass them as `truth` and every split is scored against them instead.
"""

from __future__ import annotations

import random
from collections import defaultdict
from dataclasses import dataclass, field

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..config import Settings, get_settings
from ..models import Job, Run
from ..pipeline.decay import family_key
from .engine import ModelInput, decide
from .stats import sample


@dataclass(frozen=True)
class Outcome:
    passed: bool
    cost_usd: float | None


# model -> prompt id -> what that model did on that prompt
Outcomes = dict[str, dict[str, Outcome]]


@dataclass
class HoldoutResult:
    evidence_per_model: int
    splits: int
    safe: int = 0
    exact: int = 0
    refused: int = 0
    saving_offered: float = 0.0  # per success, summed over splits
    saving_realised: float = 0.0
    picks: dict[str, int] = field(default_factory=dict)

    @property
    def safe_rate(self) -> float:
        return self.safe / self.splits if self.splits else 0.0

    @property
    def exact_rate(self) -> float:
        return self.exact / self.splits if self.splits else 0.0

    @property
    def refused_rate(self) -> float:
        return self.refused / self.splits if self.splits else 0.0

    @property
    def saving_captured(self) -> float | None:
        return self.saving_realised / self.saving_offered if self.saving_offered > 0 else None


def paired_prompts(outcomes: Outcomes) -> list[str]:
    """Prompts every model answered, in a stable order."""
    sets = [set(by_prompt) for by_prompt in outcomes.values()]
    return sorted(set.intersection(*sets)) if sets else []


def _rate_and_cost(outcomes: Outcomes, model: str, prompts: list[str]) -> tuple[float, float | None]:
    rows = [outcomes[model][p] for p in prompts]
    costs = [r.cost_usd for r in rows if r.cost_usd is not None]
    return sum(r.passed for r in rows) / len(rows), (sum(costs) / len(costs) if costs else None)


def right_answer(outcomes: Outcomes, prompts: list[str], margin: float) -> tuple[str, dict[str, float], dict]:
    """The cheapest model per success within `margin` of the best pass rate on these prompts."""
    rates, costs = {}, {}
    for model in outcomes:
        rates[model], costs[model] = _rate_and_cost(outcomes, model, prompts)
    return pick_from(rates, costs, margin)


def pick_from(rates: dict[str, float], costs: dict[str, float | None], margin: float) -> tuple[str, dict, dict]:
    """(right model, pass rates, cost per success) from pass rates and mean costs per run."""
    cps = {m: costs[m] / rates[m] if costs[m] is not None and rates[m] > 0 else None for m in rates}
    best = max(rates.values())
    eligible = [m for m in rates if rates[m] >= best - margin and cps[m] is not None]
    pick = min(eligible, key=lambda m: (cps[m], -rates[m])) if eligible else max(rates, key=rates.get)
    return pick, rates, cps


def engine_pick(outcomes: Outcomes, prompts: list[str], current: str, settings: Settings) -> tuple[str, bool]:
    """What the production rule recommends from these prompts' runs; (model, refused)."""
    inputs = []
    for model in sorted(outcomes):
        rows = [outcomes[model][p] for p in prompts]
        costs = [r.cost_usd for r in rows if r.cost_usd is not None]
        inputs.append(ModelInput(
            model=model, model_version=model, n_runs=len(rows), failures=sum(not r.passed for r in rows),
            sample=sample((1.0, r.passed) for r in rows),  # all fresh: weight 1 each
            mean_cost_usd=sum(costs) / len(costs) if costs else None, catalog_status="ACTIVE",
        ))
    decision = decide(inputs, current, floor=settings.evidence_floor, margin=settings.tolerance_points,
                      confidence=settings.confidence_level)
    if decision.verdict == "INSUFFICIENT_EVIDENCE" or decision.recommended is None:
        return current, True
    return decision.recommended.model, False


def evaluate(
    outcomes: Outcomes, current: str, *, evidence_sizes: tuple[int, ...] = (25, 50, 100), splits: int = 200,
    seed: int = 0, settings: Settings | None = None, truth: tuple[dict, dict] | None = None,
) -> list[HoldoutResult]:
    """Score the engine's pick against held-out prompts, `splits` times per evidence size.

    Half the prompts are held out in each split; the evidence is the first `n` of the other half, so
    every size is judged against held-out sets of the same size. `truth` = (true pass rate, true mean
    cost per run) per model replaces the held-out estimate when it is known.
    """
    settings = settings or get_settings()
    margin = settings.tolerance_points
    prompts = paired_prompts(outcomes)
    if current not in outcomes:
        raise ValueError(f"No runs for the current model '{current}'")
    if len(prompts) < 20:
        raise ValueError(f"Only {len(prompts)} prompts were answered by every model; at least 20 are needed")
    held_n = len(prompts) // 2
    results = []
    for n in evidence_sizes:
        if n > len(prompts) - held_n:
            continue
        rng = random.Random(seed)
        result = HoldoutResult(evidence_per_model=n, splits=splits)
        picks: dict[str, int] = defaultdict(int)
        for _ in range(splits):
            shuffled = rng.sample(prompts, len(prompts))
            held, evidence = shuffled[:held_n], shuffled[held_n:held_n + n]
            pick, refused = engine_pick(outcomes, evidence, current, settings)
            right, rates, cps = pick_from(*truth, margin) if truth else right_answer(outcomes, held, margin)
            picks[pick] += 1
            result.refused += refused
            result.exact += pick == right
            result.safe += rates[pick] >= max(rates.values()) - margin
            if None not in (cps[current], cps[right], cps[pick]) and cps[right] < cps[current]:
                result.saving_offered += cps[current] - cps[right]
                result.saving_realised += cps[current] - cps[pick]
        result.picks = dict(sorted(picks.items()))
        results.append(result)
    return results


async def load_outcomes(session: AsyncSession, job: Job) -> Outcomes:
    """A job's checked runs as outcomes per model family and prompt (the latest run when a prompt repeats)."""
    rows = (
        await session.execute(
            select(Run.model, Run.model_version, Run.prompt_hash, Run.outcome, Run.cost_usd)
            .where(Run.job_id == job.job_id, Run.outcome.in_(("PASS", "FAIL")), Run.invalid_at.is_(None))
            .order_by(Run.created_at)
        )
    ).all()
    out: Outcomes = defaultdict(dict)
    for r in rows:
        out[family_key(r.model, r.model_version)][r.prompt_hash] = Outcome(
            r.outcome == "PASS", float(r.cost_usd) if r.cost_usd is not None else None)
    return dict(out)


@dataclass(frozen=True)
class SimulatedModel:
    """A stand-in for a real model: a pass rate per difficulty and the price it is charged at."""

    name: str
    accuracy: dict[str, float]  # easy / medium / hard
    price_in_per_mtok: float
    price_out_per_mtok: float


def _sim_cost(m: SimulatedModel, prompt: str, tokens_out: int) -> float:
    return (len(prompt) / 4 * m.price_in_per_mtok + tokens_out * m.price_out_per_mtok) / 1_000_000


def simulated_outcomes(invoices, models: list[SimulatedModel], *, seed: int = 0,
                       tokens_out: int = 60) -> tuple[Outcomes, tuple[dict, dict]]:
    """Each simulated model answers each invoice: pass with its accuracy for that difficulty, at its
    list price for the invoice's prompt length (about 4 characters a token). Also returns the truth:
    each model's expected pass rate and mean cost over the invoices."""
    rng = random.Random(seed)
    out: Outcomes = {}
    rates, costs = {}, {}
    for m in models:
        out[m.name] = {
            inv.id: Outcome(rng.random() < m.accuracy[inv.difficulty], _sim_cost(m, inv.prompt, tokens_out))
            for inv in invoices
        }
        rates[m.name] = sum(m.accuracy[inv.difficulty] for inv in invoices) / len(invoices)
        costs[m.name] = sum(_sim_cost(m, inv.prompt, tokens_out) for inv in invoices) / len(invoices)
    return out, (rates, costs)
