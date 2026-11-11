"""RegressionDetector (technical plan 3.4): did a model change quietly make results worse?

VERSION_REGRESSION   For each model family a job uses, the version production uses now is compared
                     with the version it replaced: a one-sided two-proportion z-test on their checked
                     runs. Flagged when the test passes the sequential boundary below AND the drop is
                     at least `regression_min_drop`, with at least `regression_min_runs` runs on each
                     side. The job's recommendation is then superseded with the reason REGRESSION
                     (never overwritten), and an alert is raised.

SILENT_DROP          Providers can change behaviour under an unchanged name. For the current version,
(Should)             daily pass rates over the last 28 days (at least 20 days with runs) are split in
                     half; a one-sided CUSUM over the second half against the first half's rate must
                     cross its threshold, and the halves must differ with p < `silent_alpha` and by at
                     least the minimum drop.

The sweep runs every day, and every look is another chance for noise to cross a fixed p < 0.05 line:
in simulation that rule raised a false alarm on 7% of unchanged models. So the version test uses an
O'Brien-Fleming-style boundary: z must reach z_alpha x sqrt(ref_runs / n) while the new version has
n < ref_runs runs, and z_alpha after, but never more than p < 0.0001 asks. Early noise cannot cross
it, and an overwhelming drop is still flagged on the first day it shows.

Both compare like with like: runs are split by input size (the BANDS of the insights page: under 8k,
8k to 32k, over 32k tokens in), each band is compared with itself, and the bands are weighted by the
later side's mix (`stratified_drop_test`). Without that, inputs that simply got longer read as a
regression: in simulation, with long documents growing from 10% to 50% of traffic and no model
change, the plain comparison raised a false alarm in 14 of 20 version trials and 9 of 20 silent ones
(reports/regression_detection.md). With one band in use it is exactly the plain two-proportion test.

Both run with an explicit `now`, so the simulated-time harness can drive them through weeks in minutes.
"""

from __future__ import annotations

import math
from collections import defaultdict
from statistics import NormalDist
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta

from sqlalchemy import case, func, select, tuple_
from sqlalchemy.ext.asyncio import AsyncSession

from ..alerts.service import raise_alert
from ..config import Settings, get_settings
from ..insights.service import BANDS
from ..models import Alert, Job, Run
from ..versions import normalize
from .consolidation import consolidate_job
from .decay import current_versions, family_key

OLD_VERSION_WINDOW = 1000  # the replaced version's most recent runs are what it is judged by
SILENT_WINDOW_DAYS = 28
SILENT_MIN_DAILY_RUNS = 5
SILENT_MIN_DAYS = 20
STRICTEST_P = 0.0001  # the early boundary never asks for more than this
FAILING_RUNS_IN_ALERT = 10
BAND_EDGES = tuple(high for _, _, high in BANDS if high is not None)  # 8k, 32k tokens in


def drop_test(pass_old: int, n_old: int, pass_new: int, n_new: int) -> tuple[float, float]:
    """One-sided two-proportion z-test that the new rate is lower. Returns (drop, p-value)."""
    p_old, p_new = pass_old / n_old, pass_new / n_new
    pooled = (pass_old + pass_new) / (n_old + n_new)
    se = math.sqrt(pooled * (1 - pooled) * (1 / n_old + 1 / n_new))
    drop = p_old - p_new
    if se == 0:
        return drop, 0.0 if drop > 0 else 1.0
    return drop, 0.5 * math.erfc((drop / se) / math.sqrt(2))


def stratified_drop_test(strata: list[tuple[int, int, int, int]]) -> tuple[float, float]:
    """One-sided test that the later rate is lower, comparing each input-size band with itself.

    `strata` holds (passed before, runs before, passed after, runs after) per band. The drop is the
    average of the bands' drops weighted by the later side's runs (direct standardization to today's
    mix), and its variance the matching weighted sum of each band's pooled two-proportion variance.
    With a single band this is `drop_test`. Returns (drop, p-value)."""
    total = sum(s[3] for s in strata)
    if total == 0:
        return 0.0, 1.0
    drop = variance = 0.0
    for p_old, n_old, p_new, n_new in strata:
        w = n_new / total
        drop += w * (p_old / n_old - p_new / n_new)
        pooled = (p_old + p_new) / (n_old + n_new)
        variance += w * w * pooled * (1 - pooled) * (1 / n_old + 1 / n_new)
    if variance <= 0:
        return drop, 0.0 if drop > 0 else 1.0
    return drop, 0.5 * math.erfc((drop / math.sqrt(variance)) / math.sqrt(2))


def boundary_alpha(alpha: float, n: int, ref_runs: int) -> float:
    """The p-value a daily check must beat with n runs on the new version: alpha once n >= ref_runs,
    stricter before (down to STRICTEST_P), so that checking every day keeps the overall false-alarm
    rate near alpha."""
    if n >= ref_runs:
        return alpha
    z = NormalDist().inv_cdf(1 - alpha) * math.sqrt(ref_runs / max(n, 1))
    return max(0.5 * math.erfc(z / math.sqrt(2)), min(alpha, STRICTEST_P))


def cusum_alarm(daily: list[tuple[int, int]], baseline: float | list[float], *, k: float = 0.5,
                h: float = 4.0) -> bool:
    """One-sided standardized CUSUM on daily pass rates.

    Each day's shortfall is measured in standard errors, z = (expected - rate) / sqrt(b(1-b)/n), so a
    day with few runs counts for less; S = max(0, S + z - k), alarm when S >= h. k = 0.5 and h = 4
    are the textbook choice: one noisy day cannot cross it, a sustained drop does within days.
    `baseline` is one expected rate for every day, or one per day (what the earlier rates predict for
    that day's own mix of inputs).
    """
    expected = baseline if isinstance(baseline, list) else [baseline] * len(daily)
    s = 0.0
    for (passed, n), e in zip(daily, expected):
        b = min(max(e, 1e-6), 1 - 1e-6)
        z = (e - passed / n) / math.sqrt(b * (1 - b) / n)
        s = max(0.0, s + z - k)
        if s >= h:
            return True
    return False


@dataclass
class SweepResult:
    alerts: list[Alert] = field(default_factory=list)
    checked_families: int = 0


@dataclass
class _Version:
    """One (family, normalized version)'s checked runs, as daily sums per input-size band from Postgres."""

    raw: set = field(default_factory=set)  # the (model, model_version) pairs stored under it
    first_seen: datetime | None = None
    # date -> band -> [passed, runs]
    daily: dict = field(default_factory=lambda: defaultdict(lambda: defaultdict(lambda: [0, 0])))

    @property
    def runs(self) -> int:
        return sum(n for bands in self.daily.values() for _, n in bands.values())

    @property
    def passed(self) -> int:
        return sum(p for bands in self.daily.values() for p, _ in bands.values())

    def bands(self, days=None) -> dict[int, list[int]]:
        """band -> [passed, runs] over the given days (all days when None)."""
        out: dict[int, list[int]] = defaultdict(lambda: [0, 0])
        for d in (self.daily if days is None else days):
            for band, (p, n) in self.daily[d].items():
                out[band][0] += p
                out[band][1] += n
        return out


def _counted(job: Job, now: datetime):
    return (Run.job_id == job.job_id, Run.outcome.in_(("PASS", "FAIL")), Run.invalid_at.is_(None),
            Run.created_at <= now)


def _band_of():
    """The run's input-size band (0, 1, 2 for the BANDS edges), computed in Postgres."""
    return case(*((Run.tokens_in < edge, i) for i, edge in enumerate(BAND_EDGES)), else_=len(BAND_EDGES))


async def _versions(session: AsyncSession, job: Job, now: datetime) -> dict[tuple[str, str], _Version]:
    """(family, normalized version) -> its daily pass counts per input-size band. Postgres sums per stored
    model, version, UTC day and band, so this reads a few hundred rows however many runs the job has."""
    day = func.date_trunc("day", func.timezone("UTC", Run.created_at))
    band = _band_of()
    rows = (
        await session.execute(
            select(Run.model, Run.model_version, day.label("day"), band.label("band"), func.count(),
                   func.count().filter(Run.outcome == "PASS"), func.min(Run.created_at))
            .where(*_counted(job, now)).group_by(Run.model, Run.model_version, day, band)
        )
    ).all()
    out: dict[tuple[str, str], _Version] = defaultdict(_Version)
    for model, version, on, b, n, passed, first in rows:
        v = out[(family_key(model, version), normalize(version))]
        v.raw.add((model, version))
        v.first_seen = first if v.first_seen is None else min(v.first_seen, first)
        v.daily[on.date()][b][0] += passed
        v.daily[on.date()][b][1] += n
    return out


async def _latest(session: AsyncSession, job: Job, version: _Version, now: datetime,
                  limit: int) -> dict[int, list[int]]:
    """band -> [passed, runs] over a version's most recent `limit` checked runs."""
    recent = (
        select(Run.outcome, _band_of().label("band"))
        .where(*_counted(job, now), tuple_(Run.model, Run.model_version).in_(list(version.raw)))
        .order_by(Run.created_at.desc()).limit(limit).subquery()
    )
    rows = (await session.execute(
        select(recent.c.band, func.count().filter(recent.c.outcome == "PASS"), func.count())
        .group_by(recent.c.band))).all()
    return {int(b): [int(p), int(n)] for b, p, n in rows}


async def _failing(session: AsyncSession, job: Job, version: _Version, now: datetime) -> list[str]:
    rows = (await session.execute(
        select(Run.run_id).where(*_counted(job, now), Run.outcome == "FAIL",
                                 tuple_(Run.model, Run.model_version).in_(list(version.raw)))
        .order_by(Run.created_at.desc()).limit(FAILING_RUNS_IN_ALERT))).scalars().all()
    return [str(r) for r in rows]


def _strata(before: dict[int, list[int]], after: dict[int, list[int]]) -> list[tuple[int, int, int, int]]:
    """(passed before, runs before, passed after, runs after) for each band seen on both sides."""
    return [(before[b][0], before[b][1], after[b][0], after[b][1])
            for b in sorted(after) if b in before and before[b][1] > 0 and after[b][1] > 0]


async def sweep_job(
    session: AsyncSession, job: Job, *, now: datetime | None = None, settings: Settings | None = None
) -> SweepResult:
    settings = settings or get_settings()
    now = now or datetime.now(UTC)
    result = SweepResult()
    by_version = await _versions(session, job, now)
    current = await current_versions(session, job.job_id)
    families: dict[str, list[str]] = defaultdict(list)
    for fam, version in by_version:
        families[fam].append(version)

    regressed = False
    for fam, versions in families.items():
        result.checked_families += 1
        now_version = current.get((job.job_id, fam))
        if now_version not in versions:
            continue
        new = by_version[(fam, now_version)]
        older = [v for v in versions if v != now_version and by_version[(fam, v)].first_seen < new.first_seen]

        if older:  # VERSION_REGRESSION against the version it replaced, on the same kinds of input
            previous = max(older, key=lambda v: by_version[(fam, v)].first_seen)
            old_bands = await _latest(session, job, by_version[(fam, previous)], now, OLD_VERSION_WINDOW)
            strata = _strata(old_bands, new.bands())
            n_old, n_new = sum(s[1] for s in strata), sum(s[3] for s in strata)
            if strata and min(n_old, n_new) >= settings.regression_min_runs:
                drop, p = stratified_drop_test(strata)
                limit = boundary_alpha(settings.regression_alpha, n_new, settings.regression_ref_runs)
                if p < limit and drop >= settings.regression_min_drop:
                    new_rate = sum(s[2] for s in strata) / n_new
                    old_rate = new_rate + drop  # the old version on today's mix of inputs
                    failing = await _failing(session, job, new, now)
                    alert = await raise_alert(
                        session, job, "VERSION_REGRESSION", f"VERSION_REGRESSION|{fam}|{now_version}",
                        {"model": fam, "old_version": previous, "new_version": now_version,
                         "old_pass_rate": old_rate, "new_pass_rate": new_rate,
                         "n_old": n_old, "n_new": n_new, "drop": drop, "p_value": p, "failing_run_ids": failing,
                         "same_input_mix": len(strata) > 1,
                         "summary": f"{fam}: pass rate fell from {old_rate:.1%} to {new_rate:.1%} "
                                    f"after {previous} was replaced by {now_version}"
                                    + (" (compared on the same mix of input sizes)" if len(strata) > 1 else "")},
                        now=now,
                    )
                    if alert:
                        result.alerts.append(alert)
                        regressed = True

        # SILENT_DROP within the current version. Whole UTC days within the last 28 days (the day the
        # window starts in counts when it starts at midnight; a part-day would be compared as if whole).
        start = now - timedelta(days=SILENT_WINDOW_DAYS)
        first_day = start.date() if start.time() == datetime.min.time() else start.date() + timedelta(days=1)
        days = [d for d in sorted(new.daily)
                if d >= first_day and sum(n for _, n in new.daily[d].values()) >= SILENT_MIN_DAILY_RUNS]
        if len(days) >= SILENT_MIN_DAYS:
            first, second = days[: len(days) // 2], days[len(days) // 2:]
            before = new.bands(first)
            strata = _strata(before, new.bands(second))
            if strata:
                drop, p = stratified_drop_test(strata)
                # Each later day against what the first half's rates predict for that day's own mix.
                rates = {b: before[b][0] / before[b][1] for b in before if before[b][1] > 0}
                daily, expected = [], []
                for d in second:
                    counted = {b: c for b, c in new.daily[d].items() if b in rates}
                    n = sum(c[1] for c in counted.values())
                    if n:
                        daily.append((sum(c[0] for c in counted.values()), n))
                        expected.append(sum(rates[b] * c[1] for b, c in counted.items()) / n)
                n1, n2 = sum(s[1] for s in strata), sum(s[3] for s in strata)
                after_rate = sum(s[2] for s in strata) / n2
                before_rate = after_rate + drop  # the first half on the second half's mix of inputs
                if (p < settings.silent_alpha and drop >= settings.regression_min_drop
                        and cusum_alarm(daily, expected)):
                    alert = await raise_alert(
                        session, job, "SILENT_DROP", f"SILENT_DROP|{fam}|{now_version}",
                        {"model": fam, "model_version": now_version, "before_pass_rate": before_rate,
                         "after_pass_rate": after_rate, "n_before": n1, "n_after": n2, "drop": drop, "p_value": p,
                         "same_input_mix": len(strata) > 1,
                         "summary": f"{now_version}: pass rate fell from {before_rate:.1%} to {after_rate:.1%} "
                                    "with no version change"
                                    + (" (compared on the same mix of input sizes)" if len(strata) > 1 else "")},
                        now=now,
                    )
                    if alert:
                        result.alerts.append(alert)
                        regressed = True

    await session.commit()
    if regressed:
        await consolidate_job(session, job, now=now, settings=settings, reason="REGRESSION", force=True)
    return result


async def sweep_all(
    session: AsyncSession, *, now: datetime | None = None, settings: Settings | None = None
) -> list[Alert]:
    now = now or datetime.now(UTC)
    raised: list[Alert] = []
    jobs = (await session.execute(select(Job).order_by(Job.project_id, Job.name))).scalars().all()
    for job in jobs:
        raised += (await sweep_job(session, job, now=now, settings=settings)).alerts
    return raised


async def open_alert_count(session: AsyncSession, job_id) -> int:
    return (
        await session.execute(
            select(func.count()).select_from(Alert).where(Alert.job_id == job_id, Alert.resolved_at.is_(None))
        )
    ).scalar_one()
