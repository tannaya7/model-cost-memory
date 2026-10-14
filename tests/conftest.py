"""Shared fixtures: a throwaway Postgres with the schema applied by Alembic.

Tests use TEST_DATABASE_URL when it is set (CI starts a Postgres service container and sets it).
Otherwise they start an embedded Postgres with pgvector (the `pgserver` package), so no Docker,
no Neon account and no network are needed. They never touch DATABASE_URL, so a development
database is never wiped by a test run.
"""

from __future__ import annotations

import os
from pathlib import Path

import pytest
from alembic import command
from alembic.config import Config
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

ROOT = Path(__file__).resolve().parents[1]
TABLES = ["alerts", "outbox", "recommendations", "runs", "model_catalog", "jobs", "projects"]


@pytest.fixture(scope="session")
def database_url(tmp_path_factory: pytest.TempPathFactory):
    external = os.environ.get("TEST_DATABASE_URL")
    if external:
        yield external
        return
    pgserver = pytest.importorskip("pgserver", reason="install pgserver or set TEST_DATABASE_URL")
    server = pgserver.get_server(tmp_path_factory.mktemp("pgdata"), cleanup_mode="stop")
    server.psql("CREATE DATABASE mcm_test;")
    base = server.get_uri()
    yield base.rsplit("/", 1)[0] + "/mcm_test"
    server.cleanup()


@pytest.fixture(scope="session")
def migrated_url(database_url: str) -> str:
    """The database after `alembic upgrade head`."""
    previous = os.environ.get("DATABASE_URL")
    os.environ["DATABASE_URL"] = database_url
    try:
        cfg = Config(str(ROOT / "alembic.ini"))
        cfg.set_main_option("script_location", str(ROOT / "migrations"))
        command.upgrade(cfg, "head")
    finally:
        if previous is None:
            os.environ.pop("DATABASE_URL", None)
        else:
            os.environ["DATABASE_URL"] = previous
    return database_url


@pytest.fixture
async def engine(migrated_url: str):
    from agent_memory.config import normalize_database_url

    eng = create_async_engine(normalize_database_url(migrated_url))
    async with eng.begin() as conn:  # every test starts from empty tables
        await conn.execute(text("TRUNCATE " + ", ".join(TABLES) + " CASCADE"))
    yield eng
    await eng.dispose()


@pytest.fixture
async def session(engine) -> AsyncSession:
    async with async_sessionmaker(engine, expire_on_commit=False)() as s:
        yield s
