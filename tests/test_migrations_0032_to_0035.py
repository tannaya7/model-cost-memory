"""Migrations 0032 to 0035 roll back and apply again cleanly, keep existing rows, and the SHADOW clean-up never rewrites data.

Runs on the isolated test database (never a real one)."""

import asyncio
import uuid
from pathlib import Path

import pytest
from alembic import command
from alembic.config import Config
from sqlalchemy import text
from sqlalchemy.exc import DBAPIError

ROOT = Path(__file__).resolve().parents[1]


def _runner(migrated_url, monkeypatch):
    monkeypatch.setenv("DATABASE_URL", migrated_url)
    cfg = Config(str(ROOT / "alembic.ini"))
    cfg.set_main_option("script_location", str(ROOT / "migrations"))
    return lambda action, rev: getattr(command, action)(cfg, rev)


async def _columns(conn, table):
    return {r[0] for r in (await conn.execute(text("SELECT column_name FROM information_schema.columns WHERE table_name=:t"), {"t": table})).all()}


async def _indexes(conn, table):
    return {r[0] for r in (await conn.execute(text("SELECT indexname FROM pg_indexes WHERE tablename=:t"), {"t": table})).all()}


async def _kind_rule(conn):
    return (await conn.execute(text("SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname='runs_run_kind_check'"))).scalar_one()


async def test_0032_to_0035_round_trip_and_keep_existing_rows(engine, migrated_url, monkeypatch):
    run = _runner(migrated_url, monkeypatch)
    user = uuid.uuid4()
    try:
        await asyncio.to_thread(run, "downgrade", "0031")
        async with engine.begin() as conn:
            assert "session_epoch" not in await _columns(conn, "users")
            assert "idx_projects_key_hash" not in await _indexes(conn, "projects")
            assert "auto_retests" not in await _columns(conn, "projects")
            assert "confirmation_hash" not in await _columns(conn, "retests")
            assert "SHADOW" in await _kind_rule(conn)
            await conn.execute(text("INSERT INTO users (user_id, google_sub, email) VALUES (:u, 's-mig', 'mig@example.com')"), {"u": user})
            await conn.execute(text("INSERT INTO projects (project_id, slug, api_key_hash, name, owner_user_id) VALUES ('mig-1', 'mig-one', 'hash', 'Mig', :u)"), {"u": user})
        await asyncio.to_thread(run, "upgrade", "head")
        async with engine.connect() as conn:
            assert (await conn.execute(text("SELECT session_epoch FROM users WHERE user_id = :u"), {"u": user})).scalar_one() == 0  # nobody is signed out
            assert (await conn.execute(text("SELECT auto_retests FROM projects WHERE project_id = 'mig-1'"))).scalar_one() is False  # automatic replays stay off
            assert "idx_projects_key_hash" in await _indexes(conn, "projects")
            assert "confirmation_hash" in await _columns(conn, "retests")
            rule = await _kind_rule(conn)
            assert "SHADOW" not in rule and "RETEST" in rule and "PRODUCTION" in rule
        # each of the four can also be rolled back on its own and forward again
        for target in ("0034", "0033", "0032"):
            await asyncio.to_thread(run, "downgrade", target)
            await asyncio.to_thread(run, "upgrade", "head")
        async with engine.connect() as conn:
            assert (await conn.execute(text("SELECT count(*) FROM projects WHERE project_id = 'mig-1'"))).scalar_one() == 1
    finally:
        async with engine.begin() as conn:
            await conn.execute(text("DELETE FROM projects WHERE project_id = 'mig-1'"))
            await conn.execute(text("DELETE FROM users WHERE user_id = :u"), {"u": user})
        await asyncio.to_thread(run, "upgrade", "head")


async def test_the_shadow_clean_up_stops_loudly_instead_of_rewriting_a_row(engine, migrated_url, monkeypatch):
    run = _runner(migrated_url, monkeypatch)
    try:
        await asyncio.to_thread(run, "downgrade", "0034")
        async with engine.begin() as conn:
            await conn.execute(text("INSERT INTO projects (project_id, slug, api_key_hash) VALUES ('mig-2', 'mig-two', 'hash')"))
            job = (await conn.execute(text(
                "INSERT INTO jobs (project_id, name, check_kind, check_config) VALUES ('mig-2', 'j', 'ANSWER_KEY', '{}'::jsonb) RETURNING job_id"))).scalar_one()
            await conn.execute(text(
                "INSERT INTO runs (run_id, job_id, project_id, prompt, prompt_hash, model, model_version, run_kind) "
                "VALUES (:r, :j, 'mig-2', 'p', 'h', 'm', 'v', 'SHADOW')"), {"r": uuid.uuid4(), "j": job})
        with pytest.raises((DBAPIError, Exception)) as raised:
            await asyncio.to_thread(run, "upgrade", "0035")
        assert "runs_run_kind_check" in str(raised.value) or "check constraint" in str(raised.value).lower()
        async with engine.connect() as conn:
            assert (await conn.execute(text("SELECT run_kind FROM runs WHERE project_id = 'mig-2'"))).scalar_one() == "SHADOW"  # untouched
    finally:
        async with engine.begin() as conn:
            await conn.execute(text("DELETE FROM runs WHERE project_id = 'mig-2'"))
            await conn.execute(text("DELETE FROM jobs WHERE project_id = 'mig-2'"))
            await conn.execute(text("DELETE FROM projects WHERE project_id = 'mig-2'"))
        await asyncio.to_thread(run, "upgrade", "head")
