"""The staleness experiment (PRD US-007, technical plan 9): the product's central claim, measured.

One simulated timeline, three answers, scored against the known right answer:

    frozen        a curated evaluation set: every run of the first CURATION_DAYS days, judged once by
                  the same engine and never updated, the way a hand-maintained test set is
    rechecked     the same engine asked once every RECHECK_EVERY days and its answer kept until the
                  next check, the way a team re-runs its test set each month. A generous baseline: at
                  each check it sees all the evidence the system has
    maintained    this system: the stored recommendation of the day, kept current by decay,
                  re-test evidence, consolidation and supersession

The world changes underneath: the share of long documents grows (workload drift), so the cheap
model stops being good enough, and a new version of the mid-priced model arrives and becomes the
best buy. At each weekly checkpoint both answers are compared with `world.truth`. Success, as the
plan defines it: the frozen set's accuracy degrades as it ages; the maintained set's does not.

The control is a world where nothing changes (`stable_scenario`): there the right answer never moves,
and the maintained answer should not move either. Every day's answer is kept, so a change of answer
between checkpoints is counted too. What the freshness costs is measured as well: the re-test runs
that keep the other models' evidence current, next to production spend.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass, field

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from sqlalchemy import func, select

from ..config import Settings, get_settings
from ..models import Run
from ..recommend.engine import recommend
from .harness import Simulator
from .world import Scenario, SimModel, Version, truth

CURATION_DAYS = 14
CHECK_EVERY = 7
RECHECK_EVERY = 30


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


def stable_scenario(seed: int, *, days: int = 120, runs_per_day: int = 100, retest_per_day: int = 30) -> Scenario:
    """The control: the same models, no workload drift, no new version. The right answer never changes."""
    big = SimModel("acme-large", 0.030, (Version("acme-large-2026-01-01", 0, 0.990, 0.980),))
    mid = SimModel("acme-mid", 0.008, (Version("acme-mid-2026-01-01", 0, 0.960, 0.900),))
    mini = SimModel("acme-mini", 0.001, (Version("acme-mini-2026-01-01", 0, 0.985, 0.800),))
    return Scenario(job="invoice-extract", models=(big, mid, mini), production="acme-large", days=days,
                    runs_per_day=runs_per_day, retest_per_day=retest_per_day, long_share_start=0.05,
                    long_share_end=0.05, seed=seed)


SCENARIOS = {"drift": drift_scenario, "stable": stable_scenario}


@dataclass
class Checkpoint:
    day: int
    truth: str | None
    frozen: str | None
    maintained: str | None
    rechecked: str | None = None


@dataclass
class StalenessResult:
    seed: int
    checkpoints: list[Checkpoint] = field(default_factory=list)
    daily: list[str | None] = field(default_factory=list)  # the maintained answer each day from curation on
    production_usd: float = 0.0
    retest_usd: float = 0.0
    retest_runs: int = 0

    def changes(self) -> int:
        """How often the maintained answer changed from one day to the next."""
        return sum(a != b for a, b in zip(self.daily, self.daily[1:], strict=False))

    def accuracy(self, which: str, *, from_day: int = 0) -> float:
        points = [c for c in self.checkpoints if c.day >= from_day]
        return sum(getattr(c, which) == c.truth for c in points) / len(points) if points else 0.0


async def run_once(sessions: async_sessionmaker[AsyncSession], scenario: Scenario,
                   settings: Settings | None = None) -> StalenessResult:
    settings = settings or get_settings()
    result = StalenessResult(scenario.seed)
    frozen: str | None = None
    rechecked: str | None = None
    async with sessions() as session:
        sim = Simulator(session, scenario, project_id=f"stale-{uuid.uuid4().hex[:10]}", settings=settings)
        job = await sim.setup()
        for day in range(scenario.days):
            outcome = await sim.day(day)
            if day == CURATION_DAYS - 1:  # curate the evaluation set once, then never touch it again
                curated = await recommend(session, job, now=sim.at(CURATION_DAYS), settings=settings)
                chosen = curated.decision.recommended
                frozen = rechecked = chosen.model if chosen else None
            elif day >= CURATION_DAYS and (day - CURATION_DAYS + 1) % RECHECK_EVERY == 0:
                checked = (await recommend(session, job, now=sim.at(day + 1), settings=settings)).decision
                rechecked = checked.recommended.model if checked.recommended else None
            maintained = outcome.recommended if outcome.verdict != "INSUFFICIENT_EVIDENCE" else None
            if day >= CURATION_DAYS:
                result.daily.append(maintained)
            if day >= CURATION_DAYS and (day - CURATION_DAYS) % CHECK_EVERY == 0:
                result.checkpoints.append(Checkpoint(
                    day=day, truth=truth(scenario, day, settings.tolerance_points), frozen=frozen,
                    maintained=maintained, rechecked=rechecked,
                ))
        spend = dict((await session.execute(
            select(Run.run_kind, func.sum(Run.cost_usd)).where(Run.project_id == sim.project_id)
            .group_by(Run.run_kind)
        )).all())
        result.production_usd = float(spend.get("PRODUCTION") or 0)
        result.retest_usd = float(spend.get("RETEST") or 0)
        result.retest_runs = (await session.execute(
            select(func.count()).select_from(Run).where(Run.project_id == sim.project_id, Run.run_kind == "RETEST")
        )).scalar_one()
    return result


async def experiment(sessions: async_sessionmaker[AsyncSession], *, seeds: int = 3, days: int = 120,
                     world: str = "drift", retest_per_day: int = 30,
                     settings: Settings | None = None) -> list[StalenessResult]:
    build = SCENARIOS[world]
    return [await run_once(sessions, build(seed, days=days, retest_per_day=retest_per_day), settings)
            for seed in range(seeds)]
