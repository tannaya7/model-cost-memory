"""Week 3 deliverable: a real model call captured end to end.

The SDK runs in this process, the API runs as a real HTTP server in a thread, and both talk to a
real Postgres. Nothing is mocked between the recorder and the database.
"""

import asyncio
import socket
import threading
import time
from types import SimpleNamespace

import httpx
import pytest
import uvicorn
from sqlalchemy import select

from agent_memory import db
from agent_memory.api import app
from agent_memory.models import OutboxRow, Run
from agent_memory.projects import create_project
from agent_memory.recorder import RunRecorder, Sender


@pytest.fixture
def live_server(migrated_url, monkeypatch):
    monkeypatch.setenv("DATABASE_URL", migrated_url)
    db._engine = None  # the API process builds its own engine from DATABASE_URL
    db._sessions = None
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        port = s.getsockname()[1]
    server = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=port, log_level="warning"))
    thread = threading.Thread(target=server.run, daemon=True)
    thread.start()
    deadline = time.monotonic() + 15
    while not server.started and time.monotonic() < deadline:
        time.sleep(0.05)
    assert server.started, "the test server did not start"
    yield f"http://127.0.0.1:{port}"
    server.should_exit = True
    thread.join(timeout=10)
    db._engine = None
    db._sessions = None


async def test_a_call_recorded_by_the_sdk_appears_in_the_api_and_the_database(live_server, session):
    _, key = await create_project(session, "e2e-demo")
    headers = {"X-API-Key": key}
    async with httpx.AsyncClient(base_url=live_server) as api:
        job = {"name": "invoice-extract", "check_kind": "ANSWER_KEY", "check_config": {"fields": ["total"]}}
        assert (await api.post("/v1/jobs", json=job, headers=headers)).status_code == 201

        # the application's own model call, as an SDK response
        response = SimpleNamespace(
            model="small-2026-09",
            usage=SimpleNamespace(prompt_tokens=900, completion_tokens=60,
                                  prompt_tokens_details=SimpleNamespace(cached_tokens=0)),
            choices=[SimpleNamespace(message=SimpleNamespace(content='{"total": 12.5}'))],
        )
        sender = Sender(live_server, key)
        with RunRecorder(job="invoice-extract", sender=sender) as rec:
            rec.capture(response, prompt="Extract the total from this invoice.", model="small")
        assert await asyncio.to_thread(sender.flush, 10)
        assert sender.sent == 1 and sender.dropped == 0
        sender.close()

        listed = (await api.get("/v1/runs", headers=headers)).json()["items"]
        assert len(listed) == 1
        run = listed[0]
        assert run["job"] == "invoice-extract" and run["model"] == "small"
        assert run["model_version"] == "small-2026-09" and run["tokens_in"] == 900
        assert run["outcome"] == "UNKNOWN" and run["state"] == "CAPTURED"
        assert run["latency_ms"] is not None

        jobs = (await api.get("/v1/jobs", headers=headers)).json()
        assert jobs[0]["run_count"] == 1 and jobs[0]["runs_by_state"] == {"CAPTURED": 1}

    stored = (await session.execute(select(Run))).scalar_one()
    outbox = (await session.execute(select(OutboxRow))).scalar_one()
    assert outbox.run_id == stored.run_id and outbox.status == "PENDING"
