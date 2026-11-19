"""Indexes, not just columns: the migrations, the ORM and db/schema.sql must describe the same indexes on a real Postgres.

An index that exists only in the ORM or only in schema.sql is a query that is fast in tests and slow in production (or the reverse), and a
UNIQUE index that is missing is a rule that is not enforced. This runs on the isolated test database that pgserver starts for the suite, never on
a real one.

Also a rule for future migrations: building a plain index on a table that grows without bound (runs, outbox, flow_events) blocks writes while
it builds, so the migration must say CONCURRENTLY (inside an autocommit block) or say why it need not."""

import re
from pathlib import Path

from sqlalchemy import text

from agent_memory.models import Base

ROOT = Path(__file__).resolve().parents[1]
SCHEMA_SQL = ROOT / "db" / "schema.sql"

INDEXES = """
    SELECT tablename, indexname, indexdef FROM pg_indexes WHERE schemaname = :schema ORDER BY tablename, indexname
"""


def shape(indexdef: str) -> tuple[bool, str, str]:
    """(unique, the column/expression list, the WHERE predicate) with whitespace and the schema name removed, so two definitions compare."""
    unique = " UNIQUE INDEX " in indexdef
    inside = re.search(r"\((.*)\)(?: WHERE (.*))?$", indexdef)
    cols = re.sub(r"\s+", " ", inside.group(1)).strip() if inside else ""
    where = re.sub(r"\s+", " ", (inside.group(2) or "")).strip().strip("()") if inside else ""
    return unique, cols, where


async def definitions(conn, schema: str) -> dict[tuple[str, str], tuple[bool, str, str]]:
    rows = (await conn.execute(text(INDEXES), {"schema": schema})).all()
    return {(t, n): shape(d) for t, n, d in rows}


async def test_every_index_the_orm_declares_exists_in_the_migrated_database(engine):
    async with engine.connect() as conn:
        found = await definitions(conn, "public")
    names = {n for _, n in found}
    missing = []
    for table in Base.metadata.tables.values():
        for index in table.indexes:
            if index.name not in names:
                missing.append(f"{table.name}.{index.name}")
    assert not missing, f"declared in the ORM but not created by the migrations: {missing}"


async def test_unique_indexes_in_the_orm_are_unique_in_the_database(engine):
    async with engine.connect() as conn:
        found = await definitions(conn, "public")
    by_name = {n: v for (_, n), v in found.items()}
    wrong = [i.name for t in Base.metadata.tables.values() for i in t.indexes if i.unique and i.name in by_name and not by_name[i.name][0]]
    assert not wrong, f"declared unique in the ORM, not unique in the database: {wrong}"


async def test_schema_sql_creates_the_same_indexes_as_the_migrations(engine):
    """The by-hand path (psql with db/schema.sql) must not drift from what the migrations build."""
    async with engine.begin() as conn:
        await conn.execute(text("DROP SCHEMA IF EXISTS idxcheck CASCADE"))
        await conn.execute(text("CREATE SCHEMA idxcheck"))
        await conn.execute(text("SET LOCAL search_path TO idxcheck, public"))
        raw = await conn.get_raw_connection()
        await raw.driver_connection.execute(SCHEMA_SQL.read_text(encoding="utf8"))
        by_hand = await definitions(conn, "idxcheck")
        migrated = await definitions(conn, "public")
        await conn.execute(text("DROP SCHEMA idxcheck CASCADE"))
    # alembic_version's own key and constraint-backed indexes appear in both; compare by name, uniqueness and columns
    only_hand = sorted(set(by_hand) - set(migrated))
    only_migrated = sorted(set(migrated) - set(by_hand) - {("alembic_version", "alembic_version_pkc")})
    assert not only_hand, f"in db/schema.sql but not created by the migrations: {only_hand}"
    assert not only_migrated, f"created by the migrations but missing from db/schema.sql: {only_migrated}"
    differ = {k: (by_hand[k], migrated[k]) for k in by_hand if k in migrated and by_hand[k][:2] != migrated[k][:2]}
    assert not differ, f"same name, different definition: {differ}"


async def test_the_hot_lookups_have_their_indexes(engine):
    """The queries every request makes: a run by project and time, a key by its hash, a job by name, a slug within a workspace."""
    async with engine.connect() as conn:
        found = await definitions(conn, "public")
    on = {(t, c) for (t, _), (_, c, _) in found.items()}
    wanted = [("projects", "api_key_hash"), ("runs", "run_id"), ("jobs", "project_id, name"), ("memberships", "user_id")]
    for table, cols in wanted:
        assert any(t == table and cols in c for t, c in on), f"no index on {table}({cols})"


BIG_TABLES = ("runs", "outbox", "flow_events", "retests", "alerts")


def test_a_new_migration_does_not_build_a_plain_index_on_a_table_that_grows_without_bound():
    """Migrations from 0030 on only. Older ones ran when the tables were empty. A plain CREATE INDEX blocks inserts while it builds; on the
    runs table that means ingestion stops. Use CREATE INDEX CONCURRENTLY inside op.get_context().autocommit_block(), or add the marker
    `# index-ok: <why a plain index is safe>` on the line."""
    bad = []
    for path in sorted((ROOT / "migrations" / "versions").glob("*.py")):
        number = int(path.name.split("_")[0])
        if number < 30:
            continue
        for line in path.read_text(encoding="utf8").splitlines():
            if re.search(r"CREATE (UNIQUE )?INDEX", line, re.I) and "CONCURRENTLY" not in line.upper() and "index-ok" not in line:
                if any(re.search(rf"\bON\s+{t}\b", line, re.I) for t in BIG_TABLES):
                    bad.append(f"{path.name}: {line.strip()[:100]}")
    assert not bad, bad
