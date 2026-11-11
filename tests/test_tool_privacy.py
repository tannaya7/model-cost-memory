"""Tool-call arguments are dropped by default, in the SDK and on the server."""

import json
import uuid
from types import SimpleNamespace

import httpx
import pytest
from sqlalchemy import select

from agent_memory.models import Project, Run
from agent_memory.privacy import MAX_FIELD_CHARS, MAX_TOOL_CALLS, sanitize_tool_calls
from agent_memory.projects import create_project
from agent_memory.recorder import RunRecorder, Sender, read_response

SECRET = "customer SSN 123-45-6789"


def test_only_names_and_ids_are_kept_by_default():
    calls = [{"id": "c1", "name": "lookup_customer", "arguments": {"ssn": SECRET}},
             {"call_id": "c2", "tool": "send_email", "input": {"body": SECRET}, "extra": "x"}]
    assert sanitize_tool_calls(calls) == [{"name": "lookup_customer", "id": "c1"}, {"name": "send_email", "id": "c2"}]
    assert SECRET not in json.dumps(sanitize_tool_calls(calls))


def test_arguments_are_kept_only_when_asked_for():
    calls = [{"id": "c1", "name": "lookup", "arguments": {"q": "x"}}, {"id": "c2", "name": "noargs"}]
    assert sanitize_tool_calls(calls, keep_arguments=True) == [
        {"name": "lookup", "id": "c1", "arguments": {"q": "x"}}, {"name": "noargs", "id": "c2"}]


def test_the_openai_nested_shape_is_understood():
    calls = [{"id": "c1", "type": "function", "function": {"name": "lookup", "arguments": '{"q": "secret"}'}}]
    assert sanitize_tool_calls(calls) == [{"name": "lookup", "id": "c1"}]
    assert sanitize_tool_calls(calls, keep_arguments=True)[0]["arguments"] == '{"q": "secret"}'


def test_junk_entries_are_dropped_and_the_list_is_bounded():
    assert sanitize_tool_calls(["nope", 3, None, {}, {"unrelated": 1}]) == []
    assert sanitize_tool_calls(None) is None and sanitize_tool_calls([]) == []
    many = [{"id": str(i), "name": "t"} for i in range(MAX_TOOL_CALLS + 50)]
    assert len(sanitize_tool_calls(many)) == MAX_TOOL_CALLS
    long = sanitize_tool_calls([{"name": "n" * 1000, "id": "i" * 1000}])[0]
    assert len(long["name"]) == MAX_FIELD_CHARS and len(long["id"]) == MAX_FIELD_CHARS


ANTHROPIC_STYLE = SimpleNamespace(
    model="m-2026-09", usage=SimpleNamespace(input_tokens=10, output_tokens=5),
    content=[SimpleNamespace(type="text", text="calling"),
             SimpleNamespace(type="tool_use", id="tu1", name="lookup", input={"ssn": SECRET})],
)
OPENAI_STYLE = SimpleNamespace(
    model="m-2026-09", usage=SimpleNamespace(prompt_tokens=10, completion_tokens=5),
    choices=[SimpleNamespace(message=SimpleNamespace(
        content=None, tool_calls=[SimpleNamespace(id="tc1", function=SimpleNamespace(name="lookup", arguments=SECRET))]))],
)


@pytest.mark.parametrize("response", [ANTHROPIC_STYLE, OPENAI_STYLE])
def test_the_sdk_reads_tool_calls_from_a_response_without_their_arguments(response):
    data = read_response(response)
    assert data["tool_calls"][0]["name"] == "lookup" and data["tool_calls"][0]["id"] in ("tu1", "tc1")
    assert SECRET not in json.dumps(data["tool_calls"]) and "arguments" not in data["tool_calls"][0]
    assert "arguments" in read_response(response, include_arguments=True)["tool_calls"][0]


def captured(handler_log, **recorder_kwargs):
    def server(request):
        handler_log.append(json.loads(request.content))
        return httpx.Response(202, json={})

    sender = Sender("http://api.test", "k", transport=httpx.MockTransport(server), backoff=0.0)
    with RunRecorder(job="j", sender=sender, **recorder_kwargs) as rec:
        rec.capture(ANTHROPIC_STYLE, prompt="p", model="m")
    sender.flush(3)
    sender.close()


def test_arguments_never_leave_the_application_unless_the_recorder_is_told_to_send_them():
    sent = []
    captured(sent)
    assert SECRET not in json.dumps(sent) and sent[0]["tool_calls"] == [{"name": "lookup", "id": "tu1"}]
    sent.clear()
    captured(sent, send_tool_arguments=True)
    assert sent[0]["tool_calls"][0]["arguments"] == {"ssn": SECRET}


def test_an_explicit_tool_call_list_gets_the_same_rule():
    sent = []

    def server(request):
        sent.append(json.loads(request.content))
        return httpx.Response(202, json={})

    sender = Sender("http://api.test", "k", transport=httpx.MockTransport(server), backoff=0.0)
    with RunRecorder(job="j", sender=sender) as rec:
        rec.capture(None, prompt="p", model="m", tool_calls=[{"id": "x", "name": "t", "arguments": SECRET}])
    sender.flush(3)
    sender.close()
    assert sent[0]["tool_calls"] == [{"name": "t", "id": "x"}]


async def run_with_tool_calls(client, headers):
    job = {"name": "j", "check_kind": "LATE_LABEL", "check_config": {}}
    await client.post("/v1/jobs", json=job, headers=headers)
    body = {"run_id": str(uuid.uuid4()), "job": "j", "prompt": "p", "model": "m", "model_version": "v",
            "tool_calls": [{"id": "c1", "name": "lookup", "arguments": {"ssn": SECRET}}, {"id": "c2", "name": "send"}]}
    assert (await client.post("/v1/runs", json=body, headers=headers)).status_code == 202


async def test_the_server_drops_arguments_for_a_project_that_has_not_opted_in(client, session):
    _, key = await create_project(session, "private-co")
    await run_with_tool_calls(client, {"X-API-Key": key})
    stored = (await session.execute(select(Run.tool_calls))).scalar_one()
    assert stored == [{"name": "lookup", "id": "c1"}, {"name": "send", "id": "c2"}]
    assert SECRET not in json.dumps(stored)


async def test_the_server_keeps_arguments_for_a_project_that_opted_in(client, session):
    project, key = await create_project(session, "open-co", store_tool_arguments=True)
    assert project.store_tool_arguments is True
    await run_with_tool_calls(client, {"X-API-Key": key})
    stored = (await session.execute(select(Run.tool_calls))).scalar_one()
    assert stored[0] == {"name": "lookup", "id": "c1", "arguments": {"ssn": SECRET}}
    assert stored[1] == {"name": "send", "id": "c2"}


async def test_projects_default_to_not_storing_arguments(session):
    project, _ = await create_project(session, "default-co")
    stored = (await session.execute(select(Project.store_tool_arguments).where(Project.project_id == "default-co"))).scalar_one()
    assert project.store_tool_arguments is False and stored is False
