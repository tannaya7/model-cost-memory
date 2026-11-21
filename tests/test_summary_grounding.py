"""The optional summary is generated interpretation: opt-in per project, grounded in the figures it was given, unable to
override a number, never a cause or a promise, and never money on a subscription. No real API calls."""

import json
from datetime import UTC, datetime

import pytest
from sqlalchemy import select

from agent_memory.api import _recommendation_out
from agent_memory.config import Settings
from agent_memory.models import Job, Project, RecommendationSummary
from agent_memory.recommend import summary
from agent_memory.recommend.engine import JobRecommendation, ModelInput, decide
from agent_memory.recommend.stats import Sample
from agent_memory.security import generate_key, hash_key

SETTINGS = Settings()
GOOD = "Switch invoice to mini: it passes about as often as big at a fraction of the cost. The range for mini is still wide."


def result(mini_cost=0.001):
    models = [ModelInput("big", "big-2026-09", 400, 4, Sample(0.99, 400, 400), 0.03),
              ModelInput("mini", "mini-2026-09", 400, 4, Sample(0.985, 400, 400), mini_cost)]
    d = decide(models, "big", floor=25, margin=0.03, confidence=0.95)
    return JobRecommendation("invoice", d, 800, 800.0, [], datetime.now(UTC), SETTINGS)


async def make_job(session, *, consent, mode="per_use"):
    session.add(Project(project_id="g", api_key_hash=hash_key(generate_key()), ai_summary_consent=consent, billing_mode=mode))
    await session.flush()
    job = Job(project_id="g", name="invoice", check_kind="ANSWER_KEY", check_config={"fields": ["total"]})
    session.add(job)
    await session.commit()
    return job


@pytest.fixture
def writer(monkeypatch):
    """The outside AI, faked: what it is asked, and what it answers (set `.answer`)."""
    monkeypatch.setenv("SUMMARY_API_KEY", "test")
    state = type("W", (), {"answer": GOOD, "asked": []})()

    async def fake(settings, instructions, payload):
        state.asked.append(json.loads(payload))
        return state.answer

    monkeypatch.setattr(summary, "_call", fake)
    return state


# --- consent -----------------------------------------------------------------------------------------------------

async def test_without_the_projects_consent_nothing_is_sent_and_nothing_is_shown(session, writer):
    job = await make_job(session, consent=False)
    assert await summary.summarize(session, job, result(), SETTINGS) == (None, None)
    assert writer.asked == []  # not a single call, so no figures left the server


async def test_turning_consent_off_hides_an_earlier_summary(session, writer):
    job = await make_job(session, consent=True)
    text, _ = await summary.summarize(session, job, result(), SETTINGS)
    assert text == GOOD
    (await session.get(Project, "g")).ai_summary_consent = False
    await session.commit()
    assert await summary.summarize(session, job, result(), SETTINGS) == (None, None)  # stored, but not shown


async def test_only_figures_are_sent_never_a_prompt_or_an_answer_and_the_rule_is_included(session, writer):
    job = await make_job(session, consent=True)
    await summary.summarize(session, job, result(), SETTINGS)
    sent = writer.asked[0]
    assert set(sent) >= {"verdict", "current_model", "recommended_model", "models", "warnings", "rules"}
    assert sent["rules"] == {"margin_points": 3.0, "confidence_percent": 95.0}
    blob = json.dumps(sent)
    assert not any(w in blob for w in ("prompt", "output", "answer", "expected", "api_key"))


# --- a generated text can never override or add to the numbers -------------------------------------------------------

F = summary.figures(result(), "per_use")


@pytest.mark.parametrize("text", [
    GOOD,
    "Mini is at 98.5% against 99.0% for big, a gap of 0.5 points, inside the 3 points allowed.",
    "Mini has a range of about 97% to 99.3%, from 400 checked answers.",
    "Keep big for now; there are two models and one clear risk.",
])
def test_text_made_only_of_the_figures_is_accepted(text):
    assert summary.ungrounded(text, F) is None


@pytest.mark.parametrize("text", [
    "Mini passes 91.3% of the time, so switch.",  # an invented rate
    "Switching saves $412.50 a month.",  # an invented saving
    "Mini fails 7 times in 100 and that is fine.",
    "Try gpt-5-nano instead; it is cheaper still.",  # a model that was not in the figures
    "Mini wins because of its newer training data.",
    "This is guaranteed to hold.",
    "You will save money by switching.",
    "It will definitely keep passing.",
])
def test_an_invented_number_model_cause_or_promise_is_refused(text):
    assert summary.ungrounded(text, F) is not None


def test_digits_inside_a_named_model_are_not_taken_for_metrics():
    figs = summary.figures(result(), "per_use")
    assert summary.ungrounded("Switch invoice to mini; big stays the reference.", figs) is None


async def test_a_summary_with_an_invented_number_is_dropped_and_the_recommendation_is_unchanged(session, writer):
    job = await make_job(session, consent=True)
    writer.answer = "Switch invoice to mini: it passes 99.9% of the time and saves $9,000. The range for mini is still wide."
    r = result()
    assert await summary.summarize(session, job, r, SETTINGS) == (None, None)
    assert (await session.execute(select(RecommendationSummary.summary))).scalar_one() is None  # nothing stored
    skip = {"summary", "summary_prompt_version", "computed_at"}
    assert _recommendation_out(r, None).model_dump(exclude=skip) == _recommendation_out(r, GOOD, "v1").model_dump(exclude=skip)


async def test_a_summary_never_changes_the_verdict_or_the_models(session, writer):
    job = await make_job(session, consent=True)
    r = result()
    out = _recommendation_out(r, *await summary.summarize(session, job, r, SETTINGS))
    assert out.verdict == r.decision.verdict and out.recommended.model == r.decision.recommended.model
    assert [m.weighted_pass_rate for m in out.models] == [m.sample.pass_rate for m in r.decision.models]


# --- subscription and mixed projects: no dollar claims -------------------------------------------------------------

@pytest.mark.parametrize("text", [
    "Mini is cheaper and passes about as often.", "Switching will save money.", "Mini costs a tenth as much.",
    "Mini is $0.001 a call.", "That keeps the bill down.", "Mini is the less expensive choice.",
])
def test_a_subscription_summary_with_any_money_wording_is_refused(text):
    assert summary.ungrounded(text, summary.figures(result(), "subscription"), "subscription") is not None


def test_a_subscription_summary_about_correct_answers_is_accepted():
    figs = summary.figures(result(), "subscription")
    assert summary.ungrounded("Mini gives about as many correct answers as big, though its range is still wide.", figs, "subscription") is None


def test_the_figures_sent_for_a_subscription_contain_no_money_and_say_it_is_a_flat_fee():
    figs = summary.figures(result(), "subscription")
    blob = json.dumps(figs)
    assert "usd" not in blob and "cost" not in blob and figs["billing"] == "flat subscription"


def test_a_mixed_project_may_show_dollars_only_as_list_prices():
    figs = summary.figures(result(), "both")
    assert summary.ungrounded("At list prices mini is about $0.001 a correct answer.", figs, "both") is None
    assert summary.ungrounded("Mini is about $0.001 a correct answer.", figs, "both") == "gives a dollar figure without saying it is a list price"


async def test_a_subscription_projects_summary_with_money_is_never_stored_or_shown(session, writer):
    job = await make_job(session, consent=True, mode="subscription")
    writer.answer = "Switch invoice to mini: it is much cheaper and passes about as often. The range for mini is still wide."
    assert await summary.summarize(session, job, result(), SETTINGS) == (None, None)
    asked = json.dumps(writer.asked[0])
    assert "cost" not in asked and "usd" not in asked
    writer.answer = "Switch invoice to mini: it passes about as often as big. The range for mini is still wide."
    out = await summary.summarize(session, job, result(), SETTINGS, now=datetime(2099, 1, 1, tzinfo=UTC))  # past the retry wait
    assert out[0] is not None and "cheaper" not in out[0]


# --- the setting itself ---------------------------------------------------------------------------------------------

@pytest.fixture
def signed_in(client, monkeypatch):
    monkeypatch.setenv("DEV_LOGIN", "true")

    async def go():
        assert (await client.post("/auth/dev/login", json={"email": "owner@example.com"})).status_code == 200
        return (await client.post("/v1/projects", json={"name": "Shop"})).json()["project"]["project_id"]

    return go


async def test_the_switch_starts_off_and_says_where_the_figures_would_go(client, signed_in, monkeypatch):
    monkeypatch.setenv("SUMMARY_API_KEY", "k")
    pid = await signed_in()
    got = next(p for p in (await client.get("/v1/projects")).json() if p["project_id"] == pid)
    assert got["ai_summary_consent"] is False and got["ai_summary_host"] == "generativelanguage.googleapis.com"


async def test_it_can_be_turned_on_only_when_the_server_has_a_summary_service(client, signed_in, monkeypatch):
    monkeypatch.delenv("SUMMARY_API_KEY", raising=False)
    monkeypatch.delenv("GEMINI_API_KEY", raising=False)
    pid = await signed_in()
    refused = await client.patch(f"/v1/projects/{pid}", json={"ai_summary_consent": True})
    assert refused.status_code == 422 and "no summary service" in refused.text
    monkeypatch.setenv("SUMMARY_API_KEY", "k")
    ok = await client.patch(f"/v1/projects/{pid}", json={"ai_summary_consent": True})
    assert ok.status_code == 200 and ok.json()["ai_summary_consent"] is True
    off = await client.patch(f"/v1/projects/{pid}", json={"ai_summary_consent": False})
    assert off.json()["ai_summary_consent"] is False  # turning it off never needs a service
