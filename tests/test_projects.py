"""Creating projects and keys."""

import os
import subprocess
import sys
from decimal import Decimal
from pathlib import Path

import pytest
from sqlalchemy import select

from agent_memory.models import Project
from agent_memory.projects import ProjectExists, create_project
from agent_memory.security import hash_key

ROOT = Path(__file__).resolve().parents[1]


async def test_the_key_is_returned_once_and_only_its_hash_is_stored(session):
    project, key = await create_project(session, "my-company", webhook_url="https://hooks.example.com/x")
    stored = (await session.execute(select(Project))).scalar_one()
    assert stored.api_key_hash == hash_key(key) and key not in stored.api_key_hash
    assert stored.webhook_url == "https://hooks.example.com/x"
    assert stored.retest_monthly_cap_usd == Decimal("10.00")
    assert project.project_id == "my-company"


async def test_a_duplicate_project_id_is_refused(session):
    await create_project(session, "my-company")
    with pytest.raises(ProjectExists):
        await create_project(session, "my-company")


@pytest.mark.parametrize("bad", ["", "ab", "Has Caps", "-leading", "trailing-", "x" * 41])
async def test_invalid_project_ids_are_refused(session, bad):
    with pytest.raises(ValueError):
        await create_project(session, bad)


def test_the_script_prints_the_key_once(migrated_url, tmp_path):
    env = {**os.environ, "DATABASE_URL": migrated_url, "PYTHONPATH": str(ROOT / "src")}
    run = subprocess.run(
        [sys.executable, str(ROOT / "scripts" / "create_project.py"), "script-made", "--cap", "5"],
        capture_output=True, text=True, env=env, cwd=tmp_path, timeout=60,
    )
    assert run.returncode == 0, run.stderr
    assert "mcm_live_" in run.stdout and "not stored" in run.stdout
    again = subprocess.run(
        [sys.executable, str(ROOT / "scripts" / "create_project.py"), "script-made"],
        capture_output=True, text=True, env=env, cwd=tmp_path, timeout=60,
    )
    assert again.returncode == 1 and "already exists" in again.stderr
