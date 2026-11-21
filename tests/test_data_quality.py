"""Quality flags on a recorded call, and the count of duplicate deliveries.

A flag never stops a call from being recorded and never changes a number; it makes a doubtful value visible. Real Postgres, made-up data."""

import uuid
from datetime import UTC, datetime

import pytest
from sqlalchemy import select

from agent_memory.data_quality import flags_for
from agent_memory.models import IngestDuplicate, Run
from agent_memory.projects import create_project

JOB = {"name": "t", "check_kind": "ANSWER_KEY", "check_config": {"fields": ["x"]}}


@pytest.fixture
async def keyed(client, session):
    _, key = await create_project(session, "proj1")
    headers = {"X-API-Key": key}
    await client.post("/v1/jobs", json=JOB, headers=headers)
    return headers


def body(**over):
    base = {"run_id": str(uuid.uuid4()), "job": "t", "prompt": "p", "model": "m", "model_version": "m-1", "tokens_in": 10, "tokens_out": 5}
    base.update(over)
    return base


def test_a_clean_call_has_no_flags():
    usage = {"prompt_tokens": 100, "completion_tokens": 20, "total_tokens": 120}
    assert flags_for(usage_raw=usage, tokens_out=20, reasoning_tokens=None, cache_write_tokens=0, cache_write_1h_tokens=0) == []


def test_a_provider_total_that_differs_from_its_parts_is_flagged_but_not_an_error():
    usage = {"prompt_tokens": 100, "completion_tokens": 20, "total_tokens": 999}
    assert flags_for(usage_raw=usage, tokens_out=20, reasoning_tokens=None, cache_write_tokens=0, cache_write_1h_tokens=0) == ["TOTAL_MISMATCH"]


def test_impossible_splits_are_flagged():
    assert flags_for(usage_raw=None, tokens_out=10, reasoning_tokens=50, cache_write_tokens=0, cache_write_1h_tokens=0) == ["REASONING_EXCEEDS_OUTPUT"]
    assert flags_for(usage_raw=None, tokens_out=10, reasoning_tokens=None, cache_write_tokens=100, cache_write_1h_tokens=400) == ["CACHE_1H_EXCEEDS_WRITE"]


def test_unknown_values_are_never_treated_as_a_problem_or_as_zero():
    assert flags_for(usage_raw=None, tokens_out=None, reasoning_tokens=None, cache_write_tokens=None, cache_write_1h_tokens=None) == []
    assert flags_for(usage_raw=None, tokens_out=10, reasoning_tokens=None, cache_write_tokens=None, cache_write_1h_tokens=0) == []


async def test_a_flagged_call_is_still_recorded_with_its_numbers_unchanged(client, session, keyed):
    r = await client.post("/v1/runs", json=body(usage_shape="openai_chat", usage_raw={"prompt_tokens": 100, "completion_tokens": 20, "total_tokens": 999},
                                                tokens_in=100, tokens_out=20), headers=keyed)
    assert r.status_code == 202
    run = (await session.execute(select(Run))).scalar_one()
    assert run.data_flags == ["TOTAL_MISMATCH"] and (run.tokens_in, run.tokens_out) == (100, 20)  # the provider's own numbers are kept as sent


async def test_an_ordinary_call_has_null_flags_not_an_empty_list(client, session, keyed):
    await client.post("/v1/runs", json=body(), headers=keyed)
    assert (await session.execute(select(Run))).scalar_one().data_flags is None


async def test_a_duplicate_delivery_is_ignored_as_before_and_now_counted(client, session, keyed):
    one = body()
    for _ in range(3):  # the same call sent three times (an SDK retry, a replayed delivery)
        assert (await client.post("/v1/runs", json=one, headers=keyed)).status_code == 202
    assert len((await session.execute(select(Run))).scalars().all()) == 1  # still stored once
    row = (await session.execute(select(IngestDuplicate))).scalar_one()
    assert row.duplicates == 2 and row.day == datetime.now(UTC).date()


async def test_a_first_delivery_is_not_counted_as_a_duplicate(client, session, keyed):
    await client.post("/v1/runs", json=body(), headers=keyed)
    await client.post("/v1/runs", json=body(), headers=keyed)  # a different run_id: a different call
    assert (await session.execute(select(IngestDuplicate))).first() is None
