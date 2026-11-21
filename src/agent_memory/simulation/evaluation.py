"""Evaluations run on the simulated-time harness.

Regression detection (Week 9, technical plan 9): in each trial a model is upgraded on day 30 to a new
version whose pass rate is lower by a known amount (or, in control trials, the same). A trial is a
detection when a VERSION_REGRESSION alert for the new version is raised within `days_after` days of
the change; in a control trial any regression alert in that time is a false positive. The same is
done for silent drops: the rate falls by a known amount on day 20 under an unchanged version.

How long a trial watches matters as much as the detector: the silent-drop test compares the two
halves of a 28-day window, so a drop is split cleanly only 14 days after it starts. Results are
reported per observation period, with the days to detect counted from the change.

Workload drift (mentor review 3): inputs can get harder while no model changes, and a detector that
compares pass rates over time would read that as a regression. With `drift=True` short documents pass
at 98% and long ones at 80% under every version, and the share of long documents grows from 10% to
50% over the trial, so the overall pass rate falls by about 7 points with nothing broken. Run with
drop 0 these are the drift controls: any alert is a false alarm caused by the input mix.

Each trial is its own project, so trials never see each other's runs.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass, field

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from ..config import Settings, get_settings
from .harness import Simulator, alerts_of
from .world import Scenario, SimModel, Version

BASE_RATE = 0.95
DRIFT_SHORT, DRIFT_LONG = 0.98, 0.80  # with drift: the true rates on short and long documents
DRIFT_LONG_SHARE = (0.10, 0.50)  # ... and the share of long documents at the start and the end


UPGRADE_DAY = 30
SILENT_DROP_DAY = 20


def _rates(drift: bool) -> tuple[float, float, dict]:
    if drift:
        return DRIFT_SHORT, DRIFT_LONG, {"long_share_start": DRIFT_LONG_SHARE[0], "long_share_end": DRIFT_LONG_SHARE[1]}
    return BASE_RATE, BASE_RATE, {}


def upgrade_scenario(drop: float, seed: int, *, runs_per_day: int = 50, days_after: int = 14,
                     drift: bool = False) -> Scenario:
    short, long_, mix = _rates(drift)
    big = SimModel("acme-large", 0.03, (
        Version("acme-large-2026-01-01", 0, short, long_),
        Version("acme-large-2026-02-04", UPGRADE_DAY, short - drop, long_ - drop),
    ))
    return Scenario(job="invoice-extract", models=(big,), production="acme-large", days=UPGRADE_DAY + days_after,
                    runs_per_day=runs_per_day, retest_per_day=0, seed=seed, **mix)


def silent_scenario(drop: float, seed: int, *, runs_per_day: int = 50, days_after: int = 14,
                    drift: bool = False) -> Scenario:
    short, long_, mix = _rates(drift)
    big = SimModel("acme-large", 0.03, (
        Version("acme-large-2026-01-01", 0, short, long_, drop_day=SILENT_DROP_DAY if drop else None,
                drop_size=drop),
    ))
    return Scenario(job="invoice-extract", models=(big,), production="acme-large", days=SILENT_DROP_DAY + days_after,
                    runs_per_day=runs_per_day, retest_per_day=0, seed=seed, **mix)


@dataclass
class DetectionResult:
    kind: str  # VERSION_REGRESSION or SILENT_DROP
    drop: float
    trials: int
    flagged: int
    days_to_detect: list[int] = field(default_factory=list)  # counted from the change
    days_after: int = 14

    @property
    def rate(self) -> float:
        return self.flagged / self.trials if self.trials else 0.0


async def _trial(sessions: async_sessionmaker[AsyncSession], scenario: Scenario, kind: str,
                 settings: Settings) -> int | None:
    """Run one trial; the day the alert of `kind` was first raised, or None."""
    async with sessions() as session:
        sim = Simulator(session, scenario, project_id=f"sim-{uuid.uuid4().hex[:12]}", settings=settings)
        await sim.setup()
        for day in range(scenario.days):
            result = await sim.day(day)
            if any(a.kind == kind for a in result.alerts):
                return day
        return None


async def detection(
    sessions: async_sessionmaker[AsyncSession], *, drops: tuple[float, ...] = (0.0, 0.05, 0.10, 0.15),
    trials: int = 10, kind: str = "VERSION_REGRESSION", settings: Settings | None = None,
    runs_per_day: int = 50, days_after: int = 14, drift: bool = False,
) -> list[DetectionResult]:
    """Detection rate per injected drop; drop 0.0 is the control, whose rate is the false-positive rate."""
    settings = settings or get_settings()
    build = upgrade_scenario if kind == "VERSION_REGRESSION" else silent_scenario
    change_day = UPGRADE_DAY if kind == "VERSION_REGRESSION" else SILENT_DROP_DAY
    results = []
    for drop in drops:
        r = DetectionResult(kind, drop, trials, 0, days_after=days_after)
        for seed in range(trials):
            day = await _trial(sessions, build(drop, seed, runs_per_day=runs_per_day, days_after=days_after,
                                               drift=drift), kind, settings)
            if day is not None:
                r.flagged += 1
                r.days_to_detect.append(day - change_day)
        results.append(r)
    return results


__all__ = ["DetectionResult", "alerts_of", "detection", "silent_scenario", "upgrade_scenario"]
