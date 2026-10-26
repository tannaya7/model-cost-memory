"""Evaluations run on the simulated-time harness.

Regression detection (Week 9, technical plan 9): in each trial a model is upgraded on day 30 to a new
version whose pass rate is lower by a known amount (or, in control trials, the same). A trial is a
detection when a VERSION_REGRESSION alert for the new version is raised by the end; in a control
trial any regression alert is a false positive. The same is done for silent drops: the rate falls
by a known amount on day 20 under an unchanged version.

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


def upgrade_scenario(drop: float, seed: int, *, runs_per_day: int = 50) -> Scenario:
    big = SimModel("acme-large", 0.03, (
        Version("acme-large-2026-01-01", 0, BASE_RATE, BASE_RATE),
        Version("acme-large-2026-02-04", 30, BASE_RATE - drop, BASE_RATE - drop),
    ))
    return Scenario(job="invoice-extract", models=(big,), production="acme-large", days=44,
                    runs_per_day=runs_per_day, retest_per_day=0, seed=seed)


def silent_scenario(drop: float, seed: int, *, runs_per_day: int = 50) -> Scenario:
    big = SimModel("acme-large", 0.03, (
        Version("acme-large-2026-01-01", 0, BASE_RATE, BASE_RATE, drop_day=20 if drop else None, drop_size=drop),
    ))
    return Scenario(job="invoice-extract", models=(big,), production="acme-large", days=34,
                    runs_per_day=runs_per_day, retest_per_day=0, seed=seed)


@dataclass
class DetectionResult:
    kind: str  # VERSION_REGRESSION or SILENT_DROP
    drop: float
    trials: int
    flagged: int
    days_to_detect: list[int] = field(default_factory=list)

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
    runs_per_day: int = 50,
) -> list[DetectionResult]:
    """Detection rate per injected drop; drop 0.0 is the control, whose rate is the false-positive rate."""
    settings = settings or get_settings()
    build = upgrade_scenario if kind == "VERSION_REGRESSION" else silent_scenario
    results = []
    for drop in drops:
        r = DetectionResult(kind, drop, trials, 0)
        for seed in range(trials):
            day = await _trial(sessions, build(drop, seed, runs_per_day=runs_per_day), kind, settings)
            if day is not None:
                r.flagged += 1
                r.days_to_detect.append(day)
        results.append(r)
    return results


__all__ = ["DetectionResult", "alerts_of", "detection", "silent_scenario", "upgrade_scenario"]
