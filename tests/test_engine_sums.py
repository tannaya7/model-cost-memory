"""The engine's evidence sums, done in Postgres per hour bucket, match the exact per-run formula."""

import math
import random
import uuid
from datetime import UTC, datetime, timedelta

import pytest

from agent_memory.config import Settings
from agent_memory.models import Job, Project, Run
from agent_memory.recommend.engine import recommend

NOW = datetime(2026, 10, 30, 12, 0, tzinfo=UTC)


async def test_weighted_sums_match_the_exact_formula(session):
    session.add(Project(project_id="p", api_key_hash="x"))
    await session.flush()
    job = Job(project_id="p", name="invoice", check_kind="ANSWER_KEY", check_config={"fields": ["total"]})
    session.add(job)
    await session.flush()
    rng = random.Random(4)
    settings = Settings()
    expected = {"total": 0.0, "squares": 0.0, "passing": 0.0, "cost": 0.0, "priced": 0.0}
    # An old version (superseded once the new one runs in production), then the current one.
    for version, days, kind, stability in [("big-2026-08", (40, 95), "PRODUCTION", 30 * 0.25),
                                           ("big-2026-09", (0, 40), "PRODUCTION", 30.0)]:
        for _ in range(400):
            age = rng.uniform(*days)
            passed = rng.random() < 0.93
            cost = None if rng.random() < 0.1 else round(rng.uniform(0.001, 0.003), 6)  # NUMERIC(12,6)
            w = math.exp(-age / stability)
            expected["total"] += w
            expected["squares"] += w * w
            expected["passing"] += w if passed else 0.0
            if cost is not None:
                expected["cost"] += w * cost
                expected["priced"] += w
            session.add(Run(run_id=uuid.uuid4(), job_id=job.job_id, project_id="p", prompt="p", prompt_hash="h",
                            model="big", model_version=version, run_kind=kind, outcome="PASS" if passed else "FAIL",
                            cost_usd=cost, state="INDEXED", created_at=NOW - timedelta(days=age)))
    await session.commit()

    [m] = (await recommend(session, job, now=NOW, settings=settings)).decision.models
    assert m.n_runs == 800
    assert m.sample.evidence_weight == pytest.approx(expected["total"], rel=1e-6)
    assert m.sample.pass_rate == pytest.approx(expected["passing"] / expected["total"], rel=1e-6)
    assert m.sample.effective_n == pytest.approx(expected["total"] ** 2 / expected["squares"], rel=1e-6)
    assert m.mean_cost_usd == pytest.approx(expected["cost"] / expected["priced"], rel=1e-6)
