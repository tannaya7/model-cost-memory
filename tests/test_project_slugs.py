"""The short readable project name in the web address (/p/production): rules, per-owner uniqueness, isolation."""

import asyncio
import uuid
from datetime import datetime
from pathlib import Path

import pytest
from alembic import command
from alembic.config import Config
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError

from agent_memory.models import Project
from agent_memory.projects import RESERVED_SLUGS, SLUG, create_project, make_slug, pick_slug


@pytest.mark.parametrize("name, expected", [
    ("Production", "production"),
    ("Acme Shop!", "acme-shop"),
    ("  --Acme   &  Co--  ", "acme-co"),
    ("Café Münster", "cafe-munster"),
    ("\U0001f680 Rocket Ship \U0001f680", "rocket-ship"),
    ("", "project"),
    ("   ", "project"),
    ("!!!", "project"),
    ("日本語", "project"),
    ("AI", "project"),  # too short
    ("a" * 100, "a" * 40),
    ("ab-" * 30, ("ab-" * 30)[:40].strip("-")),
    (None, "project"),
])
def test_make_slug_rules(name, expected):
    slug = make_slug(name)
    assert slug == expected
    assert SLUG.match(slug) and 3 <= len(slug) <= 40 and "--" not in slug


def test_collisions_get_numbered_suffixes_and_stay_within_forty_characters():
    assert pick_slug("Production", set()) == "production"
    assert pick_slug("Production", {"production"}) == "production-2"
    assert pick_slug("Production", {"production", "production-2"}) == "production-3"
    long = pick_slug("x" * 60, {"x" * 40})
    assert long == "x" * 38 + "-2" and len(long) == 40


def test_reserved_words_are_never_handed_out():
    for word in RESERVED_SLUGS:
        assert pick_slug(word.replace("-", " "), set()) not in RESERVED_SLUGS
    assert pick_slug("New", set()) == "new-2"
    assert pick_slug("Demo", set()) == "demo-2"


ROOT = Path(__file__).resolve().parents[1]


async def _user(session, email):
    uid = uuid.uuid4()
    await session.execute(text("INSERT INTO users (user_id, google_sub, email) VALUES (:u, :s, :e)"),
                          {"u": uid, "s": f"sub-{uid}", "e": email})
    return uid


async def test_two_owners_can_both_have_production_but_one_owner_cannot_have_it_twice(session):
    a, b = await _user(session, "a@example.com"), await _user(session, "b@example.com")
    p1, _ = await create_project(session, "prod-aaaa", name="Production", owner_user_id=a)
    p2, _ = await create_project(session, "prod-bbbb", name="Production", owner_user_id=b)
    p3, _ = await create_project(session, "prod-cccc", name="Production", owner_user_id=a)
    assert (p1.slug, p2.slug, p3.slug) == ("production", "production", "production-2")
    session.add(Project(project_id="dup-slug-1", api_key_hash="x", owner_user_id=a, slug="production"))
    with pytest.raises(IntegrityError):
        await session.commit()
    await session.rollback()


async def test_operator_made_projects_keep_their_id_and_the_database_rejects_bad_slugs(session):
    demo, _ = await create_project(session, "demo")
    assert demo.slug == "demo"
    session.add(Project(project_id="badslug1", api_key_hash="x", slug="Bad Slug"))
    with pytest.raises(IntegrityError):
        await session.commit()
    await session.rollback()


@pytest.fixture
def dev_login(monkeypatch):
    monkeypatch.setenv("DEV_LOGIN", "true")

    async def sign_in(client, email):
        response = await client.post("/auth/dev/login", json={"email": email})
        assert response.status_code == 200, response.text
        return response.json()

    return sign_in


async def test_creating_via_the_api_returns_a_slug_and_owners_are_isolated(client, dev_login):
    await dev_login(client, "ana@example.com")
    mine = (await client.post("/v1/projects", json={"name": "Production"})).json()["project"]
    again = (await client.post("/v1/projects", json={"name": "Production"})).json()["project"]
    assert mine["slug"] == "production" and again["slug"] == "production-2"
    assert mine["project_id"] != mine["slug"]
    renamed = (await client.patch(f"/v1/projects/{mine['project_id']}", json={"name": "Shop"})).json()
    assert renamed["slug"] == "production"  # stable: a rename does not move the address
    assert [p["slug"] for p in (await client.get("/v1/projects")).json()] == ["production", "production-2"]

    client.cookies.clear()
    await dev_login(client, "ben@example.com")
    theirs = (await client.post("/v1/projects", json={"name": "Production"})).json()["project"]
    assert theirs["slug"] == "production" and theirs["project_id"] != mine["project_id"]
    # Ben cannot read Ana's project by its id, and the API has no lookup by slug at all.
    assert (await client.get(f"/v1/projects/{mine['project_id']}")).status_code in (403, 404)
    assert (await client.get("/v1/projects/production")).status_code in (403, 404)
    assert [p["project_id"] for p in (await client.get("/v1/projects")).json()] == [theirs["project_id"]]


async def test_migration_0022_backfills_existing_rows_then_downgrades(engine, migrated_url, monkeypatch):
    monkeypatch.setenv("DATABASE_URL", migrated_url)
    cfg = Config(str(ROOT / "alembic.ini"))
    cfg.set_main_option("script_location", str(ROOT / "migrations"))

    def run(action, rev):
        getattr(command, action)(cfg, rev)

    async def column_names(conn):
        return {r[0] for r in (await conn.execute(text(
            "SELECT column_name FROM information_schema.columns WHERE table_name='projects'"))).all()}

    owner, other = uuid.uuid4(), uuid.uuid4()
    try:
        await asyncio.to_thread(run, "downgrade", "0021")
        async with engine.begin() as conn:
            assert "slug" not in await column_names(conn)
            for u in (owner, other):
                await conn.execute(text("INSERT INTO users (user_id, google_sub, email) VALUES (:u, :s, :e)"),
                                   {"u": u, "s": f"s-{u}", "e": f"{u}@example.com"})
            rows = [("p-1", "Production", owner, "2026-01-01"), ("p-2", "Production", owner, "2026-01-02"),
                    ("p-3", "New", owner, "2026-01-03"), ("p-4", "☕", owner, "2026-01-04"),
                    ("p-5", "Production", other, "2026-01-05"), ("p-6", None, other, "2026-01-06"),
                    ("demo", None, None, "2026-01-07"), ("Weird_ID", "Weird", None, "2026-01-08")]
            for pid, name, o, at in rows:
                await conn.execute(text(
                    "INSERT INTO projects (project_id, api_key_hash, name, owner_user_id, created_at) "
                    "VALUES (:p, 'x', :n, :o, :c)"), {"p": pid, "n": name, "o": o, "c": datetime.fromisoformat(at + "T00:00:00+00:00")})
        await asyncio.to_thread(run, "upgrade", "head")
        async with engine.connect() as conn:
            got = dict((await conn.execute(text("SELECT project_id, slug FROM projects"))).all())
            nullable = (await conn.execute(text(
                "SELECT is_nullable FROM information_schema.columns "
                "WHERE table_name='projects' AND column_name='slug'"))).scalar_one()
            idx = {r[0] for r in (await conn.execute(text(
                "SELECT indexname FROM pg_indexes WHERE tablename='projects'"))).all()}
        assert got == {"p-1": "production", "p-2": "production-2", "p-3": "new-2", "p-4": "project",
                       "p-5": "production", "p-6": "p-6", "demo": "demo", "Weird_ID": "weird"}
        assert nullable == "NO" and {"uq_projects_owner_slug", "uq_projects_ownerless_slug"} <= idx
        await asyncio.to_thread(run, "downgrade", "0021")
        async with engine.connect() as conn:
            assert "slug" not in await column_names(conn)
    finally:
        await asyncio.to_thread(run, "upgrade", "head")
        async with engine.begin() as conn:
            await conn.execute(text("DELETE FROM projects"))
            await conn.execute(text("DELETE FROM users"))
