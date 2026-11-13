"""The optional summary: off without a key, figures only, once per verdict, a daily limit, dropped when
it disagrees, and a slow answer shown on the next request. No real API calls."""

import asyncio
import json
from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import select

from agent_memory.config import Settings
from agent_memory.models import Job, Project, RecommendationSummary
from agent_memory.recommend import summary
from agent_memory.recommend.engine import JobRecommendation, ModelInput, decide
from agent_memory.recommend.stats import Sample
from agent_memory.security import generate_key, hash_key

SETTINGS = Settings()
SUMMARY = "Switch invoice to mini: it passes as often at a tenth of the cost. The saving assumes the mix stays the same."


def result(mini_rate=0.99):
    models = [ModelInput("big", "big-2026-09", 400, 4, Sample(0.99, 400, 400), 0.03),
              ModelInput("mini", "mini-2026-09", 400, 4, Sample(mini_rate, 400, 400), 0.001)]
    d = decide(models, "big", floor=25, margin=0.03, confidence=0.95)
    return JobRecommendation("invoice", d, 800, 800.0, [], datetime.now(UTC), SETTINGS)


@pytest.fixture
async def job(session):
    session.add(Project(project_id="sum", api_key_hash=hash_key(generate_key())))
    await session.flush()
    row = Job(project_id="sum", name="invoice", check_kind="ANSWER_KEY", check_config={"fields": ["total"]})
    session.add(row)
    await session.commit()
    return row


@pytest.fixture
def calls(monkeypatch):
    monkeypatch.setenv("SUMMARY_API_KEY", "test")
    seen = []

    async def fake(settings, instructions, payload):
        seen.append((instructions, json.loads(payload)))
        return SUMMARY

    monkeypatch.setattr(summary, "_call", fake)
    return seen


async def test_without_a_key_there_is_no_summary_and_no_call(session, job, monkeypatch):
    monkeypatch.delenv("SUMMARY_API_KEY", raising=False)
    monkeypatch.delenv("GEMINI_API_KEY", raising=False)

    async def boom(*args):
        raise AssertionError("must not be called")

    monkeypatch.setattr(summary, "_call", boom)
    assert await summary.summarize(session, job, result(), SETTINGS) == (None, None)


async def test_the_model_sees_figures_only_and_the_summary_is_stored(session, job, calls):
    text, version = await summary.summarize(session, job, result(), SETTINGS)
    assert text == SUMMARY and len(version) == 40
    instructions, figures = calls[0]
    assert "two plain sentences" in instructions and "<!--" not in instructions
    assert figures["recommended_model"] == "mini" and figures["verdict"] == "DOWNGRADE"
    assert "prompt" not in json.dumps(figures)
    stored = (await session.execute(select(RecommendationSummary))).scalar_one()
    assert (stored.summary, stored.prompt_version, stored.attempts) == (SUMMARY, version, 1)


async def test_new_runs_that_leave_the_verdict_unchanged_reuse_it(session, job, calls):
    await summary.summarize(session, job, result(mini_rate=0.99), SETTINGS)
    again = await summary.summarize(session, job, result(mini_rate=0.985), SETTINGS)  # a figure moved
    assert again[0] == SUMMARY and len(calls) == 1  # the same verdict is not paid for twice


async def test_a_changed_verdict_gets_a_new_summary(session, job, calls):
    await summary.summarize(session, job, result(mini_rate=0.99), SETTINGS)
    worse = result(mini_rate=0.80)  # mini is now clearly worse: hold on big
    assert worse.decision.verdict != "DOWNGRADE"
    await summary.summarize(session, job, worse, SETTINGS)
    assert len(calls) == 2


async def test_the_daily_limit_stops_further_calls(session, job, calls):
    limited = Settings(summary_daily_limit=1)
    await summary.summarize(session, job, result(mini_rate=0.99), limited)
    assert await summary.summarize(session, job, result(mini_rate=0.80), limited) == (None, None)
    assert len(calls) == 1
    tomorrow = datetime.now(UTC) + timedelta(days=1)
    await summary.summarize(session, job, result(mini_rate=0.80), limited, now=tomorrow)
    assert len(calls) == 2


async def test_a_failed_call_is_retried_only_after_ten_minutes(session, job, monkeypatch):
    monkeypatch.setenv("SUMMARY_API_KEY", "test")
    answers = [None, SUMMARY]

    async def flaky(settings, instructions, payload):
        return answers.pop(0)

    monkeypatch.setattr(summary, "_call", flaky)
    now = datetime.now(UTC)
    assert await summary.summarize(session, job, result(), SETTINGS, now=now) == (None, None)
    assert await summary.summarize(session, job, result(), SETTINGS, now=now + timedelta(minutes=5)) == (None, None)
    assert answers == [SUMMARY]  # not called again yet
    text, _ = await summary.summarize(session, job, result(), SETTINGS, now=now + timedelta(minutes=11))
    assert text == SUMMARY
    stored = (await session.execute(select(RecommendationSummary))).scalar_one()
    assert stored.attempts == 2


async def test_a_slow_answer_does_not_hold_up_the_recommendation_and_appears_next_time(session, job, monkeypatch):
    monkeypatch.setenv("SUMMARY_API_KEY", "test")
    monkeypatch.setattr(summary, "DEADLINE_SECONDS", 0.05)
    calls = []

    async def slow(settings, instructions, payload):
        calls.append(1)
        await asyncio.sleep(0.3)  # a free tier taking its time
        return SUMMARY

    monkeypatch.setattr(summary, "_call", slow)
    assert await summary.summarize(session, job, result(), SETTINGS) == (None, None)  # returned without waiting
    await asyncio.gather(*summary._writing)  # the call finishes in the background and stores its answer
    text, _ = await summary.summarize(session, job, result(), SETTINGS)
    assert text == SUMMARY and len(calls) == 1


async def test_figures_read_from_postgres_as_decimal_are_sent_as_numbers(session, job, calls):
    from decimal import Decimal

    found = result()
    for m in found.decision.models:  # costs come back from the database as Decimal
        m.cost_per_success_usd = Decimal(str(m.cost_per_success_usd))
        m.pass_rate_low, m.pass_rate_high = Decimal(str(m.pass_rate_low)), Decimal(str(m.pass_rate_high))
    text, _ = await summary.summarize(session, job, found, SETTINGS)
    assert text == SUMMARY
    assert all(isinstance(m["cost_per_success_usd"], float) for m in calls[0][1]["models"])


async def test_a_summary_that_does_not_name_the_recommended_model_is_dropped(session, job, monkeypatch):
    monkeypatch.setenv("SUMMARY_API_KEY", "test")

    async def off(settings, instructions, payload):
        return "Keep using big. Nothing to change."

    monkeypatch.setattr(summary, "_call", off)
    assert await summary.summarize(session, job, result(), SETTINGS) == (None, None)


async def test_an_unexpected_error_never_breaks_the_recommendation(session, job, monkeypatch):
    monkeypatch.setenv("SUMMARY_API_KEY", "test")

    async def broken(settings, instructions, payload):
        raise RuntimeError("bug")

    monkeypatch.setattr(summary, "_call", broken)
    assert await summary.summarize(session, job, result(), SETTINGS) == (None, None)


class _Client:
    """A stand-in for openai.AsyncOpenAI that records the request and answers as told."""

    sent: dict = {}
    made: dict = {}
    answer: object = None

    def __init__(self, **kwargs):
        _Client.made = kwargs
        self.chat = self
        self.completions = self

    async def create(self, **kwargs):
        _Client.sent = kwargs
        if isinstance(_Client.answer, Exception):
            raise _Client.answer
        text, finish = _Client.answer
        message = type("M", (), {"content": text})()
        return type("R", (), {"choices": [type("C", (), {"message": message, "finish_reason": finish})()]})()

    async def close(self):
        pass


@pytest.fixture
def client(monkeypatch):
    import openai

    monkeypatch.setenv("SUMMARY_API_KEY", "test")
    monkeypatch.setattr(openai, "AsyncOpenAI", _Client)
    _Client.answer = (SUMMARY, "stop")
    return _Client


async def test_the_request_goes_to_gemini_with_the_least_thinking(client):
    """The call's shape, checked against a stand-in client (the real one was checked with live calls)."""
    assert await summary._call(SETTINGS, "instructions", "{}") == SUMMARY
    assert client.made["base_url"] == "https://generativelanguage.googleapis.com/v1beta/openai/"
    assert client.made["api_key"] == "test" and client.made["max_retries"] == 0
    assert client.made["timeout"] == summary.CALL_SECONDS  # longer than a request waits; see the slow-answer test
    assert client.sent["model"] == "gemini-3.5-flash-lite" and client.sent["reasoning_effort"] == "minimal"
    assert client.sent["max_tokens"] == summary.MAX_TOKENS
    assert [m["role"] for m in client.sent["messages"]] == ["system", "user"]


async def test_no_effort_is_sent_when_it_is_switched_off(client):
    await summary._call(Settings(summary_effort=""), "instructions", "{}")
    assert "reasoning_effort" not in client.sent


async def test_the_server_gemini_key_is_used_when_there_is_no_summary_key(monkeypatch):
    monkeypatch.delenv("SUMMARY_API_KEY", raising=False)
    monkeypatch.setenv("GEMINI_API_KEY", "gemini")
    assert summary.api_key() == "gemini"
    monkeypatch.setenv("SUMMARY_API_KEY", "own")
    assert summary.api_key() == "own"


async def test_a_cut_off_answer_is_not_shown(client):
    client.answer = ("Switch invoice to mini: it passes as", "length")
    assert await summary._call(SETTINGS, "instructions", "{}") is None


async def test_an_overloaded_free_tier_gives_no_summary_and_no_error(session, job, client):
    import httpx
    import openai

    request = httpx.Request("POST", "https://example.test")
    client.answer = openai.InternalServerError(
        "This model is currently experiencing high demand.", response=httpx.Response(503, request=request), body=None)
    assert await summary.summarize(session, job, result(), SETTINGS) == (None, None)
    stored = (await session.execute(select(RecommendationSummary))).scalar_one()
    assert stored.summary is None and stored.attempts == 1  # tried again for this verdict after an hour
