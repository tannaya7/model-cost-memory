"""The scheduler's jobs and the catalog scripts (embedded Postgres)."""

import json
import os
import subprocess
import sys
import uuid
from datetime import UTC, datetime, timedelta
from pathlib import Path

import httpx
import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker

from agent_memory.config import Settings
from agent_memory.models import CatalogEntry, Job, Project, Run
from agent_memory.scheduler import build_scheduler, run_catalog_sync, run_decay

ROOT = Path(__file__).resolve().parents[1]
SETTINGS = Settings(catalog_source_url="https://prices.example/list.json")
PRICES = {"acme-small": {"litellm_provider": "acme", "mode": "chat", "input_cost_per_token": 2.5e-07,
                         "output_cost_per_token": 1.25e-06}}


@pytest.fixture
def sessions(engine):
    return async_sessionmaker(engine, expire_on_commit=False)


def test_the_scheduler_has_all_its_maintenance_jobs():
    scheduler = build_scheduler(sessions=None, settings=SETTINGS)
    jobs = {j.id: j for j in scheduler.get_jobs()}
    assert set(jobs) == {"outbox-janitor", "decay", "consolidation", "regression", "alert-delivery", "retests",
                         "retest-unsure", "catalog-sync", "catalog-sync-startup"}
    assert all(jobs[name].max_instances == 1
               for name in ("outbox-janitor", "decay", "consolidation", "regression", "alert-delivery", "catalog-sync"))
    assert jobs["decay"].trigger.interval.total_seconds() == 3600
    assert jobs["consolidation"].trigger.interval.total_seconds() == 900
    assert "hour='3'" in str(jobs["catalog-sync"].trigger)


async def test_the_catalog_sync_job_loads_prices(sessions, session):
    transport = httpx.MockTransport(lambda request: httpx.Response(200, json=PRICES))
    assert await run_catalog_sync(sessions, SETTINGS, transport=transport) is True
    assert (await session.execute(select(CatalogEntry.model))).scalars().all() == ["acme-small"]


async def test_an_unreachable_price_list_keeps_the_last_known_catalog_and_never_raises(sessions, session):
    ok = httpx.MockTransport(lambda request: httpx.Response(200, json=PRICES))
    await run_catalog_sync(sessions, SETTINGS, transport=ok)
    for broken in (httpx.MockTransport(lambda r: httpx.Response(503)), httpx.MockTransport(lambda r: httpx.Response(200, text="not json"))):
        assert await run_catalog_sync(sessions, SETTINGS, transport=broken) is False
    assert (await session.execute(select(CatalogEntry.model))).scalars().all() == ["acme-small"]


async def test_the_decay_job_archives_faded_runs(sessions, session):
    session.add(Project(project_id="demo", api_key_hash="x"))
    await session.flush()
    job = Job(project_id="demo", name="j", check_kind="LATE_LABEL", check_config={})
    session.add(job)
    await session.flush()
    for age in (0, 200):
        session.add(Run(run_id=uuid.uuid4(), job_id=job.job_id, project_id="demo", prompt="p", prompt_hash="h",
                        model="model-a", model_version="model-a-2026-09", state="CHECKED",
                        created_at=datetime.now(UTC) - timedelta(days=age)))
    await session.commit()
    await run_decay(sessions, SETTINGS)
    states = sorted((await session.execute(select(Run.state))).scalars().all())
    assert states == ["ARCHIVED", "CHECKED"]


def script(name, *args, env):
    return subprocess.run([sys.executable, str(ROOT / "scripts" / name), *args], capture_output=True, text=True,
                          env=env, timeout=60)


async def test_the_catalog_scripts_sync_from_a_file_and_manage_overrides(migrated_url, session, tmp_path):
    await session.execute(CatalogEntry.__table__.delete())
    await session.commit()
    env = {**os.environ, "DATABASE_URL": migrated_url, "PYTHONPATH": str(ROOT / "src")}
    prices = tmp_path / "prices.json"
    prices.write_text(json.dumps(PRICES), encoding="utf8")

    synced = script("sync_catalog.py", "--file", str(prices), env=env)
    assert synced.returncode == 0, synced.stderr
    assert "1 added" in synced.stdout

    set_ = script("catalog_override.py", "set", "local-llm:3b", "--provider", "ollama", "--price-in", "0", "--price-out", "0", env=env)
    assert set_.returncode == 0 and "[manual]" in set_.stdout, set_.stderr
    again = script("sync_catalog.py", "--file", str(prices), env=env)
    assert "1 unchanged" in again.stdout

    cleared = script("catalog_override.py", "clear", "local-llm:3b", env=env)
    assert cleared.returncode == 0 and "handed back" in cleared.stdout
    assert script("catalog_override.py", "clear", "local-llm:3b", env=env).returncode == 1
    bad = script("catalog_override.py", "set", "x", "--shutdown", "not-a-date", env=env)
    assert bad.returncode == 2
