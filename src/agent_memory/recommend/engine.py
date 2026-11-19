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
from ..models import Job, Recommendation, Run
from ..options import option_name, split_option
from ..pipeline.decay import current_versions, family_key
from ..pipeline.scoring import stability_days
from ..versions import normalize
from .app_chosen import APP_CHOSEN_REASON, is_app_chosen
from . import evidence as ev
from .promising import Group, Promising, is_promising, needed_per_model, weighted, ONE_SIDED_95
from .stats import Sample, assess, confidence_words, difference, wilson, z_for

Verdict = Literal["HOLD", "DOWNGRADE", "SWITCH", "INSUFFICIENT_EVIDENCE"]
Status = Literal["GOOD_ENOUGH", "UNSURE", "CLEARLY_WORSE", "BELOW_FLOOR", "RETIRED"]
FAILING_RUNS_SHOWN = 5
MIN_SAVING = 0.05  # a cheaper model must cost at least 5% less per correct answer to be worth advising (F11)
MIN_DAYS_FOR_VOLUME = 7.0  # the same rule as the budget projection: under 7 days of calls is "still learning"
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
    history: list[Group] | None = None  # checked answers over time, only for the Promising level
    # How the counted runs break down (None = not measured, never 0): drives the compare chart's "missing data" notes.
    priced_runs: int | None = None
    unpriced_runs: int | None = None
    retest_runs: int | None = None  # of the counted runs, how many were re-tests (still the user's own prompts)
    cost_p50_usd: float | None = None  # typical call (median) over the last SPREAD_DAYS days; needs MIN_SPREAD_RUNS
    cost_p90_usd: float | None = None  # the expensive tail: 1 call in 10 costs at least this


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
    promising: Promising | None = None  # 'worth a trial': never advice, never a saving
    sure_enough_needed: int | None = None  # checked answers per model the Proven rule would need at today's rates
    sure_enough_have: float | None = None  # what the thinner of the two compared models has now


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


def _stage_two(models: list[ModelEvidence], current: ModelEvidence | None, *, margin: float, z: float,
               floor: float) -> tuple[int | None, float | None]:
    """Stage 2 of the progress bar: checked answers per model the Proven rule would need at today's rates,
    and what the thinner of the two compared models has now. (None, None) when there is nothing to compare."""
    if current is None or current.sample is None:
        return None, None
    others = [m for m in models if m is not current and m.sample is not None and m.catalog_status != "RETIRED"]
    if not others:
        return None, None
    cand = min(others, key=lambda m: (m.cost_per_success_usd is None, m.cost_per_success_usd or 0.0,
                                      -m.sample.evidence_weight))
    needed = needed_per_model(cand.sample.pass_rate, current.sample.pass_rate, margin=margin, z=z, floor=floor)
    return needed, min(cand.sample.effective_n, current.sample.effective_n)


def _promising(models: list[ModelEvidence], current: ModelEvidence, *, now: datetime, margin: float,
               stability_days: float, proven_z: float, floor: float) -> Promising | None:
    """The cheapest cheaper model that has earned 'worth a trial' against the model in use, if any."""
    if not current.history:
        return None
    cands = [m for m in models if m is not current and m.history and m.sample is not None
             and m.catalog_status != "RETIRED" and _cheaper(m, current)]
    for m in sorted(cands, key=lambda m: m.cost_per_success_usd):
        if not is_promising(m.history, current.history, now=now, margin=margin, stability_days=stability_days,
                            proven_z=proven_z):
            continue
        c, r = weighted(m.history, now, stability_days), weighted(current.history, now, stability_days)
        low, high = difference(c, r, ONE_SIDED_95)
        need = needed_per_model(c.pass_rate, r.pass_rate, margin=margin, z=proven_z, floor=floor)
        more = None if need is None else max(0, need - int(c.effective_n))
        more = None if more is None else (int(round(more / 10.0)) * 10 or (10 if more > 0 else 0))
        return Promising(model=m.model, current=current.model, gap=c.pass_rate - r.pass_rate, low=low,
                         high=high, more_needed=more)
    return None


def decide(
    inputs: list[ModelInput], current_model: str | None, *, floor: float, margin: float, confidence: float,
    switch_confidence: float | None = None, advised: str | None = None, now: datetime | None = None,
    stability_days: float = 7.5,
) -> Decision:
    """The verdict for one job, from per-model evidence and the model production uses now.

    `advised` is the cheaper model the job was last told to move to, if any. Advising a move to any
    other model needs `switch_confidence` (when higher than `confidence`); keeping advice already given
    needs only `confidence`. The gap between the two stops the answer flapping on day-to-day noise."""
    z = z_for(confidence)
    if current_model and is_app_chosen(current_model):
        # The app picks the model, so there is nothing to switch to: no verdict to act on, just the reason.
        own = [ModelEvidence(**vars(m)) for m in inputs if m.model == current_model]
        cur = own[0] if own else None
        return Decision("HOLD", cur, cur, cur, own, warnings=[APP_CHOSEN_REASON])
    # App labels are never offered as a model to switch to.
    models = [ModelEvidence(**vars(m)) for m in inputs if not is_app_chosen(m.model)]
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
        needed, have = _stage_two(models, current, margin=margin, z=z_for(switch_confidence or confidence),
                                  floor=floor)
        return Decision(
            "INSUFFICIENT_EVIDENCE", current, None, None, models, progress=min(1.0, best / floor) if floor else 1.0,
            next_step="Record more runs, or run a re-test to gather evidence sooner",
            sure_enough_needed=needed, sure_enough_have=have,
        )

    reference = max(judged, key=lambda m: (m.pass_rate_low, m.sample.pass_rate))
    for m in judged:
        if m is reference:
            m.status, m.why = "GOOD_ENOUGH", "Highest pass rate we can be sure of"
            continue
        m.status = assess(m.sample, reference.sample, margin=margin, z=z)
        m.why = {
            "GOOD_ENOUGH": f"At most {_points(margin)} worse than {reference.model}, with {confidence_words(confidence)}",
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
        if reference.sample.pass_rate <= 0 and reference.mean_cost_usd is not None:
            # F12: the price is known; what is undefined is the cost of a correct answer when none is correct.
            warnings.append(f"{reference.model} passed none of its checked answers, so its cost per correct "
                            "answer cannot be worked out and nothing is advised")
        else:
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
        new_advice = (switch_confidence is not None and switch_confidence > confidence
                      and recommended.model != advised)
        z_move = z_for(switch_confidence) if new_advice else z
        if current.status == "GOOD_ENOUGH" and current.cost_per_success_usd is None:
            # F8: "cheaper" needs a price for the model in use as well.
            warnings.append(f"No price is known for {current.model}, the model in use, so a cheaper model "
                            "cannot be advised")
            verdict, recommended = "HOLD", current
        elif (current.cost_per_success_usd is not None and recommended.cost_per_success_usd is not None
              and current.status == "GOOD_ENOUGH"
              and recommended.cost_per_success_usd > current.cost_per_success_usd * (1 - MIN_SAVING)):
            # F11: a saving of a fraction of a percent is noise, not advice.
            verdict, recommended = "HOLD", current
        elif _within(recommended, current, margin, z_move):
            verdict = "DOWNGRADE"  # what qualifies and costs less per success
        else:
            if new_advice and _within(recommended, current, margin, z):
                warnings.append(
                    f"{recommended.model} is likely within {_points(margin)} of {current.model}, the model in use, "
                    f"but advising a switch needs {confidence_words(switch_confidence)}; a re-test of "
                    f"{recommended.model} would settle it"
                )
                why = (f"Within {_points(margin)} of {current.model} with {confidence_words(confidence)}, not yet the "
                       f"{confidence_words(switch_confidence)} a switch needs; a re-test would settle it")
            else:
                warnings.append(
                    f"Not yet sure {recommended.model} is within {_points(margin)} of {current.model}, the model in "
                    f"use; a re-test of {recommended.model} would settle it"
                )
                why = (f"Not yet sure it is within {_points(margin)} of {current.model}, the model in use; "
                       "a re-test would settle it")
            settle.append(recommended.model)
            # Its status says so too: "good enough" next to the reference is not good enough to replace the
            # model in use, and a re-test of it must not stop early on that status before it settles this.
            recommended.status, recommended.eligible, recommended.why = "UNSURE", False, why
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
    worth_a_trial = None
    if verdict == "HOLD" and now is not None:
        worth_a_trial = _promising(models, current, now=now, margin=margin, stability_days=stability_days,
                                   proven_z=z_for(switch_confidence or confidence), floor=floor)
    return Decision(verdict, current, recommended, reference, models, retest_candidates=retest,
                    warnings=warnings, next_step=next_step, promising=worth_a_trial)


@dataclass
class Forecast:
    """What switching would change per month, if next month looks like the last 30 days."""

    runs_per_month: int
    monthly_saving_usd: float  # change of the bill at the same call volume: runs x (cost per call now - recommended)
    extra_failures_per_month: float
    extra_failures_low: float  # the interval of the pass-rate difference, in failures per month
    extra_failures_high: float


def monthly_volume(calls_30d: int, first_call: datetime | None, now: datetime) -> int | None:
    """Calls per month on the model in use. A model live under 30 days is scaled up to a month; under 7 days
    there is no honest figure yet (None = still learning), the same rule as the budget projection."""
    if first_call is None:
        return None
    days = (now - first_call).total_seconds() / 86400.0
    if days < MIN_DAYS_FOR_VOLUME:
        return None
    return int(round(calls_30d * 30.0 / days)) if days < 30.0 else calls_30d


def forecast(decision: Decision, runs_per_month: int | None, *, confidence: float) -> Forecast | None:
    """monthly saving = runs per month x (mean cost per call now - recommended): the change in the bill at the
    same call volume (F9; the old figure priced only the correct answers, which is not what the bill does);
    extra failures = (pass rate now - recommended) x runs per month, with its interval."""
    rec, cur = decision.recommended, decision.current
    if runs_per_month is None:
        return None
    if decision.verdict not in ("DOWNGRADE", "SWITCH") or rec is None or cur is None or rec is cur:
        return None
    if None in (rec.mean_cost_usd, cur.mean_cost_usd) or not (rec.sample and cur.sample):
        return None
    low, high = difference(cur.sample, rec.sample, z_for(confidence))  # current minus recommended
    return Forecast(
        runs_per_month=runs_per_month,
        monthly_saving_usd=(cur.mean_cost_usd - rec.mean_cost_usd) * runs_per_month,
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
    check_kind: str = ""
    window_from: datetime | None = None  # first and last checked answer counted
    window_to: datetime | None = None
    state: str = "enough"  # evidence.State: enough / not_enough / not_comparable / no_recommendation
    state_note: str = ""
    limitations: list[str] = field(default_factory=list)
    paired: ev.PairedEvidence | None = None  # same prompts through both models, when re-tests made pairs


def _spread_fields(s: dict | None) -> dict:
    """The breakdown counts, and the cost percentiles only when enough priced calls stand behind them."""
    if not s:
        return {}
    enough = s["w"] >= MIN_SPREAD_RUNS and s.get("p50") is not None
    return {"priced_runs": s["n"] - s["unpriced"], "unpriced_runs": s["unpriced"], "retest_runs": s["retest"],
            "cost_p50_usd": float(s["p50"]) if enough else None, "cost_p90_usd": float(s["p90"]) if enough else None}


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
    SELECT model, model_version, provider, effort, passed, cost IS NOT NULL AS priced, b,
           count(*) AS n, sum(d) AS sd, sum(d * d) AS sdd,
           coalesce(sum(cost), 0) AS sc, coalesce(sum(cost * d), 0) AS scd, coalesce(sum(cost * d * d), 0) AS scdd
    FROM (
        SELECT model, model_version, provider, effort, passed, cost, floor(age * 24) / 24 AS b,
               age - floor(age * 24) / 24 AS d
        FROM (
            SELECT model, model_version, provider, effort, outcome = 'PASS' AS passed, cost_usd::float8 AS cost,
                   greatest(extract(epoch FROM (:now - created_at))::float8 / 86400.0, 0) AS age
            FROM runs
            WHERE job_id = :job AND outcome IN ('PASS', 'FAIL') AND state NOT IN ('ARCHIVED', 'INGESTION_FAILED')
              AND invalid_at IS NULL
            OFFSET 0
        ) AS aged
        OFFSET 0
    ) AS split
    GROUP BY 1, 2, 3, 4, 5, 6, 7
)
SELECT model, model_version, provider, effort, sum(n) AS n, coalesce(sum(n) FILTER (WHERE NOT passed), 0) AS failures,
       {_weighted("s_current")}, {_weighted("s_superseded")}
FROM buckets
GROUP BY 1, 2, 3, 4
""").bindparams(bindparam("now", type_=TIMESTAMP(timezone=True)), bindparam("job", type_=UUID(as_uuid=True)),
                bindparam("s_current", type_=Float), bindparam("s_superseded", type_=Float))


SPREAD_DAYS = 60
MIN_SPREAD_RUNS = 20  # under this many priced calls a percentile says nothing
SPREAD = text("""
SELECT model, model_version, effort,
       count(*) AS n,
       count(*) FILTER (WHERE cost_usd IS NULL) AS unpriced,
       count(*) FILTER (WHERE run_kind = 'RETEST') AS retest,
       count(*) FILTER (WHERE cost_usd IS NOT NULL AND created_at > :since) AS windowed,
       percentile_cont(0.5) WITHIN GROUP (ORDER BY cost_usd::float8)
           FILTER (WHERE cost_usd IS NOT NULL AND created_at > :since) AS p50,
       percentile_cont(0.9) WITHIN GROUP (ORDER BY cost_usd::float8)
           FILTER (WHERE cost_usd IS NOT NULL AND created_at > :since) AS p90
FROM runs
WHERE job_id = :job AND outcome IN ('PASS', 'FAIL') AND state NOT IN ('ARCHIVED', 'INGESTION_FAILED')
  AND invalid_at IS NULL AND created_at <= :now
GROUP BY 1, 2, 3
""").bindparams(bindparam("now", type_=TIMESTAMP(timezone=True)), bindparam("since", type_=TIMESTAMP(timezone=True)),
                bindparam("job", type_=UUID(as_uuid=True)))


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
    # Checked answers by hour, for the 'worth a trial' level only (promising.py): a few rows per model-day.
    hour = func.date_trunc("hour", Run.created_at)
    hist_rows = (
        await session.execute(
            select(Run.model, Run.model_version, Run.effort, hour, func.count(),
                   func.count().filter(Run.outcome == "PASS"))
            .where(*_counted(job), Run.created_at <= now).group_by(Run.model, Run.model_version, Run.effort, hour)
        )
    ).all()
    history: dict[str, list[Group]] = defaultdict(list)
    for m, v, e, at, n, passes in hist_rows:
        history[option_name(family_key(m, v), e)].append(Group(at=at, n=int(n), passes=int(passes)))

    # Counts and cost percentiles per option. Percentiles cannot be merged across versions, so the version with the
    # most priced calls in the window speaks for the option (the compare page says "the most-used version").
    spread: dict[str, dict] = {}
    for sm, sv, se, sn, sun, sre, sw, p50, p90 in (
        await session.execute(SPREAD, {"job": job.job_id, "now": now, "since": now - timedelta(days=SPREAD_DAYS)})
    ).all():
        s = spread.setdefault(option_name(family_key(sm, sv), se), {"n": 0, "unpriced": 0, "retest": 0, "w": -1})
        s["n"] += int(sn)
        s["unpriced"] += int(sun)
        s["retest"] += int(sre)
        if int(sw) > s["w"]:
            s["w"], s["p50"], s["p90"] = int(sw), p50, p90

    # One entry per option: a model family, at the reasoning effort its runs name (options.py).
    families: dict[str, _Family] = defaultdict(_Family)
    for r in rows:
        base = family_key(r.model, r.model_version)
        name = option_name(base, r.effort)
        # An unrecognised version is treated as current (TIP 3.7): never discount evidence by accident.
        superseded = normalize(r.model_version) != current_version.get((job.job_id, base), normalize(r.model_version))
        f = families[name]
        f.n_runs += int(r.n)  # SUM() comes back from Postgres as Decimal
        f.failures += int(r.failures)
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
            select(Run.model, Run.model_version, Run.effort)
            .where(Run.job_id == job.job_id, Run.run_kind == "PRODUCTION", Run.state.not_in(UNCOUNTED_STATES))
            .order_by(Run.created_at.desc()).limit(1)
        )
    ).first()
    current_model = option_name(family_key(latest.model, latest.model_version), latest.effort) if latest else None

    # The current model is listed even when none of its runs is checked yet (e.g. awaiting labels).
    names = set(families) | ({current_model} if current_model else set())
    bases = {name: split_option(name)[0] for name in names}
    versions = {name: current_version.get((job.job_id, bases[name]), bases[name]) for name in names}
    # Status for the provider this job's runs name: providers retire the same model on different dates.
    served_by = {name: (families[name].providers.most_common(1)[0][0] if families[name].providers else None)
                 for name in names}
    status = await lifecycles(session, {**{bases[n]: served_by[n] for n in names},
                                        **{versions[n]: served_by[n] for n in names}}, today=now.date())
    inputs = []
    for name in sorted(names):
        f = families[name]
        s = Sample(pass_rate=f.passing / f.total, effective_n=f.total * f.total / f.squares,
                   evidence_weight=f.total) if f.total > 0 else None
        life = status[versions[name]] if status[versions[name]] is not UNKNOWN else status[bases[name]]
        # Mean over priced runs; a model with no priced run has no cost, so it can never look cheapest.
        mean_cost = f.cost / f.priced if f.priced else None
        inputs.append(ModelInput(
            model=name, model_version=versions[name], n_runs=f.n_runs, failures=f.failures, sample=s,
            mean_cost_usd=mean_cost,
            catalog_status=life.status, shutdown_date=life.shutdown_date, catalog_note=life.note,
            history=history.get(name),
            **_spread_fields(spread.get(name)),
        ))
    advised = (
        await session.execute(
            select(Recommendation.model).where(Recommendation.job_id == job.job_id, Recommendation.invalid_at.is_(None),
                                               Recommendation.verdict == "DOWNGRADE")
        )
    ).scalar_one_or_none()
    decision = decide(
        inputs, current_model, floor=settings.evidence_floor,
        margin=settings.tolerance_points, confidence=settings.confidence_level,
        switch_confidence=settings.switch_confidence, advised=advised, now=now, stability_days=stab[False],
    )

    # Could the two models be compared fairly? Only ever tried on different prompt versions means a difference
    # could be the prompt. Then no move is advised (evidence.not_comparable); the verdict becomes HOLD.
    versions_by_option: dict[str, set[str]] = defaultdict(set)
    for m, v, e, pv in (
        await session.execute(
            select(Run.model, Run.model_version, Run.effort, Run.prompt_version)
            .where(*_counted(job), Run.prompt_version.is_not(None)).distinct()
        )
    ).all():
        versions_by_option[option_name(family_key(m, v), e)].add(pv)
    moving = decision.recommended.model if decision.recommended else None
    cur_name = decision.current.model if decision.current else None
    rivals = [n for n in (moving, decision.reference.model if decision.reference else None,
                          decision.promising.model if decision.promising else None, *decision.retest_candidates)
              if n and n != cur_name]
    unfair = next((r for r in (ev.not_comparable(versions_by_option, cur_name, n) for n in rivals) if r), None)
    if unfair and decision.verdict in ("DOWNGRADE", "SWITCH"):
        decision.warnings.append(unfair)
        decision.verdict, decision.recommended = "HOLD", decision.current
        decision.next_step = "Run both models on the same prompt version, then re-check"

    # The window the checked answers span, and pairs: re-tests replay real prompts, so a candidate and the model
    # in use can have answered the SAME prompts, which is compared as pairs (evidence.paired_evidence).
    win = (await session.execute(
        select(func.min(Run.created_at), func.max(Run.created_at)).where(*_counted(job), Run.created_at <= now)
    )).one()
    other = next((n for n in (moving if moving != cur_name else None,
                              decision.promising.model if decision.promising else None,
                              *decision.retest_candidates) if n and n != cur_name), None)
    paired = None
    if cur_name and other:
        outcomes: dict[str, dict[str, bool]] = defaultdict(dict)
        hashes = select(Run.prompt_hash).where(*_counted(job), Run.run_kind == "RETEST")
        for h, m, v, e, o in (
            await session.execute(
                select(Run.prompt_hash, Run.model, Run.model_version, Run.effort, Run.outcome)
                .where(*_counted(job), Run.prompt_hash.in_(hashes), Run.created_at <= now)
                .order_by(Run.created_at)  # the latest answer to a prompt stands
            )
        ).all():
            outcomes[option_name(family_key(m, v), e)][h] = o == "PASS"
        paired = ev.paired_evidence(other, cur_name, outcomes, z_for(settings.confidence_level))

    # The monthly volume is the calls that ran on the model in use, not every call of the job: calls on
    # the cheaper candidate itself are not spend the switch would change.
    per_model = (
        await session.execute(
            select(Run.model, Run.model_version, Run.effort,
                   func.count().filter(Run.created_at > now - timedelta(days=30)), func.min(Run.created_at))
            .where(Run.job_id == job.job_id, Run.run_kind == "PRODUCTION", Run.created_at <= now)
            .group_by(Run.model, Run.model_version, Run.effort)
        )
    ).all()
    mine = [(int(n), first) for m, v, e, n, first in per_model if option_name(family_key(m, v), e) == current_model]
    runs_per_month = monthly_volume(sum(n for n, _ in mine), min((f for _, f in mine), default=None), now)
    if (runs_per_month is None and mine and decision.verdict in ("DOWNGRADE", "SWITCH")):
        decision.warnings.append("Still learning how much this job runs (under 7 days of calls on the model in "
                                 "use), so there is no monthly figure yet")

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
    n_all = sum(f.n_runs for f in families.values())
    basis = ev.basis_for(job.check_kind)
    window_days = (win[1] - win[0]).total_seconds() / 86400.0 if win[0] and win[1] else None
    eff = [m.sample.effective_n for m in decision.models if m.sample]
    ref = decision.reference
    state, state_note = ev.classify(
        decision.verdict, current_known=decision.current is not None,
        app_chosen=bool(decision.current and is_app_chosen(decision.current.model)),
        reference_passes_none=bool(ref and ref.sample and ref.sample.pass_rate <= 0),
        open_questions=any(m.status in ("UNSURE", "BELOW_FLOOR") for m in decision.models if m is not decision.current)
        or bool(decision.retest_candidates),
        not_comparable_reason=unfair,
    )
    return JobRecommendation(
        job=job.name, decision=decision, n_runs=n_all,
        evidence_weight=sum(f.total for f in families.values()),
        failing_runs=[
            FailingRun(r.run_id, family_key(r.model, r.model_version), r.model_version, r.outcome_reason, r.created_at)
            for r in failing
        ],
        computed_at=now, settings=settings, run_ids=list(run_ids),
        forecast=forecast(decision, runs_per_month, confidence=settings.confidence_level),
        check_kind=job.check_kind, window_from=win[0], window_to=win[1], state=state, state_note=state_note,
        limitations=ev.limitations(unpaired=paired is None, effective_n=sum(eff) if eff else None, n_runs=n_all,
                                   window_days=window_days, basis=basis),
        paired=paired,
    )
