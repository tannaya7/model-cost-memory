"""The live data-flow trail: every step a run takes, as polled JSON and as Server-Sent Events."""

import json
import uuid
from datetime import UTC, datetime, timedelta

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import async_sessionmaker

from agent_memory.api import stream_flow
from agent_memory.models import FlowEvent, Project
from agent_memory.pipeline import flow
from agent_memory.pipeline.sync_worker import run_once
from agent_memory.embeddings import HashingEmbedder
from agent_memory.config import Settings
from agent_memory.projects import create_project


async def setup(client, session):
    _, key = await create_project(session, "flowdemo")
    headers = {"X-API-Key": key}
    await client.post("/v1/jobs", headers=headers,
                      json={"name": "invoice", "check_kind": "ANSWER_KEY", "check_config": {"fields": ["total"]}})
    run_id = str(uuid.uuid4())
    await client.post("/v1/runs", headers=headers, json={
        "run_id": run_id, "job": "invoice", "prompt": "Invoice 1 total?", "model": "mini",
        "model_version": "mini-2026-09", "output": '{"total": 5}', "expected": {"total": 4}})
    return headers, run_id


async def test_a_run_leaves_a_trail_through_each_stage(client, session, engine):
    headers, run_id = await setup(client, session)
    await run_once(async_sessionmaker(engine, expire_on_commit=False), HashingEmbedder(), Settings())
    events = (await client.get("/v1/flow", headers=headers)).json()
    assert [e["stage"] for e in events] == ["sdk", "api", "check", "index"]
    assert {e["run_id"] for e in events} == {run_id}
    assert events[2]["message"].startswith("Check failed: total") and events[2]["data"] == {"outcome": "FAIL"}
    after = (await client.get(f"/v1/flow?after={events[1]['event_id']}", headers=headers)).json()
    assert [e["stage"] for e in after] == ["check", "index"]


async def test_another_projects_trail_is_invisible(client, session):
    await setup(client, session)
    _, other = await create_project(session, "someone-else")
    assert (await client.get("/v1/flow", headers={"X-API-Key": other})).json() == []


async def test_old_events_are_purged_after_a_day(client, session):
    await setup(client, session)
    await session.execute(update(FlowEvent).values(ts=datetime.now(UTC) - timedelta(days=2)))
    await session.commit()
    assert await flow.purge(session) == 3
    assert (await session.execute(select(FlowEvent))).scalars().all() == []


class OnePoll:
    """A request that disconnects after the stream's first poll."""

    method = "GET"

    def __init__(self):
        self.calls = 0

    async def is_disconnected(self):
        self.calls += 1
        return self.calls > 1


async def test_the_stream_sends_server_sent_events_and_resumes_from_last_event_id(client, session):
    await setup(client, session)
    project = await session.get(Project, "flowdemo")
    response = await stream_flow(OnePoll(), last_event_id=None, project=project, session=session)
    assert response.media_type == "text/event-stream"
    frames = [chunk async for chunk in response.body_iterator]
    assert len(frames) == 3 and all(f.startswith("id: ") and f.endswith("\n\n") for f in frames)
    first = json.loads(frames[0].split("data: ", 1)[1])
    assert first["stage"] == "sdk"

    project = await session.get(Project, "flowdemo")  # a new request loads it afresh
    resumed = await stream_flow(OnePoll(), last_event_id=str(first["event_id"] + 1), project=project, session=session)
    frames = [chunk async for chunk in resumed.body_iterator]
    assert [json.loads(f.split("data: ", 1)[1])["stage"] for f in frames] == ["check"]
