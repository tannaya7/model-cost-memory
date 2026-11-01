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

Both run with an explicit `now`, so the simulated-time harness can drive them through weeks in minutes.
"""

from __future__ import annotations

import math
from collections import defaultdict
from statistics import NormalDist
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from ..alerts.service import raise_alert
from ..config import Settings, get_settings
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


def drop_test(pass_old: int, n_old: int, pass_new: int, n_new: int) -> tuple[float, float]:
    """One-sided two-proportion z-test that the new rate is lower. Returns (drop, p-value)."""
    p_old, p_new = pass_old / n_old, pass_new / n_new
    pooled = (pass_old + pass_new) / (n_old + n_new)
    se = math.sqrt(pooled * (1 - pooled) * (1 / n_old + 1 / n_new))
    drop = p_old - p_new
    if se == 0:
        return drop, 0.0 if drop > 0 else 1.0
    return drop, 0.5 * math.erfc((drop / se) / math.sqrt(2))


def boundary_alpha(alpha: float, n: int, ref_runs: int) -> float:
    """The p-value a daily check must beat with n runs on the new version: alpha once n >= ref_runs,
    stricter before (down to STRICTEST_P), so that checking every day keeps the overall false-alarm
    rate near alpha."""
    if n >= ref_runs:
        return alpha
    z = NormalDist().inv_cdf(1 - alpha) * math.sqrt(ref_runs / max(n, 1))
    return max(0.5 * math.erfc(z / math.sqrt(2)), min(alpha, STRICTEST_P))


def cusum_alarm(daily: list[tuple[int, int]], baseline: float, *, k: float = 0.5, h: float = 4.0) -> bool:
    """One-sided standardized CUSUM on daily pass rates.

    Each day's shortfall is measured in standard errors, z = (baseline - rate) / sqrt(b(1-b)/n), so a
    day with few runs counts for less; S = max(0, S + z - k), alarm when S >= h. k = 0.5 and h = 4
    are the textbook choice: one noisy day cannot cross it, a sustained drop does within days.
    """
    b = min(max(baseline, 1e-6), 1 - 1e-6)
    s = 0.0
    for passed, n in daily:
        z = (baseline - passed / n) / math.sqrt(b * (1 - b) / n)
        s = max(0.0, s + z - k)
        if s >= h:
            return True
    return False


@dataclass
class SweepResult:
    alerts: list[Alert] = field(default_factory=list)
    checked_families: int = 0


async def _counts(session: AsyncSession, job: Job, now: datetime) -> dict[tuple[str, str], list]:
    """(family, normalized version) -> [(created_at, passed, run_id)], counted runs up to `now`."""
    rows = (
        await session.execute(
            select(Run.run_id, Run.model, Run.model_version, Run.outcome, Run.created_at)
            .where(Run.job_id == job.job_id, Run.outcome.in_(("PASS", "FAIL")), Run.invalid_at.is_(None),
                   Run.created_at <= now)
            .order_by(Run.created_at)
        )
    ).all()
    out: dict[tuple[str, str], list] = defaultdict(list)
    for r in rows:
        out[(family_key(r.model, r.model_version), normalize(r.model_version))].append(
            (r.created_at, r.outcome == "PASS", r.run_id)
        )
    return out


async def sweep_job(
    session: AsyncSession, job: Job, *, now: datetime | None = None, settings: Settings | None = None
) -> SweepResult:
    settings = settings or get_settings()
    now = now or datetime.now(UTC)
    result = SweepResult()
    by_version = await _counts(session, job, now)
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
        new_runs = by_version[(fam, now_version)]
        started = new_runs[0][0]
        older = [v for v in versions if v != now_version and by_version[(fam, v)][0][0] < started]

        if older:  # VERSION_REGRESSION against the version it replaced
            previous = max(older, key=lambda v: by_version[(fam, v)][0][0])
            old_runs = by_version[(fam, previous)][-OLD_VERSION_WINDOW:]
            n_old, n_new = len(old_runs), len(new_runs)
            if min(n_old, n_new) >= settings.regression_min_runs:
                pass_old, pass_new = sum(r[1] for r in old_runs), sum(r[1] for r in new_runs)
                drop, p = drop_test(pass_old, n_old, pass_new, n_new)
                limit = boundary_alpha(settings.regression_alpha, n_new, settings.regression_ref_runs)
                if p < limit and drop >= settings.regression_min_drop:
                    failing = [str(r[2]) for r in reversed(new_runs) if not r[1]][:FAILING_RUNS_IN_ALERT]
                    alert = await raise_alert(
                        session, job, "VERSION_REGRESSION", f"VERSION_REGRESSION|{fam}|{now_version}",
                        {"model": fam, "old_version": previous, "new_version": now_version,
                         "old_pass_rate": pass_old / n_old, "new_pass_rate": pass_new / n_new,
                         "n_old": n_old, "n_new": n_new, "drop": drop, "p_value": p, "failing_run_ids": failing,
                         "summary": f"{fam}: pass rate fell from {pass_old / n_old:.1%} to {pass_new / n_new:.1%} "
                                    f"after {previous} was replaced by {now_version}"},
                        now=now,
                    )
                    if alert:
                        result.alerts.append(alert)
                        regressed = True

        # SILENT_DROP within the current version
        since = now - timedelta(days=SILENT_WINDOW_DAYS)
        daily: dict = defaultdict(lambda: [0, 0])
        for created, passed, _ in new_runs:
            if created >= since:
                day = daily[created.date()]
                day[0] += passed
                day[1] += 1
        days = [tuple(daily[d]) for d in sorted(daily) if daily[d][1] >= SILENT_MIN_DAILY_RUNS]
        if len(days) >= SILENT_MIN_DAYS:
            first, second = days[: len(days) // 2], days[len(days) // 2:]
            p1, n1 = sum(d[0] for d in first), sum(d[1] for d in first)
            p2, n2 = sum(d[0] for d in second), sum(d[1] for d in second)
            drop, p = drop_test(p1, n1, p2, n2)
            if (p < settings.silent_alpha and drop >= settings.regression_min_drop
                    and cusum_alarm(second, p1 / n1)):
                alert = await raise_alert(
                    session, job, "SILENT_DROP", f"SILENT_DROP|{fam}|{now_version}",
                    {"model": fam, "model_version": now_version, "before_pass_rate": p1 / n1,
                     "after_pass_rate": p2 / n2, "n_before": n1, "n_after": n2, "drop": drop, "p_value": p,
                     "summary": f"{now_version}: pass rate fell from {p1 / n1:.1%} to {p2 / n2:.1%} "
                                "with no version change"},
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
