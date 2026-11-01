"""The staleness experiment (PRD US-007, technical plan 9): the product's central claim, measured.

One simulated timeline, two evidence sets, scored against the known right answer:

    frozen        a curated evaluation set: every run of the first CURATION_DAYS days, judged once by
                  the same engine and never updated, the way a hand-maintained test set is
    maintained    this system: the stored recommendation of the day, kept current by decay,
                  re-test evidence, consolidation and supersession

The world changes underneath: the share of long documents grows (workload drift), so the cheap
model stops being good enough, and a new version of the mid-priced model arrives and becomes the
best buy. At each weekly checkpoint both answers are compared with `world.truth`. Success, as the
plan defines it: the frozen set's accuracy degrades as it ages; the maintained set's does not.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass, field

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from ..config import Settings, get_settings
from ..recommend.engine import recommend
from .harness import Simulator
from .world import Scenario, SimModel, Version, truth

CURATION_DAYS = 14
CHECK_EVERY = 7


def drift_scenario(seed: int, *, days: int = 120, runs_per_day: int = 100, retest_per_day: int = 30) -> Scenario:
    big = SimModel("acme-large", 0.030, (Version("acme-large-2026-01-01", 0, 0.990, 0.980),))
    mid = SimModel("acme-mid", 0.008, (
        Version("acme-mid-2026-01-01", 0, 0.960, 0.900),
        Version("acme-mid-2026-02-19", 45, 0.985, 0.975),  # a better version replaces it on day 45
    ))
    mini = SimModel("acme-mini", 0.001, (Version("acme-mini-2026-01-01", 0, 0.985, 0.800),))
    return Scenario(job="invoice-extract", models=(big, mid, mini), production="acme-large", days=days,
                    runs_per_day=runs_per_day, retest_per_day=retest_per_day, long_share_start=0.05,
                    long_share_end=0.60, seed=seed)


@dataclass
class Checkpoint:
    day: int
    truth: str | None
    frozen: str | None
    maintained: str | None


@dataclass
class StalenessResult:
    seed: int
    checkpoints: list[Checkpoint] = field(default_factory=list)

    def accuracy(self, which: str, *, from_day: int = 0) -> float:
        points = [c for c in self.checkpoints if c.day >= from_day]
        return sum(getattr(c, which) == c.truth for c in points) / len(points) if points else 0.0


async def run_once(sessions: async_sessionmaker[AsyncSession], scenario: Scenario,
                   settings: Settings | None = None) -> StalenessResult:
    settings = settings or get_settings()
    result = StalenessResult(scenario.seed)
    frozen: str | None = None
    async with sessions() as session:
        sim = Simulator(session, scenario, project_id=f"stale-{uuid.uuid4().hex[:10]}", settings=settings)
        job = await sim.setup()
        for day in range(scenario.days):
            outcome = await sim.day(day)
            if day == CURATION_DAYS - 1:  # curate the evaluation set once, then never touch it again
                curated = await recommend(session, job, now=sim.at(CURATION_DAYS), settings=settings)
                chosen = curated.decision.recommended
                frozen = chosen.model if chosen else None
            if day >= CURATION_DAYS and (day - CURATION_DAYS) % CHECK_EVERY == 0:
                result.checkpoints.append(Checkpoint(
                    day=day, truth=truth(scenario, day, settings.tolerance_points), frozen=frozen,
                    maintained=outcome.recommended if outcome.verdict != "INSUFFICIENT_EVIDENCE" else None,
                ))
    return result


async def experiment(sessions: async_sessionmaker[AsyncSession], *, seeds: int = 3, days: int = 120,
                     settings: Settings | None = None) -> list[StalenessResult]:
    return [await run_once(sessions, drift_scenario(seed, days=days), settings) for seed in range(seeds)]
