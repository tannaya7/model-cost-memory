"""The prompt hash is keyed per project, so a deleted prompt cannot be guessed back and equal prompts in two projects differ.

Rows made before the change are converted from their plain hash, with no text needed, and converting never happens twice."""

import asyncio
import hashlib
import re
import uuid
from pathlib import Path

import pytest
from alembic import command
from alembic.config import Config
from sqlalchemy import select, text

from agent_memory.ingest import plain_prompt_hash, prompt_hash
from agent_memory.models import Job, Project, Run
from agent_memory.security import NO_SECRET_PROMPT_KEY, generate_key, hash_key, keyed_prompt_hash

ROOT = Path(__file__).resolve().parents[1]
PROMPT = "Reply to jane@example.com about invoice 4471"


def test_the_stored_value_is_not_the_plain_hash_and_cannot_be_got_by_hashing_the_text():
    stored = prompt_hash(PROMPT, "acme", "server-secret")
    plain = hashlib.sha256(PROMPT.encode()).hexdigest()
    assert re.fullmatch(r"[0-9a-f]{64}", stored) and stored != plain
    assert plain_prompt_hash(PROMPT) == plain


def test_the_same_prompt_in_the_same_project_always_matches_and_in_another_project_does_not():
    assert prompt_hash(PROMPT, "acme", "k") == prompt_hash(PROMPT, "acme", "k")
    assert prompt_hash(PROMPT, "acme", "k") != prompt_hash(PROMPT, "other", "k")
    assert prompt_hash(PROMPT, "acme", "k") != prompt_hash(PROMPT + ".", "acme", "k")


def test_without_the_servers_secret_the_value_cannot_be_recomputed():
    assert prompt_hash(PROMPT, "acme", "secret-one") != prompt_hash(PROMPT, "acme", "secret-two")


def test_a_laptop_with_no_secret_still_matches_itself_between_restarts():
    assert prompt_hash(PROMPT, "acme", "") == keyed_prompt_hash("acme", plain_prompt_hash(PROMPT), "")
    assert NO_SECRET_PROMPT_KEY  # a fixed development string, not a secret


def test_a_row_converted_from_its_plain_hash_equals_a_new_row_made_from_the_same_text():
    plain = plain_prompt_hash(PROMPT)  # all an old row kept: its text may be deleted
    assert keyed_prompt_hash("acme", plain, "server-secret") == prompt_hash(PROMPT, "acme", "server-secret")


async def test_an_ingested_call_stores_the_keyed_value_and_is_version_2(client, session):
    key = generate_key()
    session.add(Project(project_id="demo", api_key_hash=hash_key(key)))
    await session.commit()
    headers = {"X-API-Key": key}
    await client.post("/v1/jobs", json={"name": "t", "check_kind": "ANSWER_KEY", "check_config": {"fields": ["x"]}}, headers=headers)
    body = {"run_id": str(uuid.uuid4()), "job": "t", "prompt": PROMPT, "model": "m", "model_version": "m-1", "tokens_in": 1, "tokens_out": 1}
    assert (await client.post("/v1/runs", json=body, headers=headers)).status_code == 202
    stored = (await session.execute(select(Run))).scalar_one()
    assert stored.hash_version == 2
    assert stored.prompt_hash == prompt_hash(PROMPT, "demo") and stored.prompt_hash != plain_prompt_hash(PROMPT)


async def test_the_migration_converts_old_rows_from_their_hash_alone_and_never_twice(engine, migrated_url, monkeypatch):
    monkeypatch.setenv("DATABASE_URL", migrated_url)
    monkeypatch.setenv("SECRET_KEY", "migration-test-secret")
    cfg = Config(str(ROOT / "alembic.ini"))
    cfg.set_main_option("script_location", str(ROOT / "migrations"))

    def run(action, rev):
        getattr(command, action)(cfg, rev)

    plain = plain_prompt_hash(PROMPT)
    job_id, run_a, run_b = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
    try:
        await asyncio.to_thread(run, "downgrade", "0036")
        async with engine.begin() as conn:
            assert (await conn.execute(text("SELECT count(*) FROM information_schema.columns WHERE table_name='runs' AND column_name='hash_version'"))).scalar_one() == 1
            for pid in ("mig-a", "mig-b"):
                await conn.execute(text("INSERT INTO projects (project_id, slug, api_key_hash) VALUES (:p, :s, 'h')"), {"p": pid, "s": pid})
            await conn.execute(text("INSERT INTO jobs (job_id, project_id, name, check_kind, check_config) VALUES (:j, 'mig-a', 't', 'ANSWER_KEY', '{}'::jsonb)"), {"j": job_id})
            for rid, pid in ((run_a, "mig-a"), (run_b, "mig-a")):  # the second is the same prompt, text already deleted by retention
                await conn.execute(text(
                    "INSERT INTO runs (run_id, job_id, project_id, prompt, prompt_hash, hash_version, model, model_version) "
                    "VALUES (:r, :j, :p, :t, :h, 1, 'm', 'v')"), {"r": rid, "j": job_id, "p": pid, "t": PROMPT if rid == run_a else None, "h": plain})
        await asyncio.to_thread(run, "upgrade", "0037")
        async with engine.connect() as conn:
            rows = (await conn.execute(text("SELECT prompt_hash, hash_version FROM runs WHERE project_id='mig-a'"))).all()
            expected = prompt_hash(PROMPT, "mig-a", "migration-test-secret")
            assert {r[0] for r in rows} == {expected} and {r[1] for r in rows} == {2}  # the deleted-text row matches too
        await asyncio.to_thread(run, "downgrade", "0036")  # a no-op by design
        await asyncio.to_thread(run, "upgrade", "0037")  # converting again must not key the keyed value
        async with engine.connect() as conn:
            again = (await conn.execute(text("SELECT DISTINCT prompt_hash FROM runs WHERE project_id='mig-a'"))).scalars().all()
            assert again == [expected]
    finally:
        async with engine.begin() as conn:
            await conn.execute(text("DELETE FROM runs WHERE project_id IN ('mig-a','mig-b')"))
            await conn.execute(text("DELETE FROM jobs WHERE project_id IN ('mig-a','mig-b')"))
            await conn.execute(text("DELETE FROM projects WHERE project_id IN ('mig-a','mig-b')"))
        await asyncio.to_thread(run, "upgrade", "head")


def test_nothing_stores_or_logs_a_plain_hash_any_more():
    stored = [p for p in (ROOT / "src" / "agent_memory").rglob("*.py") if "plain_prompt_hash(" in p.read_text(encoding="utf8")]
    assert sorted(p.name for p in stored) == ["ingest.py"]  # the plain hash is only the first step inside prompt_hash
    assert Job and pytest  # (imports kept for the fixtures above)
