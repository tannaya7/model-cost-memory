"""Agents, traces and tool-definition cost: ingest round trip and GET /v1/insights/agents."""

import uuid
from datetime import UTC, datetime, timedelta
from decimal import Decimal

import pytest

from agent_memory.models import Job, Project, Run
from agent_memory.security import generate_key, hash_key


async def _world(session):
    key, other_key = generate_key(), generate_key()
    session.add_all([Project(project_id="acme", api_key_hash=hash_key(key)),
                     Project(project_id="other", api_key_hash=hash_key(other_key))])
    await session.flush()
    job = Job(project_id="acme", name="support", check_kind="LATE_LABEL", check_config={})
    elsewhere = Job(project_id="other", name="support", check_kind="LATE_LABEL", check_config={})
    session.add_all([job, elsewhere])
    await session.flush()
    now = datetime.now(UTC)

    def run(j, agent, trace, prompt, tin, tout=0, tools=None, days_ago=0, kind="PRODUCTION"):
        return Run(run_id=uuid.uuid4(), job_id=j.job_id, project_id=j.project_id, prompt=prompt, prompt_hash=prompt,
                   model="m", model_version="m-1", agent=agent, trace_id=trace, tokens_in=tin, tokens_out=tout,
                   cache_read_tokens=0, tools_tokens=tools, cost_usd=Decimal("0.01"), run_kind=kind,
                   created_at=now - timedelta(days=days_ago))

    session.add_all([
        run(job, "planner", "t1", "a", 100, 50, tools=40), run(job, "planner", "t1", "b", 100, 50, tools=60),
        run(job, "coder", "t1", "c", 200, 100),
        run(job, None, "loop", "same", 10), run(job, None, "loop", "same", 10), run(job, None, "loop", "same", 10),
        run(job, "coder", "t2", "x", 10), run(job, "coder", "t2", "x", 10),  # twice: not a loop
        run(job, "coder", "old", "o", 5000, days_ago=90), run(job, "coder", "rt", "o", 5000, kind="RETEST"),
        run(elsewhere, "spy", "t1", "z", 9999),
    ])
    await session.commit()
    return {"X-API-Key": key}, {"X-API-Key": other_key}


async def test_per_agent_totals_and_shares(client, session):
    headers, _ = await _world(session)
    body = (await client.get("/v1/insights/agents", headers=headers)).json()
    by = {a["agent"]: a for a in body["agents"]}
    assert set(by) == {"planner", "coder", "unlabelled"}  # no other project, no old or re-test runs
    assert (by["planner"]["runs"], by["planner"]["tokens_in"], by["planner"]["tokens_out"]) == (2, 200, 100)
    assert by["unlabelled"]["runs"] == 3 and by["coder"]["runs"] == 3
    assert by["planner"]["spend_usd"] == 0.02
    assert by["planner"]["share"] == pytest.approx(300 / 650)  # planner 300, coder 320, unlabelled 30
    assert sum(a["share"] for a in body["agents"]) == pytest.approx(1.0)
    assert body["agents"][0]["agent"] == "coder"  # biggest share first


async def test_traces_ranked_with_the_repeated_prompt_flag(client, session):
    headers, _ = await _world(session)
    traces = (await client.get("/v1/insights/agents", headers=headers)).json()["traces"]
    assert [t["trace_id"] for t in traces] == ["t1", "loop", "t2"]
    t1, loop, t2 = traces
    assert (t1["calls"], t1["tokens"], t1["agents"]) == (3, 600, 2) and not t1["repeated_prompts"]
    assert loop["repeated_prompts"] and loop["agents"] == 1 and loop["calls"] == 3
    assert not t2["repeated_prompts"]


async def test_tool_definitions_per_job(client, session):
    headers, _ = await _world(session)
    tools = (await client.get("/v1/insights/agents", headers=headers)).json()["tools"]
    assert tools == [{"job": "support", "runs": 2, "avg_tools_tokens": 50, "share_of_tokens_in": 0.5}]


async def test_projects_are_isolated(client, session):
    _, other = await _world(session)
    body = (await client.get("/v1/insights/agents", headers=other)).json()
    assert [a["agent"] for a in body["agents"]] == ["spy"]
    assert [t["trace_id"] for t in body["traces"]] == ["t1"] and body["tools"] == []


async def test_an_empty_project_and_a_missing_key(client, session):
    key = generate_key()
    session.add(Project(project_id="empty", api_key_hash=hash_key(key)))
    await session.commit()
    body = (await client.get("/v1/insights/agents", headers={"X-API-Key": key})).json()
    assert body["agents"] == [] and body["traces"] == [] and body["tools"] == [] and not body["kinds"]["uses_tools"]
    assert (await client.get("/v1/insights/agents")).status_code in (401, 403)


async def test_the_new_fields_round_trip_through_ingest(client, session):
    headers, _ = await _world(session)
    run_id = str(uuid.uuid4())
    sent = await client.post("/v1/runs", headers=headers, json={
        "run_id": run_id, "job": "support", "prompt": "hi", "model": "m", "model_version": "m-1",
        "agent": "router", "trace_id": "task-9", "tools_tokens": 123,
        "tool_calls": [{"id": "1", "name": "search"}, {"id": "2", "name": "fetch"}],
    })
    assert sent.status_code in (200, 201, 202), sent.text
    got = (await client.get(f"/v1/runs/{run_id}", headers=headers)).json()
    assert (got["agent"], got["trace_id"], got["tools_tokens"], got["tool_call_count"]) == ("router", "task-9", 123, 2)
    listed = (await client.get("/v1/runs", headers=headers)).json()["items"]
    assert any(r["run_id"] == run_id and r["agent"] == "router" for r in listed)


async def test_old_clients_without_the_fields_still_work(client, session):
    headers, _ = await _world(session)
    run_id = str(uuid.uuid4())
    sent = await client.post("/v1/runs", headers=headers, json={
        "run_id": run_id, "job": "support", "prompt": "hi", "model": "m", "model_version": "m-1"})
    assert sent.status_code in (200, 201, 202)
    got = (await client.get(f"/v1/runs/{run_id}", headers=headers)).json()
    assert got["agent"] is None and got["trace_id"] is None and got["tool_call_count"] is None


async def test_overlong_agent_is_rejected(client, session):
    headers, _ = await _world(session)
    sent = await client.post("/v1/runs", headers=headers, json={
        "run_id": str(uuid.uuid4()), "job": "support", "prompt": "hi", "model": "m", "model_version": "m-1",
        "agent": "a" * 101})
    assert sent.status_code == 422


async def test_labels_and_possible_loop_on_the_endpoint(client, session):
    key = generate_key()
    session.add(Project(project_id="lab", api_key_hash=hash_key(key)))
    await session.flush()
    job = Job(project_id="lab", name="bot", check_kind="LATE_LABEL", check_config={})
    session.add(job)
    await session.flush()
    now = datetime.now(UTC)

    def run(i, agent, trace, tool, prompt, tools_tokens=None):
        return Run(run_id=uuid.uuid4(), job_id=job.job_id, project_id="lab", prompt=prompt, prompt_hash=prompt,
                   model="m", model_version="m-1", agent=agent, trace_id=trace, tokens_in=10, tokens_out=5,
                   cache_read_tokens=0, cost_usd=Decimal("0.01"), run_kind="PRODUCTION", tools_tokens=tools_tokens,
                   tool_calls=[{"name": tool, "id": str(i)}] if tool else None, tool_call_count=1 if tool else None,
                   created_at=now - timedelta(minutes=60 - i))

    session.add_all(
        [run(i, "planner" if i % 2 else "coder", "spin", "mcp__github__search", "same", 400) for i in range(6)]
        + [run(10 + i, "coder", "ok", "search", f"q{i}") for i in range(3)])
    await session.commit()
    body = (await client.get("/v1/insights/agents", headers={"X-API-Key": key})).json()
    kinds = body["kinds"]
    assert kinds["uses_tools"] and kinds["works_like_agent"] == "yes" and kinds["multi_agent"]
    assert kinds["tool_source"] == "mcp" and kinds["tool_servers"] == ["github"]
    by = {t["trace_id"]: t for t in body["traces"]}
    assert by["spin"]["possible_loop"]["repeats"] == 6 and by["spin"]["multi_agent"]
    assert by["spin"]["possible_loop"]["uses_arguments"] is False
    assert by["ok"]["possible_loop"] is None and not by["ok"]["multi_agent"]
    coder = next(a for a in body["agents"] if a["agent"] == "coder")
    assert coder["models"] == ["m"] and coder["steps_per_task"] == 3.0
    assert {"name": "search", "calls": 3} in coder["top_tools"]


async def test_f24_a_big_trace_does_not_starve_loop_detection_of_the_others(session, monkeypatch):
    from agent_memory.insights import agents as mod

    monkeypatch.setattr(mod, "MAX_STEP_ROWS", 6)
    await session.execute(Project.__table__.insert().values(project_id="f24", api_key_hash=hash_key(generate_key())))
    job = Job(project_id="f24", name="j", check_kind="LATE_LABEL", check_config={})
    session.add(job)
    await session.flush()
    now = datetime.now(UTC)

    def run(trace, prompt, minutes_ago, tin):
        return Run(run_id=uuid.uuid4(), job_id=job.job_id, project_id="f24", prompt=prompt, prompt_hash=prompt,
                   model="m", model_version="m-1", trace_id=trace, tokens_in=tin, tokens_out=0, cache_read_tokens=0,
                   cost_usd=Decimal("0.01"), run_kind="PRODUCTION", created_at=now - timedelta(minutes=minutes_ago))

    session.add_all([run("big", f"p{i}", 600 - i, 1000) for i in range(20)]
                    + [run("loopy", "same", 30 - i, 10) for i in range(6)])
    await session.commit()
    result = await mod.agent_insights(session, "f24", now=now)
    by = {t.trace_id: t for t in result.traces}
    assert by["loopy"].possible_loop is not None and by["loopy"].possible_loop.repeats == 6
