"""The Alembic baseline, the ORM and db/schema.sql all describe the same database."""

import uuid
from pathlib import Path

import pytest
from sqlalchemy import text
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.exc import IntegrityError

from agent_memory.models import Base, Job, Project, Run

SCHEMA_SQL = Path(__file__).resolve().parents[1] / "db" / "schema.sql"

COLUMNS = """
    SELECT table_name, column_name FROM information_schema.columns
    WHERE table_schema = :schema ORDER BY table_name, column_name
"""


async def columns(conn, schema: str) -> dict[str, set[str]]:
    out: dict[str, set[str]] = {}
    for table, column in (await conn.execute(text(COLUMNS), {"schema": schema})).all():
        out.setdefault(table, set()).add(column)
    return out


async def test_baseline_creates_the_seven_tables(engine):
    async with engine.connect() as conn:
        found = await columns(conn, "public")
    assert set(found) == set(Base.metadata.tables) | {"alembic_version"}


async def test_orm_models_match_the_migrated_database(engine):
    async with engine.connect() as conn:
        found = await columns(conn, "public")
    for name, table in Base.metadata.tables.items():
        assert found[name] == set(table.c.keys()), f"{name} differs between the ORM and the database"


async def test_schema_sql_matches_the_migration(engine):
    """Applying db/schema.sql by hand (the Neon psql path) gives the same tables and columns."""
    sql = SCHEMA_SQL.read_text(encoding="utf8")
    async with engine.begin() as conn:
        await conn.execute(text("DROP SCHEMA IF EXISTS sqlcheck CASCADE"))
        await conn.execute(text("CREATE SCHEMA sqlcheck"))
        await conn.execute(text("SET LOCAL search_path TO sqlcheck, public"))
        raw = await conn.get_raw_connection()
        await raw.driver_connection.execute(sql)
        by_hand = await columns(conn, "sqlcheck")
        migrated = await columns(conn, "public")
        await conn.execute(text("DROP SCHEMA sqlcheck CASCADE"))
    migrated.pop("alembic_version")
    assert by_hand == migrated


async def test_a_run_round_trips_with_its_defaults(session):
    session.add(Project(project_id="demo", api_key_hash="x"))
    await session.flush()  # no ORM relationships, so parents are flushed explicitly
    job = Job(project_id="demo", name="invoice-extract", check_kind="ANSWER_KEY", check_config={})
    session.add(job)
    await session.flush()
    run_id = uuid.uuid4()
    session.add(
        Run(run_id=run_id, job_id=job.job_id, project_id="demo", prompt="p", prompt_hash="h",
            model="m", model_version="v1")
    )
    await session.commit()
    session.expunge_all()

    row = await session.get(Run, run_id)
    assert row.outcome == "UNKNOWN"
    assert row.state == "CAPTURED"
    assert row.run_kind == "PRODUCTION"
    assert row.tokens_in == 0 and row.cache_read_tokens == 0
    assert row.created_at is not None


async def test_a_retried_send_does_not_create_a_second_run(session):
    session.add(Project(project_id="demo", api_key_hash="x"))
    await session.flush()  # no ORM relationships, so parents are flushed explicitly
    job = Job(project_id="demo", name="j", check_kind="SCHEMA", check_config={})
    session.add(job)
    await session.flush()
    values = dict(run_id=uuid.uuid4(), job_id=job.job_id, project_id="demo", prompt="p",
                  prompt_hash="h", model="m", model_version="v1")
    stmt = insert(Run).values(**values).on_conflict_do_nothing(index_elements=["run_id"])
    first = await session.execute(stmt)
    second = await session.execute(stmt)  # the SDK retried the same run
    await session.commit()
    assert first.rowcount == 1 and second.rowcount == 0
    count = (await session.execute(text("SELECT count(*) FROM runs"))).scalar_one()
    assert count == 1


async def test_the_database_rejects_bad_values(session):
    session.add(Project(project_id="demo", api_key_hash="x"))
    await session.flush()
    session.add(Job(project_id="demo", name="j", check_kind="NOT_A_KIND", check_config={}))
    with pytest.raises(IntegrityError):
        await session.commit()
