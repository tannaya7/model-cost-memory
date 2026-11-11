"""The response models behave as the frontend expects (no database needed)."""

import uuid
from datetime import UTC, datetime

import pytest
from pydantic import ValidationError

from agent_memory.schemas import JobCreate, RunOut, RunPage


def run(**over):
    base = dict(
        run_id=uuid.uuid4(), job_id=uuid.uuid4(), job="invoice-extract", model="m", model_version="v1",
        prompt_version=None, tokens_in=10, tokens_out=5, cache_read_tokens=0, cache_write_tokens=0,
        cost_usd=0.0021, latency_ms=300, outcome="PASS", outcome_reason=None, run_kind="PRODUCTION",
        state="CHECKED", created_at=datetime(2026, 10, 14, tzinfo=UTC), prompt_preview="p",
        output_preview="o",
    )
    return RunOut(**{**base, **over})


def test_money_is_a_json_number_and_time_is_iso():
    data = run().model_dump(mode="json")
    assert isinstance(data["cost_usd"], float)
    assert data["created_at"].startswith("2026-10-14T00:00:00")


def test_unknown_outcome_is_rejected():
    with pytest.raises(ValidationError):
        run(outcome="MAYBE")


def test_a_page_may_have_no_next_cursor():
    page = RunPage(items=[run()], next_cursor=None)
    assert page.model_dump()["next_cursor"] is None


@pytest.mark.parametrize("bad", ["", " spaced name", "-leading-dash", "x" * 101])
def test_job_names_are_url_safe(bad):
    with pytest.raises(ValidationError):
        JobCreate(name=bad, check_kind="SCHEMA")


def test_a_job_defaults_to_no_re_test_consent():
    job = JobCreate(name="invoice-extract", check_kind="ANSWER_KEY", check_config={"fields": ["total"]})
    assert job.retest_consent is False
