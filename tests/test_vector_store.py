"""The VectorStoreClient contract, run against the pgvector implementation (embedded Postgres)."""

import uuid

import pytest

from agent_memory.embeddings import HashingEmbedder
from agent_memory.models import Job, Project, Run
from agent_memory.storage.vector_store import PgVectorClient

PROMPTS = {
    "invoice-a": "Extract the vendor, invoice number and total from this invoice: ShopCo INV-1042 total 1250",
    "invoice-b": "Extract the vendor, invoice number and total from this invoice: Acme INV-2208 total 310",
    "ticket": "Classify this support ticket as billing, bug or feature request: the app crashes on login",
}


@pytest.fixture
async def store(session):
    """Two projects; 'demo' has three runs (two invoice prompts, one ticket prompt) across two jobs."""
    for pid in ("demo", "other"):
        session.add(Project(project_id=pid, api_key_hash=pid))
    await session.flush()
    jobs = {}
    for pid, name in [("demo", "invoice-extract"), ("demo", "ticket-classify"), ("other", "invoice-extract")]:
        jobs[(pid, name)] = Job(project_id=pid, name=name, check_kind="LATE_LABEL", check_config={})
        session.add(jobs[(pid, name)])
    await session.flush()
    runs = {}
    for key, pid, job in [("invoice-a", "demo", "invoice-extract"), ("invoice-b", "demo", "invoice-extract"),
                          ("ticket", "demo", "ticket-classify")]:
        runs[key] = Run(run_id=uuid.uuid4(), job_id=jobs[(pid, job)].job_id, project_id=pid, prompt=PROMPTS[key],
                        prompt_hash=key, model="m", model_version="v")
        session.add(runs[key])
    foreign = Run(run_id=uuid.uuid4(), job_id=jobs[("other", "invoice-extract")].job_id, project_id="other",
                  prompt=PROMPTS["invoice-a"], prompt_hash="x", model="m", model_version="v")
    session.add(foreign)
    await session.commit()
    return PgVectorClient(session), runs, foreign, jobs


def vec(text):
    return HashingEmbedder().embed([text])[0]


async def test_upsert_then_search_finds_the_most_similar_run_first(store, session):
    client, runs, _, _ = store
    for key, run in runs.items():
        assert await client.upsert(run.run_id, vec(PROMPTS[key])) is True
    await session.commit()
    hits = await client.search(vec(PROMPTS["invoice-a"]), project_id="demo", top_k=3)
    assert [h.run_id for h in hits][:2] == [runs["invoice-a"].run_id, runs["invoice-b"].run_id]
    assert hits[0].similarity == pytest.approx(1.0, abs=1e-6)
    assert hits[-1].run_id == runs["ticket"].run_id and hits[0].similarity > hits[-1].similarity


async def test_upsert_is_idempotent_and_replaces_the_vector(store, session):
    client, runs, _, _ = store
    run = runs["invoice-a"]
    await client.upsert(run.run_id, vec("first"))
    await client.upsert(run.run_id, vec(PROMPTS["ticket"]))
    await session.commit()
    (hit,) = await client.search(vec(PROMPTS["ticket"]), project_id="demo", top_k=5)
    assert hit.run_id == run.run_id and hit.similarity == pytest.approx(1.0, abs=1e-6)


async def test_upserting_a_run_that_does_not_exist_reports_false(store):
    client, *_ = store
    assert await client.upsert(uuid.uuid4(), vec("x")) is False


async def test_search_never_crosses_projects(store, session):
    client, runs, foreign, _ = store
    await client.upsert(foreign.run_id, vec(PROMPTS["invoice-a"]))
    await client.upsert(runs["invoice-b"].run_id, vec(PROMPTS["invoice-b"]))
    await session.commit()
    mine = {h.run_id for h in await client.search(vec(PROMPTS["invoice-a"]), project_id="demo")}
    theirs = {h.run_id for h in await client.search(vec(PROMPTS["invoice-a"]), project_id="other")}
    assert foreign.run_id not in mine and mine == {runs["invoice-b"].run_id}
    assert theirs == {foreign.run_id}


async def test_search_can_be_limited_to_one_job_and_skips_unindexed_runs(store, session):
    client, runs, _, jobs = store
    for key in ("invoice-a", "ticket"):
        await client.upsert(runs[key].run_id, vec(PROMPTS[key]))
    await session.commit()
    only_tickets = await client.search(vec("anything"), project_id="demo", job_id=jobs[("demo", "ticket-classify")].job_id)
    assert [h.run_id for h in only_tickets] == [runs["ticket"].run_id]
    everything = await client.search(vec("anything"), project_id="demo", top_k=10)
    assert {h.run_id for h in everything} == {runs["invoice-a"].run_id, runs["ticket"].run_id}  # invoice-b has no vector


async def test_delete_removes_the_vector_but_keeps_the_run(store, session):
    client, runs, _, _ = store
    run = runs["invoice-a"]
    await client.upsert(run.run_id, vec(PROMPTS["invoice-a"]))
    await session.commit()
    await client.delete(run.run_id)
    await session.commit()
    assert await client.search(vec(PROMPTS["invoice-a"]), project_id="demo") == []
    session.expunge_all()
    assert (await session.get(Run, run.run_id)) is not None
