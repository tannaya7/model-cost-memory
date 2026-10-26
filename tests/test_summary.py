"""The optional summary: off without a key, figures only, dropped when it disagrees. No real API calls."""

import json
from datetime import UTC, datetime

import pytest

from agent_memory.config import Settings
from agent_memory.recommend import summary
from agent_memory.recommend.engine import JobRecommendation, ModelInput, decide
from agent_memory.recommend.stats import Sample

SETTINGS = Settings()


def result():
    models = [ModelInput("big", "big-2026-09", 400, 4, Sample(0.99, 400, 400), 0.03),
              ModelInput("mini", "mini-2026-09", 400, 4, Sample(0.99, 400, 400), 0.001)]
    d = decide(models, "big", floor=25, margin=0.03, confidence=0.95)
    return JobRecommendation("invoice", d, 800, 800.0, [], datetime.now(UTC), SETTINGS)


@pytest.fixture(autouse=True)
def fresh_cache():
    summary._cache.clear()


async def test_without_a_key_there_is_no_summary_and_no_call(monkeypatch):
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)

    async def boom(*args):
        raise AssertionError("must not be called")

    monkeypatch.setattr(summary, "_call", boom)
    assert await summary.summarize(result(), SETTINGS) == (None, None)


async def test_the_model_sees_figures_only_and_the_summary_is_cached(monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test")
    seen = []

    async def fake(settings, instructions, payload):
        seen.append((instructions, json.loads(payload)))
        return "Switch invoice to mini: it passes as often at a tenth of the cost. The saving assumes the mix stays the same."

    monkeypatch.setattr(summary, "_call", fake)
    text, version = await summary.summarize(result(), SETTINGS)
    assert text.startswith("Switch invoice to mini") and len(version) == 40
    instructions, figures = seen[0]
    assert "two plain sentences" in instructions and "<!--" not in instructions
    assert figures["recommended_model"] == "mini" and figures["verdict"] == "DOWNGRADE"
    assert "prompt" not in json.dumps(figures)
    await summary.summarize(result(), SETTINGS)
    assert len(seen) == 1  # the same figures are not paid for twice


async def test_a_summary_that_does_not_name_the_recommended_model_is_dropped(monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test")

    async def off(settings, instructions, payload):
        return "Keep using big. Nothing to change."

    monkeypatch.setattr(summary, "_call", off)
    assert await summary.summarize(result(), SETTINGS) == (None, None)


async def test_a_failed_call_returns_the_recommendation_without_a_summary(monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test")

    async def failed(settings, instructions, payload):
        return None

    monkeypatch.setattr(summary, "_call", failed)
    assert await summary.summarize(result(), SETTINGS) == (None, None)
