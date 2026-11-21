"""The plain web request shown to developers works exactly as written, from any language: same fields, same header.

The body below is the one in the Connect guide (frontend/src/features/jobs/components/ConnectGuide.tsx). If the API changes so
that this stops being accepted, the guide is wrong and must change with it."""

import uuid

from agent_memory.models import Job, Project
from agent_memory.security import generate_key, hash_key


async def test_the_documented_web_request_is_accepted_with_only_the_fields_it_shows(client, session):
    key = generate_key()
    session.add(Project(project_id="acme", api_key_hash=hash_key(key)))
    await session.flush()
    session.add(Job(project_id="acme", name="read-invoices", check_kind="LATE_LABEL", check_config={}))
    await session.commit()
    body = {
        "run_id": str(uuid.uuid4()), "job": "read-invoices", "prompt": "the text your app sent to the AI",
        "output": "the answer the AI gave back", "model": "my-model", "model_version": "my-model-2026-01-01",
        "provider": "openai", "tokens_in": 1200, "tokens_out": 85, "latency_ms": 840,
    }
    r = await client.post("/v1/runs", headers={"X-API-Key": key, "Content-Type": "application/json"}, json=body)
    assert r.status_code == 202, r.text
    # the same request sent twice is recognised as the same call, not counted twice
    again = await client.post("/v1/runs", headers={"X-API-Key": key}, json=body)
    assert again.status_code in (200, 202)
    listed = (await client.get("/v1/runs", headers={"X-API-Key": key})).json()["items"]
    assert len(listed) == 1 and listed[0]["tokens_in"] == 1200 and listed[0]["tokens_out"] == 85


async def test_the_request_can_use_a_bearer_header_and_a_wrong_task_name_is_refused_plainly(client, session):
    key = generate_key()
    session.add(Project(project_id="acme", api_key_hash=hash_key(key)))
    await session.flush()
    session.add(Job(project_id="acme", name="read-invoices", check_kind="LATE_LABEL", check_config={}))
    await session.commit()
    base = {"prompt": "p", "model": "m", "model_version": "m-1", "tokens_in": 1, "tokens_out": 1}
    ok = await client.post("/v1/runs", headers={"Authorization": f"Bearer {key}"},
                           json={**base, "run_id": str(uuid.uuid4()), "job": "read-invoices"})
    assert ok.status_code == 202
    wrong = await client.post("/v1/runs", headers={"X-API-Key": key}, json={**base, "run_id": str(uuid.uuid4()), "job": "read-invoice"})
    assert wrong.status_code == 404  # a misspelled task name is refused, never silently made into a new task
