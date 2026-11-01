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

from collections import Counter, defaultdict
from dataclasses import dataclass, field
from datetime import UTC, date, datetime, timedelta
from typing import Literal

from sqlalchemy import Float, bindparam, func, select, text, tuple_
from sqlalchemy.dialects.postgresql import TIMESTAMP, UUID
from sqlalchemy.ext.asyncio import AsyncSession

from ..catalog.lifecycle import UNKNOWN, lifecycles
from ..config import Settings, get_settings
from ..models import Job, Run
from ..pipeline.decay import current_versions, family_key
from ..pipeline.scoring import stability_days
from ..versions import normalize
from .stats import Sample, assess, difference, wilson, z_for

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
    catalog_note: str | None = None  # set when providers disagree on the model's shutdown


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
            # Its status says so too: "good enough" next to the reference is not good enough to replace the
            # model in use, and a re-test of it must not stop early on that status before it settles this.
            recommended.status, recommended.eligible = "UNSURE", False
            recommended.why = (f"Not yet sure it is within {_points(margin)} of {current.model}, the model in use; "
                               "a re-test would settle it")
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
        warnings.append(recommended.catalog_note
                        or f"{recommended.model} is deprecated and shuts down on {recommended.shutdown_date}")
        others = [m for m in eligible if m is not recommended and m.catalog_status != "DEPRECATED"]
        if others:
            alternative = min(others, key=lambda m: m.cost_per_success_usd)
            warnings.append(f"The next cheapest model that qualifies is {alternative.model}")

    retest = [
        m.model for m in models
        if m.status in ("UNSURE", "BELOW_FLOOR") and m is not recommended and _cheaper(m, recommended)
        and m.model not in settle
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


def _weighted(s: str) -> str:
    """Freshness-weighted sums for stability `s`, from each hour bucket's counts.

    A run of age b + d (b the bucket's start, 0 <= d < 1 hour) weighs e^(-b/s) e^(-d/s), and
    e^(-d/s) = 1 - d/s + d^2/(2s^2) to within (d/s)^3/6: under 3e-8 at the default 7.5-day stability.
    So Postgres only counts and sums d and d^2 per bucket, and exp() runs once per bucket, not per run.
    """
    w = f"exp(-least(b / :{s}, 700))"
    w2 = f"exp(-least(2 * b / :{s}, 700))"
    total = f"{w} * (n - sd / :{s} + sdd / (2 * :{s} * :{s}))"
    return (f"sum({total}) AS total_{s}, "
            f"sum({w2} * (n - 2 * sd / :{s} + 2 * sdd / (:{s} * :{s}))) AS squares_{s}, "
            f"coalesce(sum({total}) FILTER (WHERE passed), 0) AS passing_{s}, "
            f"coalesce(sum({w} * (sc - scd / :{s} + scdd / (2 * :{s} * :{s}))), 0) AS cost_{s}, "
            f"coalesce(sum({total}) FILTER (WHERE priced), 0) AS priced_{s}")


# Each version's evidence, summed in Postgres, in one pass over the job's runs: a job with half a million
# runs returns a few rows (reports/speed.md). Every run is weighted under both stabilities, as a current
# version and as a superseded one; which applies is decided per version in Python, where the family and
# the current version are known. The OFFSET 0 subqueries stop Postgres from inlining them, which made it
# recompute each run's age once for every expression that used it. exp() is capped because Postgres
# raises on underflow; e^-700 is zero for every purpose here.
EVIDENCE = text(f"""
WITH buckets AS (
    SELECT model, model_version, provider, passed, cost IS NOT NULL AS priced, b,
           count(*) AS n, sum(d) AS sd, sum(d * d) AS sdd,
           coalesce(sum(cost), 0) AS sc, coalesce(sum(cost * d), 0) AS scd, coalesce(sum(cost * d * d), 0) AS scdd
    FROM (
        SELECT model, model_version, provider, passed, cost, floor(age * 24) / 24 AS b, age - floor(age * 24) / 24 AS d
        FROM (
            SELECT model, model_version, provider, outcome = 'PASS' AS passed, cost_usd::float8 AS cost,
                   greatest(extract(epoch FROM (:now - created_at))::float8 / 86400.0, 0) AS age
            FROM runs
            WHERE job_id = :job AND outcome IN ('PASS', 'FAIL') AND state NOT IN ('ARCHIVED', 'INGESTION_FAILED')
              AND invalid_at IS NULL
            OFFSET 0
        ) AS aged
        OFFSET 0
    ) AS split
    GROUP BY 1, 2, 3, 4, 5, 6
)
SELECT model, model_version, provider, sum(n) AS n, coalesce(sum(n) FILTER (WHERE NOT passed), 0) AS failures,
       {_weighted("s_current")}, {_weighted("s_superseded")}
FROM buckets
GROUP BY 1, 2, 3
""").bindparams(bindparam("now", type_=TIMESTAMP(timezone=True)), bindparam("job", type_=UUID(as_uuid=True)),
                bindparam("s_current", type_=Float), bindparam("s_superseded", type_=Float))


@dataclass
class _Family:
    """One model family's evidence, added up over its versions."""

    n_runs: int = 0
    failures: int = 0
    total: float = 0.0  # sum of weights
    squares: float = 0.0  # sum of squared weights, for the effective sample size
    passing: float = 0.0
    cost: float = 0.0  # weighted, over priced runs only
    priced: float = 0.0
    providers: Counter = field(default_factory=Counter)
    versions: list[tuple[str, str]] = field(default_factory=list)


def _counted(job: Job):
    return (Run.job_id == job.job_id, Run.outcome.in_(COUNTED_OUTCOMES), Run.state.not_in(UNCOUNTED_STATES),
            Run.invalid_at.is_(None))


async def recommend(
    session: AsyncSession, job: Job, *, now: datetime | None = None, settings: Settings | None = None,
    with_run_ids: bool = False,
) -> JobRecommendation:
    """Load a job's evidence, weight it as of `now`, and decide. `with_run_ids` also lists every counted
    run, which only the Consolidator needs (a stored verdict records the runs it rests on)."""
    settings = settings or get_settings()
    now = now or datetime.now(UTC)

    # The averaging weight must not depend on the outcome: if failures were remembered longer than
    # passes of the same age, every pass rate would be biased down, most for models with old failures
    # (a superseded version's failures outliving its passes). Importance keeps doing its two jobs,
    # deciding what is archived (decay.py) and what re-tests sample first; here only age and
    # version currency count.
    stab = {superseded: stability_days(1.0, superseded=superseded, base_days=settings.decay_base_days,
                                       superseded_factor=settings.version_factor_superseded)
            for superseded in (False, True)}
    rows = (
        await session.execute(EVIDENCE, {"job": job.job_id, "now": now, "s_current": stab[False],
                                         "s_superseded": stab[True]})
    ).all()
    current_version = await current_versions(session, job.job_id)

    families: dict[str, _Family] = defaultdict(_Family)
    for r in rows:
        name = family_key(r.model, r.model_version)
        # An unrecognised version is treated as current (TIP 3.7): never discount evidence by accident.
        superseded = normalize(r.model_version) != current_version.get((job.job_id, name), normalize(r.model_version))
        f = families[name]
        f.n_runs += r.n
        f.failures += r.failures
        sums = ((r.total_s_superseded, r.squares_s_superseded, r.passing_s_superseded, r.cost_s_superseded,
                 r.priced_s_superseded) if superseded
                else (r.total_s_current, r.squares_s_current, r.passing_s_current, r.cost_s_current, r.priced_s_current))
        f.total, f.squares, f.passing, f.cost, f.priced = (
            a + b for a, b in zip((f.total, f.squares, f.passing, f.cost, f.priced), sums, strict=True))
        if r.provider:
            f.providers[r.provider.lower()] += r.n
        if (r.model, r.model_version) not in f.versions:
            f.versions.append((r.model, r.model_version))

    latest = (
        await session.execute(
            select(Run.model, Run.model_version)
            .where(Run.job_id == job.job_id, Run.run_kind == "PRODUCTION", Run.state.not_in(UNCOUNTED_STATES))
            .order_by(Run.created_at.desc()).limit(1)
        )
    ).first()
    current_model = family_key(*latest) if latest else None

    # The current model is listed even when none of its runs is checked yet (e.g. awaiting labels).
    names = set(families) | ({current_model} if current_model else set())
    versions = {name: current_version.get((job.job_id, name), name) for name in names}
    # Status for the provider this job's runs name: providers retire the same model on different dates.
    served_by = {name: (families[name].providers.most_common(1)[0][0] if families[name].providers else None)
                 for name in names}
    status = await lifecycles(session, {**{n: served_by[n] for n in names},
                                        **{versions[n]: served_by[n] for n in names}}, today=now.date())
    inputs = []
    for name in sorted(names):
        f = families[name]
        s = Sample(pass_rate=f.passing / f.total, effective_n=f.total * f.total / f.squares,
                   evidence_weight=f.total) if f.total > 0 else None
        life = status[versions[name]] if status[versions[name]] is not UNKNOWN else status[name]
        # Mean over priced runs; a model with no priced run has no cost, so it can never look cheapest.
        mean_cost = f.cost / f.priced if f.priced else None
        inputs.append(ModelInput(
            model=name, model_version=versions[name], n_runs=f.n_runs, failures=f.failures, sample=s,
            mean_cost_usd=mean_cost,
            catalog_status=life.status, shutdown_date=life.shutdown_date, catalog_note=life.note,
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
    shown_versions = [v for name in shown for v in families[name].versions] if shown else []
    failing = (
        await session.execute(
            select(Run.run_id, Run.model, Run.model_version, Run.outcome_reason, Run.created_at)
            .where(*_counted(job), Run.outcome == "FAIL", tuple_(Run.model, Run.model_version).in_(shown_versions))
            .order_by(Run.created_at.desc()).limit(FAILING_RUNS_SHOWN)
        )
    ).all() if shown_versions else []
    run_ids = (await session.execute(select(Run.run_id).where(*_counted(job)))).scalars().all() if with_run_ids else []
    return JobRecommendation(
        job=job.name, decision=decision, n_runs=sum(f.n_runs for f in families.values()),
        evidence_weight=sum(f.total for f in families.values()),
        failing_runs=[
            FailingRun(r.run_id, family_key(r.model, r.model_version), r.model_version, r.outcome_reason, r.created_at)
            for r in failing
        ],
        computed_at=now, settings=settings, run_ids=list(run_ids),
        forecast=forecast(decision, runs_per_month, confidence=settings.confidence_level),
    )
