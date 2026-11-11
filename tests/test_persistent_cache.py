"""The persistent embedding cache: a prompt is never embedded twice, even after a restart."""

import hashlib
import uuid

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker

from agent_memory.config import Settings
from agent_memory.embeddings import HashingEmbedder
from agent_memory.models import Job, OutboxRow, Project, Run
from agent_memory.pipeline.sync_worker import run_once
from agent_memory.storage.vector_store import PgVectorClient

SETTINGS = Settings(outbox_batch_size=16, outbox_max_retries=3)
PROMPT = "Extract the vendor and total from this invoice: ShopCo INV-1042 total 1250"


def digest(text):
    return hashlib.sha256(text.encode()).hexdigest()


class Embedder:
    """Counts how many texts it was asked to embed; behaves like the hashing embedder."""

    def __init__(self, name="hashing"):
        self.name, self.dim, self.embedded = name, 384, []

    def embed(self, texts):
        self.embedded.extend(texts)
        return HashingEmbedder().embed(texts)


@pytest.fixture
def sessions(engine):
    return async_sessionmaker(engine, expire_on_commit=False)


@pytest.fixture
async def world(session):
    for pid in ("demo", "other"):
        session.add(Project(project_id=pid, api_key_hash=pid))
    await session.flush()
    jobs = {pid: Job(project_id=pid, name="j", check_kind="LATE_LABEL", check_config={}) for pid in ("demo", "other")}
    session.add_all(jobs.values())
    await session.flush()

    async def add(prompt, project="demo"):
        run_id = uuid.uuid4()
        session.add(Run(run_id=run_id, job_id=jobs[project].job_id, project_id=project, prompt=prompt,
                        prompt_hash=digest(prompt), model="m", model_version="v", state="CHECKED"))
        await session.flush()
        session.add(OutboxRow(run_id=run_id, op="UPSERT", payload={}))
        await session.commit()
        return run_id

    return add


async def get(session, run_id):
    session.expunge_all()
    return await session.get(Run, run_id)


async def test_a_prompt_embedded_before_a_restart_is_not_embedded_again(sessions, session, world):
    first = await world(PROMPT)
    before_restart = Embedder()
    assert (await run_once(sessions, before_restart, SETTINGS)).cached == 0
    assert before_restart.embedded == [PROMPT]

    second = await world(PROMPT)  # the same prompt arrives after the worker restarted: a brand-new embedder object
    after_restart = Embedder()
    stats = await run_once(sessions, after_restart, SETTINGS)
    assert (stats.done, stats.cached) == (1, 1)
    assert after_restart.embedded == []  # nothing was sent to the model
    a, b = await get(session, first), await get(session, second)
    assert list(a.embedding) == list(b.embedding) and b.state == "INDEXED"
    assert (a.embedding_model, b.embedding_model) == ("hashing", "hashing")


async def test_only_the_new_prompts_in_a_mixed_batch_are_embedded(sessions, session, world):
    await world(PROMPT)
    await run_once(sessions, Embedder(), SETTINGS)
    await world(PROMPT)
    await world("a prompt nobody has embedded yet")
    embedder = Embedder()
    stats = await run_once(sessions, embedder, SETTINGS)
    assert (stats.done, stats.cached) == (2, 1)
    assert embedder.embedded == ["a prompt nobody has embedded yet"]


async def test_a_vector_from_a_different_embedder_is_never_reused(sessions, session, world):
    await world(PROMPT)
    await run_once(sessions, Embedder("hashing"), SETTINGS)
    second = await world(PROMPT)
    other = Embedder("minilm")  # a different embedder lives in a different vector space
    stats = await run_once(sessions, other, SETTINGS)
    assert stats.cached == 0 and other.embedded == [PROMPT]
    assert (await get(session, second)).embedding_model == "minilm"


async def test_a_vector_is_never_reused_across_projects(sessions, session, world):
    await world(PROMPT, project="demo")
    await run_once(sessions, Embedder(), SETTINGS)
    theirs = await world(PROMPT, project="other")
    embedder = Embedder()
    stats = await run_once(sessions, embedder, SETTINGS)
    assert stats.cached == 0 and embedder.embedded == [PROMPT]
    assert (await get(session, theirs)).embedding is not None


async def test_two_identical_prompts_in_the_same_first_batch_are_both_indexed(sessions, session, world):
    a, b = await world(PROMPT), await world(PROMPT)
    stats = await run_once(sessions, Embedder(), SETTINGS)
    assert stats.done == 2
    assert (await get(session, a)).embedding is not None and (await get(session, b)).embedding is not None


async def test_reprocessing_a_run_reuses_its_own_vector(sessions, session, world):
    run_id = await world(PROMPT)
    await run_once(sessions, Embedder(), SETTINGS)
    session.add(OutboxRow(run_id=run_id, op="UPSERT", payload={}))  # a duplicate receipt
    await session.commit()
    embedder = Embedder()
    stats = await run_once(sessions, embedder, SETTINGS)
    assert (stats.done, stats.cached) == (1, 1) and embedder.embedded == []


async def test_the_store_reports_cached_vectors_by_prompt_hash(sessions, session, world):
    await world(PROMPT)
    await run_once(sessions, Embedder(), SETTINGS)
    async with sessions() as s:
        store = PgVectorClient(s)
        found = await store.cached_vectors("demo", [digest(PROMPT), digest("never seen")], "hashing")
        assert set(found) == {digest(PROMPT)} and len(found[digest(PROMPT)]) == 384
        assert await store.cached_vectors("demo", [digest(PROMPT)], "minilm") == {}
        assert await store.cached_vectors("other", [digest(PROMPT)], "hashing") == {}
        assert await store.cached_vectors("demo", [], "hashing") == {}


async def test_search_can_be_limited_to_vectors_from_one_embedder(sessions, session, world):
    a = await world(PROMPT)
    await run_once(sessions, Embedder("hashing"), SETTINGS)
    b = await world(PROMPT + " (second wording)")
    await run_once(sessions, Embedder("minilm"), SETTINGS)
    vec = HashingEmbedder().embed([PROMPT])[0]
    async with sessions() as s:
        store = PgVectorClient(s)
        every = {h.run_id for h in await store.search(vec, project_id="demo")}
        only_hashing = {h.run_id for h in await store.search(vec, project_id="demo", model="hashing")}
        only_minilm = {h.run_id for h in await store.search(vec, project_id="demo", model="minilm")}
    assert every == {a, b} and only_hashing == {a} and only_minilm == {b}


async def test_removing_a_run_from_search_also_clears_which_embedder_made_it(sessions, session, world):
    run_id = await world(PROMPT)
    await run_once(sessions, Embedder(), SETTINGS)
    async with sessions() as s:
        await PgVectorClient(s).delete(run_id)
        await s.commit()
    run = await get(session, run_id)
    assert run.embedding is None and run.embedding_model is None
    assert (await session.execute(select(Run.run_id))).scalars().all() == [run_id]  # the run itself is kept
