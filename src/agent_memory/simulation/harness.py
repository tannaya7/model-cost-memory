"""Simulated-time harness (technical plan Week 9): drives the real pipeline through weeks in minutes.

Each simulated day writes that day's runs straight into Postgres with `created_at` in simulated time
(production traffic on the model the application uses, plus re-test evidence on the other live
models), updates the catalog when a model is retired, and then runs the real maintenance with
`now` set to the end of that day: decay (weekly), consolidation and the regression sweep. Nothing in
the engine knows it is being simulated.

When the production model is retired, the application follows the stored recommendation, as a
user acting on the advice would.
"""

from __future__ import annotations

import random
import uuid
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta

from sqlalchemy import insert, select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from ..config import Settings, get_settings
from ..models import Alert, CatalogEntry, Job, Project, Run
from ..pipeline.consolidation import consolidate_job, current_recommendation
from ..pipeline.decay import recompute
from ..pipeline.regression import sweep_job
from ..versions import normalize
from .world import Scenario, true_rate

START = datetime(2026, 1, 5, tzinfo=UTC)
LONG_TOKENS, SHORT_TOKENS = 12_000, 900


@dataclass
class DayResult:
    day: int
    production: str
    recommended: str | None
    verdict: str | None
    alerts: list[Alert] = field(default_factory=list)


class Simulator:
    def __init__(self, session: AsyncSession, scenario: Scenario, *, project_id: str,
                 settings: Settings | None = None, start: datetime = START, decay_every: int = 7):
        self.session, self.scenario, self.project_id = session, scenario, project_id
        self.settings = settings or get_settings()
        self.start, self.decay_every = start, decay_every
        self.rng = random.Random(scenario.seed)
        self.production = scenario.production
        self.job: Job | None = None

    def at(self, day: int) -> datetime:
        return self.start + timedelta(days=day)

    async def setup(self, *, description: str | None = None) -> Job:
        if await self.session.get(Project, self.project_id) is None:
            self.session.add(Project(project_id=self.project_id, api_key_hash=f"simulated-{uuid.uuid4()}"))
            await self.session.flush()
        self.job = Job(project_id=self.project_id, name=self.scenario.job, check_kind="ANSWER_KEY",
                       check_config={"fields": ["total"]}, description=description)
        self.session.add(self.job)
        for model in self.scenario.models:
            for version in model.versions:
                name = normalize(version.name)
                await self.session.execute(  # every trial starts with its models ACTIVE
                    pg_insert(CatalogEntry).values(
                        model=name, model_version=name, provider="simulated", status="ACTIVE", source="MANUAL",
                    ).on_conflict_do_update(
                        index_elements=["model", "model_version"], set_={"status": "ACTIVE", "shutdown_date": None},
                    )
                )
        await self.session.commit()
        return self.job

    def _runs(self, family: str, day: int, n: int, kind: str) -> list[dict]:
        model = self.scenario.model(family)
        version = model.version_on(day)
        if version is None or n <= 0:
            return []
        share = self.scenario.long_share(day)
        rows = []
        for i in range(n):
            long_doc = self.rng.random() < share
            rate = true_rate(version, day, 1.0 if long_doc else 0.0)
            passed = self.rng.random() < rate
            rows.append(dict(
                run_id=uuid.uuid4(), job_id=self.job.job_id, project_id=self.project_id,
                prompt=f"simulated invoice {day}-{i}", prompt_hash=f"sim-{day}-{i}-{family}", model=family,
                model_version=version.name, tokens_in=LONG_TOKENS if long_doc else SHORT_TOKENS, tokens_out=80,
                cost_usd=model.cost * (3 if long_doc else 1), outcome="PASS" if passed else "FAIL",
                outcome_reason=None if passed else "total: simulated mismatch", run_kind=kind, state="INDEXED",
                created_at=self.at(day) + timedelta(seconds=(i + 1) * 86_000 / (n + 1)),
            ))
        return rows

    async def _retire(self, day: int) -> None:
        for model in self.scenario.models:
            if model.retired_day == day:
                for version in model.versions:
                    entry = await self.session.get(CatalogEntry, (normalize(version.name), normalize(version.name)))
                    if entry:
                        entry.status, entry.shutdown_date = "RETIRED", self.at(day).date()

    async def day(self, day: int) -> DayResult:
        await self._retire(day)
        if self.scenario.model(self.production).version_on(day) is None:  # retired: follow the advice
            rec = await current_recommendation(self.session, self.job.job_id)
            live = [m.family for m in self.scenario.models if m.version_on(day) is not None]
            self.production = rec.model if rec and rec.model in live else live[0]
        rows = self._runs(self.production, day, self.scenario.runs_per_day, "PRODUCTION")
        for model in self.scenario.models:
            if model.family != self.production:
                rows += self._runs(model.family, day, self.scenario.retest_per_day, "RETEST")
        if rows:
            await self.session.execute(insert(Run), rows)
        await self.session.commit()

        end = self.at(day + 1)
        if day % self.decay_every == self.decay_every - 1:
            await recompute(self.session, now=end, settings=self.settings, project_id=self.project_id)
        await consolidate_job(self.session, self.job, now=end, settings=self.settings)
        sweep = await sweep_job(self.session, self.job, now=end, settings=self.settings)
        rec = await current_recommendation(self.session, self.job.job_id)
        await self.session.commit()
        return DayResult(day, self.production, rec.model if rec else None, rec.verdict if rec else None, sweep.alerts)

    async def run(self) -> list[DayResult]:
        if self.job is None:
            await self.setup()
        return [await self.day(d) for d in range(self.scenario.days)]


async def alerts_of(session: AsyncSession, job: Job) -> list[Alert]:
    return list((await session.execute(select(Alert).where(Alert.job_id == job.job_id))).scalars())
