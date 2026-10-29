"""Cheapest model that passes, per job (technical plan 3.4).

Every checked run (PASS or FAIL, not archived) counts as evidence for its model family, weighted by
freshness R(t), so evidence about a superseded version fades about four times faster. For each model:

    weighted pass rate, with a 95% interval        stats.py
    cost per success = mean cost / pass rate       a cheap model that fails often is not cheap

A model needs `evidence_floor` of weight before it is judged. The judged model with the highest
lower bound is the reference, and every other one is tested against it with the tolerance rule
(stats.assess). Of those GOOD_ENOUGH and not RETIRED, the lowest cost per success is recommended.
The verdict compares that with the model production uses now:

    HOLD                   keep the current model
    DOWNGRADE              a cheaper model is good enough, and shown to be within the margin of the
                           current model itself, not only of the reference
    SWITCH                 the current model is clearly worse or retired
    INSUFFICIENT_EVIDENCE  no model has enough evidence yet; refusing is a required answer

Moving off the model in use needs proof in both directions. A cheaper model that is good enough next
to the reference but not yet next to the current model is held, and re-testing it is suggested: with
little evidence the reference is often just the luckiest model, and the held-out check
(holdout.py) showed that recommending it broke the 95% promise. The other way round, a current model
that measures more than the margin below the reference without that being proven yet is held too,
and the reference is suggested for a re-test, so the proof arrives sooner than traffic alone brings it.

`decide` is pure (no database), so the rule can be tested and swapped on its own; `recommend` loads a
job's runs and calls it, and `forecast` turns a DOWNGRADE or SWITCH into money and failures per month.
The Consolidator (pipeline/consolidation.py) stores each changed verdict with the runs behind it.
"""

from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass, field
from datetime import UTC, date, datetime, timedelta
from typing import Literal

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from ..config import Settings, get_settings
from ..models import CatalogEntry, Job, Run
from ..pipeline.decay import current_versions, family_key
from ..pipeline.scoring import age_days, freshness, stability_days
from ..versions import normalize
from .stats import Sample, assess, difference, sample, wilson, z_for

Verdict = Literal["HOLD", "DOWNGRADE", "SWITCH", "INSUFFICIENT_EVIDENCE"]
Status = Literal["GOOD_ENOUGH", "UNSURE", "CLEARLY_WORSE", "BELOW_FLOOR", "RETIRED"]
FAILING_RUNS_SHOWN = 5
COUNTED_OUTCOMES = ("PASS", "FAIL")
UNCOUNTED_STATES = ("ARCHIVED", "INGESTION_FAILED")


@dataclass
class ModelInput:
    """What the runs say about one model family in one job."""

    model: str
    model_version: str
    n_runs: int
    failures: int
    sample: Sample | None
    mean_cost_usd: float | None  # None when no price is known
    catalog_status: str = "UNKNOWN"
    shutdown_date: date | None = None


@dataclass
class ModelEvidence(ModelInput):
    pass_rate_low: float | None = None
    pass_rate_high: float | None = None
    cost_per_success_usd: float | None = None
    status: Status = "BELOW_FLOOR"
    eligible: bool = False
    why: str = ""


@dataclass
class Decision:
    verdict: Verdict
    current: ModelEvidence | None
    recommended: ModelEvidence | None
    reference: ModelEvidence | None
    models: list[ModelEvidence]
    progress: float = 1.0  # toward the evidence floor; below 1.0 only for INSUFFICIENT_EVIDENCE
    retest_candidates: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)
    next_step: str | None = None


def _points(x: float) -> str:
    return f"{x * 100:g} points"


def _cheaper(a: ModelEvidence, b: ModelEvidence) -> bool:
    """Only when both costs are known."""
    return (
        a.cost_per_success_usd is not None and b.cost_per_success_usd is not None
        and a.cost_per_success_usd < b.cost_per_success_usd
    )


def _within(candidate: ModelEvidence, current: ModelEvidence, margin: float, z: float) -> bool:
    """Shown to be at most `margin` worse than the model in use."""
    if candidate.sample is None or current.sample is None:
        return False
    return assess(candidate.sample, current.sample, margin=margin, z=z) == "GOOD_ENOUGH"


def decide(
    inputs: list[ModelInput], current_model: str | None, *, floor: float, margin: float, confidence: float
) -> Decision:
    """The verdict for one job, from per-model evidence and the model production uses now."""
    z = z_for(confidence)
    models = [ModelEvidence(**vars(m)) for m in inputs]
    judged: list[ModelEvidence] = []
    for m in models:
        if m.sample is not None:
            m.pass_rate_low, m.pass_rate_high = wilson(m.sample.pass_rate, m.sample.effective_n, z)
            if m.mean_cost_usd is not None and m.sample.pass_rate > 0:
                m.cost_per_success_usd = m.mean_cost_usd / m.sample.pass_rate
        weight = m.sample.evidence_weight if m.sample else 0.0
        if m.catalog_status == "RETIRED":
            m.status, m.why = "RETIRED", "Retired by the provider, so it is never recommended"
        elif weight < floor:
            m.status, m.why = "BELOW_FLOOR", f"Evidence {weight:.1f} of the {floor:g} needed to judge it"
        else:
            judged.append(m)

    by_name = {m.model: m for m in models}
    current = by_name.get(current_model) if current_model else None
    if not judged:
        best = max((m.sample.evidence_weight for m in models if m.sample), default=0.0)
        return Decision(
            "INSUFFICIENT_EVIDENCE", current, None, None, models, progress=min(1.0, best / floor) if floor else 1.0,
            next_step="Record more runs, or run a re-test to gather evidence sooner",
        )

    reference = max(judged, key=lambda m: (m.pass_rate_low, m.sample.pass_rate))
    for m in judged:
        if m is reference:
            m.status, m.why = "GOOD_ENOUGH", "Highest pass rate we can be sure of"
            continue
        m.status = assess(m.sample, reference.sample, margin=margin, z=z)
        m.why = {
            "GOOD_ENOUGH": f"At most {_points(margin)} worse than {reference.model}, {confidence:.0%} sure",
            "CLEARLY_WORSE": f"More than {_points(margin)} worse than {reference.model}",
            "UNSURE": f"Not yet sure it is within {_points(margin)} of {reference.model}; a re-test would settle it",
        }[m.status]
    for m in judged:
        if m.status == "GOOD_ENOUGH" and m.cost_per_success_usd is None:
            m.why = "Good enough, but no price is known, so its cost cannot be compared"
        m.eligible = m.status == "GOOD_ENOUGH" and m.cost_per_success_usd is not None

    warnings: list[str] = []
    eligible = [m for m in judged if m.eligible]
    if eligible:
        recommended = min(eligible, key=lambda m: (m.cost_per_success_usd, -m.sample.pass_rate))
    else:
        recommended = reference
        warnings.append("No price is known for the models that qualify, so this is chosen by pass rate alone")

    if current is None:
        return Decision(
            "INSUFFICIENT_EVIDENCE", None, recommended, reference, models,
            next_step="Record production runs, so the engine knows which model this job uses now",
        )

    settle: list[str] = []  # re-tests that would settle a decision held for want of proof
    # The model in use measures more than the margin below the reference, but that is not proven yet.
    gap = reference.sample.pass_rate - current.sample.pass_rate if current.sample else 0.0
    behind = current.status == "UNSURE" and gap > margin
    if recommended is current:
        verdict: Verdict = "HOLD"
    elif current.status in ("RETIRED", "CLEARLY_WORSE"):
        verdict = "SWITCH"
    elif current.status == "GOOD_ENOUGH" or _cheaper(recommended, current):
        if _within(recommended, current, margin, z):
            verdict = "DOWNGRADE"  # what qualifies and costs less per success
        else:
            warnings.append(
                f"Not yet sure {recommended.model} is within {_points(margin)} of {current.model}, the model in "
                f"use; a re-test of {recommended.model} would settle it"
            )
            settle.append(recommended.model)
            verdict, recommended = "HOLD", current
    else:
        # The current model is not proven good enough, but nothing cheaper is either.
        verdict, recommended = "HOLD", current
        if not behind:
            warnings.append(
                f"{current.model} has too little evidence to judge yet" if current.status == "BELOW_FLOOR"
                else f"Not yet sure {current.model} is within {_points(margin)} of {reference.model}; "
                "a re-test on more of its prompts would settle it"
            )

    if verdict == "HOLD" and behind and reference.model not in settle:
        warnings.append(
            f"{current.model} measures {gap * 100:.1f} points below {reference.model}, not yet proven; a re-test of "
            f"{reference.model} will show whether to switch"
        )
        settle.append(reference.model)

    if recommended.catalog_status == "DEPRECATED":
        warnings.append(f"{recommended.model} is deprecated and shuts down on {recommended.shutdown_date}")
        others = [m for m in eligible if m is not recommended and m.catalog_status != "DEPRECATED"]
        if others:
            alternative = min(others, key=lambda m: m.cost_per_success_usd)
            warnings.append(f"The next cheapest model that qualifies is {alternative.model}")

    retest = [
        m.model for m in models
        if m.status in ("UNSURE", "BELOW_FLOOR") and m is not recommended and _cheaper(m, recommended)
    ]
    if retest:
        next_step = f"Re-test {', '.join(retest)}: cheaper, but not enough evidence yet"
    elif settle:
        next_step = f"Re-test {', '.join(settle)} to settle whether to switch"
    else:
        next_step = None
    retest += [m for m in settle if m not in retest]
    return Decision(verdict, current, recommended, reference, models, retest_candidates=retest,
                    warnings=warnings, next_step=next_step)


@dataclass
class Forecast:
    """What switching would change per month, if next month looks like the last 30 days."""

    runs_per_month: int
    monthly_saving_usd: float
    extra_failures_per_month: float
    extra_failures_low: float  # the interval of the pass-rate difference, in failures per month
    extra_failures_high: float


def forecast(decision: Decision, runs_per_month: int, *, confidence: float) -> Forecast | None:
    """monthly saving = (cost per success now - recommended) x successes per month;
    extra failures = (pass rate now - recommended) x runs per month, with its interval."""
    rec, cur = decision.recommended, decision.current
    if decision.verdict not in ("DOWNGRADE", "SWITCH") or rec is None or cur is None or rec is cur:
        return None
    if None in (rec.cost_per_success_usd, cur.cost_per_success_usd) or not (rec.sample and cur.sample):
        return None
    successes = runs_per_month * cur.sample.pass_rate
    low, high = difference(cur.sample, rec.sample, z_for(confidence))  # current minus recommended
    return Forecast(
        runs_per_month=runs_per_month,
        monthly_saving_usd=(cur.cost_per_success_usd - rec.cost_per_success_usd) * successes,
        extra_failures_per_month=(cur.sample.pass_rate - rec.sample.pass_rate) * runs_per_month,
        extra_failures_low=low * runs_per_month, extra_failures_high=high * runs_per_month,
    )


@dataclass
class FailingRun:
    run_id: object
    model: str
    model_version: str
    outcome_reason: str | None
    created_at: datetime


@dataclass
class JobRecommendation:
    job: str
    decision: Decision
    n_runs: int
    evidence_weight: float
    failing_runs: list[FailingRun]
    computed_at: datetime
    settings: Settings
    run_ids: list = field(default_factory=list)  # every counted run: what a stored verdict rests on
    forecast: Forecast | None = None


async def _catalog(session: AsyncSession, names: set[str]) -> dict[str, CatalogEntry]:
    rows = (await session.execute(select(CatalogEntry).where(CatalogEntry.model.in_(names or {""})))).scalars()
    return {row.model: row for row in rows}


async def recommend(
    session: AsyncSession, job: Job, *, now: datetime | None = None, settings: Settings | None = None
) -> JobRecommendation:
    """Load a job's evidence, weight it as of `now`, and decide."""
    settings = settings or get_settings()
    now = now or datetime.now(UTC)

    runs = (
        await session.execute(
            select(Run.run_id, Run.model, Run.model_version, Run.outcome, Run.outcome_reason, Run.cost_usd,
                   Run.created_at)
            .where(Run.job_id == job.job_id, Run.outcome.in_(COUNTED_OUTCOMES), Run.state.not_in(UNCOUNTED_STATES),
                   Run.invalid_at.is_(None))
        )
    ).all()
    current_version = await current_versions(session, job.job_id)

    weights: dict[str, list[tuple[float, bool]]] = defaultdict(list)
    weighted_cost: dict[str, float] = defaultdict(float)  # over priced runs only
    priced_weight: dict[str, float] = defaultdict(float)
    failures: dict[str, list] = defaultdict(list)
    for run in runs:
        name = family_key(run.model, run.model_version)
        # An unrecognised version is treated as current (TIP 3.7): never discount evidence by accident.
        superseded = normalize(run.model_version) != current_version.get((job.job_id, name), normalize(run.model_version))
        cost = float(run.cost_usd) if run.cost_usd is not None else None  # None: price unknown
        # The averaging weight must not depend on the outcome: if failures were remembered longer than
        # passes of the same age, every pass rate would be biased down, most for models with old failures
        # (a superseded version's failures outliving its passes). Importance keeps doing its two jobs,
        # deciding what is archived (decay.py) and what re-tests sample first; here only age and
        # version currency count.
        stab = stability_days(
            1.0, superseded=superseded,
            base_days=settings.decay_base_days, superseded_factor=settings.version_factor_superseded,
        )
        w = freshness(age_days(run.created_at, now), stab)
        weights[name].append((w, run.outcome == "PASS"))
        if cost is not None:
            weighted_cost[name] += w * cost
            priced_weight[name] += w
        if run.outcome == "FAIL":
            failures[name].append(run)

    latest = (
        await session.execute(
            select(Run.model, Run.model_version)
            .where(Run.job_id == job.job_id, Run.run_kind == "PRODUCTION", Run.state.not_in(UNCOUNTED_STATES))
            .order_by(Run.created_at.desc()).limit(1)
        )
    ).first()
    current_model = family_key(*latest) if latest else None

    # The current model is listed even when none of its runs is checked yet (e.g. awaiting labels).
    names = set(weights) | ({current_model} if current_model else set())
    versions = {name: current_version.get((job.job_id, name), name) for name in names}
    catalog = await _catalog(session, names | set(versions.values()))
    inputs = []
    for name in sorted(names):
        pairs = weights.get(name, [])
        s = sample(pairs)
        entry = catalog.get(versions[name]) or catalog.get(name)
        # Mean over priced runs; a model with no priced run has no cost, so it can never look cheapest.
        mean_cost = weighted_cost[name] / priced_weight[name] if priced_weight[name] else None
        inputs.append(ModelInput(
            model=name, model_version=versions[name], n_runs=len(pairs), failures=len(failures[name]), sample=s,
            mean_cost_usd=mean_cost,
            catalog_status=entry.status if entry else "UNKNOWN", shutdown_date=entry.shutdown_date if entry else None,
        ))
    decision = decide(
        inputs, current_model, floor=settings.evidence_floor,
        margin=settings.tolerance_points, confidence=settings.confidence_level,
    )

    runs_per_month = (
        await session.execute(
            select(func.count()).select_from(Run)
            .where(Run.job_id == job.job_id, Run.run_kind == "PRODUCTION", Run.created_at > now - timedelta(days=30),
                   Run.created_at <= now)
        )
    ).scalar_one()

    shown = {m.model for m in (decision.recommended, decision.current) if m is not None}
    failing = sorted((r for name in shown for r in failures[name]), key=lambda r: r.created_at, reverse=True)
    return JobRecommendation(
        job=job.name, decision=decision, n_runs=len(runs),
        evidence_weight=sum(w for pairs in weights.values() for w, _ in pairs),
        failing_runs=[
            FailingRun(r.run_id, family_key(r.model, r.model_version), r.model_version, r.outcome_reason, r.created_at)
            for r in failing[:FAILING_RUNS_SHOWN]
        ],
        computed_at=now, settings=settings, run_ids=[r.run_id for r in runs],
        forecast=forecast(decision, runs_per_month, confidence=settings.confidence_level),
    )
