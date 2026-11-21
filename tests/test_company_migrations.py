"""Migrations 0030 (company workspaces) and 0031 (notice and job role): they apply over existing data without moving
anything, and they roll back and apply again cleanly."""

import asyncio
import uuid
from pathlib import Path

from alembic import command
from alembic.config import Config
from sqlalchemy import text

ROOT = Path(__file__).resolve().parents[1]
NEW_TABLES = {"organisations", "memberships", "org_invites", "org_events", "org_notice_acks"}


async def test_company_migrations_keep_existing_projects_where_they_are_and_round_trip(engine, migrated_url, monkeypatch):
    monkeypatch.setenv("DATABASE_URL", migrated_url)
    cfg = Config(str(ROOT / "alembic.ini"))
    cfg.set_main_option("script_location", str(ROOT / "migrations"))

    def run(action, rev):
        getattr(command, action)(cfg, rev)

    async def tables(conn):
        return {r[0] for r in (await conn.execute(text("SELECT table_name FROM information_schema.tables WHERE table_schema='public'"))).all()}

    owner = uuid.uuid4()
    try:
        await asyncio.to_thread(run, "downgrade", "0029")
        async with engine.begin() as conn:
            assert not (NEW_TABLES & await tables(conn))
            cols = {r[0] for r in (await conn.execute(text("SELECT column_name FROM information_schema.columns WHERE table_name='projects'"))).all()}
            assert "organisation_id" not in cols
            await conn.execute(text("INSERT INTO users (user_id, google_sub, email) VALUES (:u, 's', 'o@example.com')"), {"u": owner})
            for pid, slug in (("p-1", "production"), ("p-2", "staging")):
                await conn.execute(text("INSERT INTO projects (project_id, slug, api_key_hash, name, owner_user_id) VALUES (:p, :s, 'x', :s, :o)"),
                                   {"p": pid, "s": slug, "o": owner})
        await asyncio.to_thread(run, "upgrade", "head")
        async with engine.connect() as conn:
            assert NEW_TABLES <= await tables(conn)
            rows = (await conn.execute(text("SELECT project_id, slug, owner_user_id, organisation_id FROM projects ORDER BY project_id"))).all()
            # nothing moved: still personal (no company), same owner, same short name
            assert [(r[0], r[1], r[2], r[3]) for r in rows] == [("p-1", "production", owner, None), ("p-2", "staging", owner, None)]
            idx = {r[0] for r in (await conn.execute(text("SELECT indexname FROM pg_indexes WHERE tablename='projects'"))).all()}
            assert {"uq_projects_owner_slug", "uq_projects_org_slug", "uq_projects_ownerless_slug"} <= idx
            jr = (await conn.execute(text("SELECT count(*) FROM information_schema.columns WHERE table_name='memberships' AND column_name='job_role'"))).scalar_one()
            assert jr == 1
        # roll the notice migration back alone, then forward again
        await asyncio.to_thread(run, "downgrade", "0030")
        async with engine.connect() as conn:
            assert "org_notice_acks" not in await tables(conn)
            assert (await conn.execute(text("SELECT count(*) FROM information_schema.columns WHERE table_name='memberships' AND column_name='job_role'"))).scalar_one() == 0
        await asyncio.to_thread(run, "upgrade", "head")
        async with engine.connect() as conn:
            assert "org_notice_acks" in await tables(conn)
            assert (await conn.execute(text("SELECT count(*) FROM projects"))).scalar_one() == 2
    finally:
        async with engine.begin() as conn:
            await conn.execute(text("DELETE FROM projects WHERE project_id IN ('p-1','p-2')"))
            await conn.execute(text("DELETE FROM users WHERE user_id = :u"), {"u": owner})
        await asyncio.to_thread(run, "upgrade", "head")
