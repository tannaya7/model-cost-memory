"""The optional summary: off without a key, figures only, once per verdict, a daily limit, dropped when
it disagrees. No real API calls."""

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
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test")
    seen = []

    async def fake(settings, instructions, payload):
        seen.append((instructions, json.loads(payload)))
        return SUMMARY

    monkeypatch.setattr(summary, "_call", fake)
    return seen


async def test_without_a_key_there_is_no_summary_and_no_call(session, job, monkeypatch):
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)

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


async def test_a_failed_call_is_retried_only_after_an_hour(session, job, monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test")
    answers = [None, SUMMARY]

    async def flaky(settings, instructions, payload):
        return answers.pop(0)

    monkeypatch.setattr(summary, "_call", flaky)
    now = datetime.now(UTC)
    assert await summary.summarize(session, job, result(), SETTINGS, now=now) == (None, None)
    assert await summary.summarize(session, job, result(), SETTINGS, now=now + timedelta(minutes=5)) == (None, None)
    assert answers == [SUMMARY]  # not called again yet
    text, _ = await summary.summarize(session, job, result(), SETTINGS, now=now + timedelta(hours=2))
    assert text == SUMMARY
    stored = (await session.execute(select(RecommendationSummary))).scalar_one()
    assert stored.attempts == 2


async def test_a_summary_that_does_not_name_the_recommended_model_is_dropped(session, job, monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test")

    async def off(settings, instructions, payload):
        return "Keep using big. Nothing to change."

    monkeypatch.setattr(summary, "_call", off)
    assert await summary.summarize(session, job, result(), SETTINGS) == (None, None)


async def test_an_unexpected_error_never_breaks_the_recommendation(session, job, monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test")

    async def broken(settings, instructions, payload):
        raise RuntimeError("bug")

    monkeypatch.setattr(summary, "_call", broken)
    assert await summary.summarize(session, job, result(), SETTINGS) == (None, None)


async def test_the_request_turns_thinking_off_and_asks_for_low_effort(monkeypatch):
    """The call's shape, checked against a stand-in client (the real one is checked with one live call)."""
    import anthropic

    sent = {}

    class Messages:
        async def create(self, **kwargs):
            sent.update(kwargs)
            block = type("B", (), {"type": "text", "text": SUMMARY})()
            return type("R", (), {"stop_reason": "end_turn", "content": [block]})()

    class Client:
        def __init__(self, **kwargs):
            self.messages = Messages()

        async def close(self):
            pass

    monkeypatch.setattr(anthropic, "AsyncAnthropic", Client)
    assert await summary._call(SETTINGS, "instructions", "{}") == SUMMARY
    assert sent["model"] == "claude-haiku-5-5" and sent["thinking"] == {"type": "disabled"}
    assert sent["output_config"] == {"effort": "low"} and sent["max_tokens"] == summary.MAX_TOKENS
