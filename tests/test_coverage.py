"""Usage coverage and data quality: denominators, unknowns, duplicates, attempts per task, filters and isolation.

Real Postgres, made-up data. Nothing here calls a provider."""

import uuid

import pytest

from agent_memory.projects import create_project

JOB = {"name": "t", "check_kind": "ANSWER_KEY", "check_config": {"fields": ["x"]}}
GOOD = {"prompt_tokens": 1000, "completion_tokens": 200, "total_tokens": 1200}


@pytest.fixture
async def keyed(client, session):
    _, key = await create_project(session, "proj1")
    h = {"X-API-Key": key}
    await client.post("/v1/jobs", json=JOB, headers=h)
    return h


def call(**over):
    base = {"run_id": str(uuid.uuid4()), "job": "t", "prompt": "p", "model": "gpt-5-mini", "model_version": "gpt-5-mini", "provider": "openai",
            "usage_shape": "openai_chat", "usage_raw": GOOD, "tokens_in": 1000, "tokens_out": 200}
    base.update(over)
    return base


async def cov(client, h, **q):
    r = await client.get("/v1/insights/coverage", params=q, headers=h)
    assert r.status_code == 200, r.text
    return r.json()


async def test_an_empty_project_shows_no_shares_not_zero_percent(client, keyed):
    c = await cov(client, keyed)
    assert c["attempts"] == 0 and c["usage_reported"]["share"] is None and c["priced"]["share"] is None
    assert "never reached" in c["scope"]


async def test_counts_and_denominators(client, keyed):
    for _ in range(3):
        await client.post("/v1/runs", json=call(), headers=keyed)
    await client.post("/v1/runs", json=call(usage_shape="none", usage_raw=None, tokens_in=0, tokens_out=0), headers=keyed)  # no usage block
    c = await cov(client, keyed)
    assert c["attempts"] == 4 and c["logical_tasks"] == 4  # no task ids: every attempt is its own task
    assert c["usage_reported"]["runs"] == 3 and c["no_usage_block"]["runs"] == 1
    assert c["usage_reported"]["share"] == 0.75
    assert c["unpriced"]["runs"] >= 1  # the call with no usage has an unknown cost, not zero
    causes = {x["code"]: x for x in c["causes"]}
    assert causes["NO_USAGE_BLOCK"]["runs"] == 1 and len(causes["NO_USAGE_BLOCK"]["examples"]) == 1


async def test_several_attempts_for_one_task_are_shown_not_merged(client, keyed):
    for _ in range(3):
        await client.post("/v1/runs", json=call(trace_id="task-1"), headers=keyed)
    await client.post("/v1/runs", json=call(trace_id="task-2"), headers=keyed)
    c = await cov(client, keyed)
    assert c["attempts"] == 4 and c["logical_tasks"] == 2
    assert c["tasks_with_several_attempts"] == 1 and c["extra_attempts"] == 2


async def test_duplicates_are_counted_not_double_counted(client, keyed):
    one = call()
    for _ in range(3):
        await client.post("/v1/runs", json=one, headers=keyed)
    c = await cov(client, keyed)
    assert c["attempts"] == 1 and c["duplicates_ignored"] == 2


async def test_flagged_calls_stay_in_totals_and_are_listed_with_a_reason(client, keyed):
    bad = {"prompt_tokens": 1000, "completion_tokens": 200, "total_tokens": 9999}
    await client.post("/v1/runs", json=call(usage_raw=bad), headers=keyed)
    await client.post("/v1/runs", json=call(), headers=keyed)
    c = await cov(client, keyed)
    assert c["attempts"] == 2 and c["flagged"]["runs"] == 1
    cause = {x["code"]: x for x in c["causes"]}["TOTAL_MISMATCH"]
    assert cause["runs"] == 1 and "differs" in cause["label"]
    assert set(cause["examples"][0]) == {"run_id", "model", "provider", "created_at"}  # no prompt, no output, no secrets


async def test_filters_change_the_totals_and_hide_duplicates(client, keyed):
    await client.post("/v1/runs", json=call(), headers=keyed)
    await client.post("/v1/runs", json=call(model="gpt-5", model_version="gpt-5"), headers=keyed)
    assert (await cov(client, keyed, model="gpt-5"))["attempts"] == 1
    assert (await cov(client, keyed, provider="OpenAI"))["attempts"] == 2
    assert (await cov(client, keyed, job="nope"))["attempts"] == 0
    filtered = await cov(client, keyed, model="gpt-5")
    assert filtered["duplicates_ignored"] is None and "filter" in filtered["duplicates_note"]


async def test_other_projects_are_never_visible(client, session, keyed):
    _, key2 = await create_project(session, "proj2")
    other = {"X-API-Key": key2}
    await client.post("/v1/jobs", json=JOB, headers=other)
    await client.post("/v1/runs", json=call(), headers=other)
    assert (await cov(client, keyed))["attempts"] == 0
    assert (await cov(client, other))["attempts"] == 1


async def test_it_says_what_it_cannot_measure(client, keyed):
    await client.post("/v1/runs", json=call(), headers=keyed)
    c = await cov(client, keyed)
    text = " ".join(c["cannot_measure"]).lower()
    assert "never reached" in text and "billed charges" in text and "late" in text
    assert "complete" not in c["scope"].lower().replace("how complete", "")  # never claims completeness


async def test_provider_field_notes_come_from_the_documented_layouts(client, keyed):
    await client.post("/v1/runs", json=call(), headers=keyed)
    p = (await cov(client, keyed))["providers"][0]
    assert p["usage_shape"] == "openai_chat" and p["field_notes"]
