"""What changed between two equal periods: observations, an exact split of spend and tokens, coverage and missing data,
and context that is only ever "at the same time", never a cause."""

import re
import uuid
from datetime import UTC, date, datetime, timedelta

import pytest

from agent_memory.insights import changes as ch
from agent_memory.models import Job, PriceVersion, Project, Run

NOW = datetime(2026, 11, 18, 15, 0, tzinfo=UTC)  # today is partial and left out; whole days end at 18 Nov 00:00
TODAY = NOW.date()


def at(days_ago: float) -> datetime:
    """A time `days_ago` whole days before the start of today, midday."""
    return datetime(TODAY.year, TODAY.month, TODAY.day, tzinfo=UTC) - timedelta(days=days_ago) + timedelta(hours=12)


async def project_with_jobs(session, *names, mode="per_use"):
    session.add(Project(project_id="p", api_key_hash="x", billing_mode=mode))
    await session.flush()
    jobs = {}
    for n in names:
        j = Job(project_id="p", name=n, check_kind="ANSWER_KEY", check_config={"fields": ["x"]})
        session.add(j)
        jobs[n] = j
    await session.flush()
    return jobs


def run(job, when, *, model="big", tin=1000, tout=200, cost=0.01, cache=0, prompt_version=None, trace=None, prompt="p", shape=None,
        kind="PRODUCTION"):
    return Run(run_id=uuid.uuid4(), job_id=job.job_id, project_id="p", prompt=prompt, prompt_hash=prompt, model=model,
               model_version=model + "-1", tokens_in=tin, tokens_out=tout, cost_usd=cost, cache_read_tokens=cache,
               prompt_version=prompt_version, trace_id=trace, usage_shape=shape, run_kind=kind, outcome="UNKNOWN",
               state="INDEXED", created_at=when)


def many(job, days_ago_range, n, **kw):
    lo, hi = days_ago_range
    return [run(job, at(lo + (hi - lo) * i / max(n - 1, 1)), **kw) for i in range(n)]


def get(c, key):
    return next(o for o in c.observations if o.key == key)


# --- the pure parts --------------------------------------------------------------------------------------------

def test_windows_are_whole_days_ending_at_the_start_of_today():
    assert ch.windows(7, date(2026, 11, 18)) == (date(2026, 11, 4), date(2026, 11, 11), date(2026, 11, 18))


@pytest.mark.parametrize(("prev", "cur"), [
    ({"a": (100, 10.0), "b": (100, 30.0)}, {"a": (150, 16.5), "b": (50, 17.0)}),  # volume, mix and rate all move
    ({"a": (100, 10.0)}, {"a": (100, 10.0)}),  # nothing moves
    ({"a": (100, 10.0)}, {"a": (200, 20.0), "new": (50, 40.0)}),  # a model that is new this period
    ({"a": (100, 10.0), "gone": (50, 25.0)}, {"a": (80, 9.0)}),  # a model that stopped
])
def test_the_split_adds_up_to_the_whole_change_exactly(prev, cur):
    s = ch.split(prev, cur, "spend_usd")
    assert s.from_calls + s.from_mix + s.from_per_call == pytest.approx(s.total_change)
    assert s.total_change == pytest.approx(sum(t for _, t in cur.values()) - sum(t for _, t in prev.values()))


def test_the_split_puts_each_effect_where_it_belongs():
    same_calls_dearer = ch.split({"a": (100, 10.0)}, {"a": (100, 15.0)}, "spend_usd")
    assert (same_calls_dearer.from_calls, same_calls_dearer.from_mix) == (0, 0) and same_calls_dearer.from_per_call == pytest.approx(5)
    twice_the_calls = ch.split({"a": (100, 10.0)}, {"a": (200, 20.0)}, "spend_usd")
    assert twice_the_calls.from_calls == pytest.approx(10) and twice_the_calls.from_per_call == pytest.approx(0)
    moved = ch.split({"cheap": (100, 1.0), "dear": (100, 10.0)}, {"cheap": (20, 0.2), "dear": (180, 18.0)}, "spend_usd")
    assert moved.from_calls == pytest.approx(0) and moved.from_mix > 0 and moved.from_per_call == pytest.approx(0)
    new = ch.split({"a": (100, 10.0)}, {"a": (100, 10.0), "b": (50, 40.0)}, "spend_usd")
    assert new.from_per_call == pytest.approx(0)  # a new model has no earlier rate: it is mix, not "per call"


def test_split_needs_calls_in_both_periods():
    assert ch.split({}, {"a": (1, 1.0)}, "spend_usd") is None
    assert ch.split({"a": (1, 1.0)}, {}, "spend_usd") is None


def test_mix_lists_only_shares_that_moved_and_sorts_by_size():
    rows = ch.mix_rows({"a": 80, "b": 20}, {"a": 40, "b": 55, "c": 5})
    assert [r.name for r in rows] == ["a", "b", "c"]  # biggest move first; c moved exactly the 5 points that count
    assert rows[0].before_share == pytest.approx(80) and rows[0].after_share == pytest.approx(40) and rows[0].change_points == pytest.approx(-40)
    assert ch.mix_rows({"a": 50, "b": 50}, {"a": 51, "b": 49}) == []  # a 1 point move is noise
    assert ch.mix_rows({}, {"a": 5}) == []  # no earlier period: no shares to compare


# --- the measured differences -----------------------------------------------------------------------------------

async def test_observations_give_before_after_and_percent_with_known_numbers(session):
    jobs = await project_with_jobs(session, "t")
    j = jobs["t"]
    session.add_all(many(j, (8, 14), 100, tin=1000, tout=200, cost=0.01, cache=500)  # earlier 7 days
                    + many(j, (1, 7), 150, tin=2000, tout=100, cost=0.02, cache=500))  # last 7 days
    await session.commit()
    c = await ch.what_changed(session, "p", days=7, now=NOW)
    assert c.comparable and (c.previous.calls, c.current.calls) == (100, 150)
    calls = get(c, "calls")
    assert (calls.before, calls.after, calls.change, calls.change_pct, calls.size) == (100, 150, 50, 50.0, "notable")
    assert get(c, "tokens_in_per_call").change_pct == pytest.approx(100.0)
    assert get(c, "tokens_out_per_call").change_pct == pytest.approx(-50.0)
    assert get(c, "spend_usd").before == pytest.approx(1.0) and get(c, "spend_usd").after == pytest.approx(3.0)
    cs = get(c, "cache_share")  # a share: points, never a percentage of a percentage
    assert cs.before == pytest.approx(500 / 1500 * 100) and cs.after == pytest.approx(500 / 2500 * 100)
    assert cs.change_pct is None and cs.size == "notable"


async def test_a_small_change_is_small_and_an_unchanged_one_is_not_reported_as_notable(session):
    jobs = await project_with_jobs(session, "t")
    session.add_all(many(jobs["t"], (8, 14), 100) + many(jobs["t"], (1, 7), 105))
    await session.commit()
    c = await ch.what_changed(session, "p", days=7, now=NOW)
    assert get(c, "calls").size == "small" and get(c, "tokens_in_per_call").change == 0


async def test_the_split_for_spend_and_tokens_comes_with_the_changes(session):
    jobs = await project_with_jobs(session, "t")
    j = jobs["t"]
    session.add_all(many(j, (8, 14), 100, model="a", cost=0.01, tin=500, tout=0) + many(j, (8, 14), 100, model="b", cost=0.03, tin=500, tout=0)
                    + many(j, (1, 7), 40, model="a", cost=0.01, tin=500, tout=0) + many(j, (1, 7), 160, model="b", cost=0.03, tin=500, tout=0))
    await session.commit()
    c = await ch.what_changed(session, "p", days=7, now=NOW)
    spend = next(s for s in c.splits if s.what == "spend_usd")
    assert spend.total_change == pytest.approx((40 * .01 + 160 * .03) - (100 * .01 + 100 * .03))
    assert spend.from_calls == pytest.approx(0) and spend.from_mix > 0 and spend.from_per_call == pytest.approx(0)  # same calls, dearer model mix
    assert spend.from_calls + spend.from_mix + spend.from_per_call == pytest.approx(spend.total_change)
    assert [r.name for r in c.model_mix] == ["b", "a"] or [r.name for r in c.model_mix] == ["a", "b"]
    assert c.model_mix[0].change_points == pytest.approx(30.0) or c.model_mix[0].change_points == pytest.approx(-30.0)


async def test_repeated_calls_are_counted_inside_a_task_only(session):
    jobs = await project_with_jobs(session, "t")
    j = jobs["t"]
    first = [run(j, at(10), trace=f"t{i}", prompt=f"q{i}") for i in range(30)]  # earlier: 30 calls, no repeats
    cur = []
    for i in range(30):  # now: each task calls the same prompt 3 times: 2 repeats each
        cur += [run(j, at(2), trace=f"c{i}", prompt=f"q{i}") for _ in range(3)]
    cur += [run(j, at(2), trace=None, prompt="same") for _ in range(5)]  # no task id: cannot be called a repeat
    session.add_all(first + cur)
    await session.commit()
    c = await ch.what_changed(session, "p", days=7, now=NOW)
    assert (c.previous.repeats, c.current.repeats) == (0, 60)
    rep = get(c, "repeated_calls")
    assert rep.after == pytest.approx(60 / 90 * 100) and rep.before == pytest.approx(0)
    assert any("Repeated calls can only be found among the 90 calls that carry a task id" in n for n in c.notes)


# --- coverage, missing data and the periods ----------------------------------------------------------------------

async def test_too_few_calls_before_means_no_percentage_and_says_so(session):
    jobs = await project_with_jobs(session, "t")
    session.add_all(many(jobs["t"], (8, 14), 5) + many(jobs["t"], (1, 7), 100))
    await session.commit()
    c = await ch.what_changed(session, "p", days=7, now=NOW)
    assert not c.comparable and get(c, "calls").change_pct is None and get(c, "calls").size == "unknown"
    assert any("Only 5 calls in the 7 days before: too few for a percentage change (we need 20)" in n for n in c.notes)
    assert c.splits == []  # no split from a handful of calls


async def test_no_history_at_all_is_an_answer_not_a_blank(session):
    await project_with_jobs(session, "t")
    await session.commit()
    c = await ch.what_changed(session, "p", days=7, now=NOW)
    assert not c.comparable and (c.current.calls, c.previous.calls) == (0, 0)
    assert any("no calls in the 7 days before" in n for n in c.notes) and any("no calls in the last 7 days" in n for n in c.notes)
    assert get(c, "calls").size == "small" or get(c, "calls").size == "unknown"


async def test_unpriced_and_token_less_calls_are_counted_out_loud(session):
    jobs = await project_with_jobs(session, "t")
    j = jobs["t"]
    early = many(j, (8, 14), 50)
    late = many(j, (1, 7), 50)
    for r in late[:10]:
        r.cost_usd = None
    for r in late[10:15]:
        r.usage_shape = "none"
        r.tokens_in = r.tokens_out = 0
    session.add_all(early + late)
    await session.commit()
    c = await ch.what_changed(session, "p", days=7, now=NOW)
    assert any("10 calls in the last 7 days have no known price, so spend leaves them out" in n for n in c.notes)
    assert any("5 calls in the last 7 days report no token counts" in n for n in c.notes)
    assert get(c, "spend_usd").after == pytest.approx(40 * 0.01)  # unpriced calls are not zero-priced


async def test_days_with_no_calls_are_named(session):
    jobs = await project_with_jobs(session, "t")
    session.add_all(many(jobs["t"], (8, 14), 40) + [run(jobs["t"], at(2)) for _ in range(30)])
    await session.commit()
    c = await ch.what_changed(session, "p", days=7, now=NOW)
    assert any("In the last 7 days, 6 had no calls at all" in n for n in c.notes)


async def test_today_is_left_out_and_only_production_runs_count(session):
    jobs = await project_with_jobs(session, "t")
    j = jobs["t"]
    todays = [run(j, datetime(TODAY.year, TODAY.month, TODAY.day, 9, tzinfo=UTC)) for _ in range(40)]
    retests = many(j, (1, 7), 40, kind="RETEST")
    session.add_all(many(j, (1, 7), 25) + todays + retests)
    await session.commit()
    c = await ch.what_changed(session, "p", days=7, now=NOW)
    assert c.current.calls == 25  # not today's 40 (partial day) and not the 40 re-test calls


async def test_only_the_chosen_lengths_are_accepted(session):
    await project_with_jobs(session, "t")
    with pytest.raises(ValueError):
        await ch.what_changed(session, "p", days=5, now=NOW)


# --- context: what else happened, never a cause --------------------------------------------------------------------

async def test_a_new_model_and_a_new_prompt_version_are_listed_as_happening_at_the_same_time(session):
    jobs = await project_with_jobs(session, "t")
    j = jobs["t"]
    session.add_all(many(j, (8, 14), 60, model="big", prompt_version="v1")
                    + many(j, (1, 3), 60, model="big", prompt_version="v2") + many(j, (1, 3), 30, model="mini", prompt_version="v2"))
    await session.commit()
    c = await ch.what_changed(session, "p", days=7, now=NOW)
    kinds = {(e.kind, e.label.split(" appeared")[0]) for e in c.events}
    assert ("new_model", "mini") in {(k, l.split(" appeared")[0].split(" in your")[0]) for k, l in kinds} or any(e.kind == "new_model" and "mini" in e.label for e in c.events)
    assert any(e.kind == "prompt_version" and "v2 of t" in e.label for e in c.events)
    assert all(e.link in ("same_time", "concentrated") for e in c.events)


async def test_a_prompt_version_is_concentrated_only_when_its_own_calls_differ_in_the_same_direction(session):
    jobs = await project_with_jobs(session, "t")
    j = jobs["t"]
    session.add_all(many(j, (8, 14), 100, tin=3000, prompt_version="v1")  # earlier, heavy
                    + many(j, (1, 7), 60, tin=3000, prompt_version="v1")  # the old version still runs, heavy
                    + many(j, (1, 7), 60, tin=1000, prompt_version="v2"))  # the new one is light: overall per-call input falls
    await session.commit()
    c = await ch.what_changed(session, "p", days=7, now=NOW)
    ev = next(e for e in c.events if e.kind == "prompt_version")
    assert get(c, "tokens_in_per_call").change < 0
    assert ev.link == "concentrated" and "1,000 input tokens on average and the other t calls 3,000" in ev.evidence
    assert "does not show the wording is the reason for it" in ev.evidence


async def test_a_prompt_version_that_runs_alone_is_only_same_time(session):
    jobs = await project_with_jobs(session, "t")
    j = jobs["t"]
    session.add_all(many(j, (8, 14), 60, tin=3000, prompt_version="v1") + many(j, (1, 7), 60, tin=1000, prompt_version="v2"))
    await session.commit()
    c = await ch.what_changed(session, "p", days=7, now=NOW)
    ev = next(e for e in c.events if e.kind == "prompt_version")
    assert ev.link == "same_time" and ev.evidence is None  # nothing in this period to contrast it with


async def test_a_list_price_change_is_listed_for_models_in_use(session):
    jobs = await project_with_jobs(session, "t")
    session.add_all(many(jobs["t"], (8, 14), 30, model="big") + many(jobs["t"], (1, 7), 30, model="big"))
    old = PriceVersion(scope="catalog", model="big", model_version="", provider="acme", input_per_mtok=3, output_per_mtok=15,
                       effective_from=at(60), effective_to=at(4), source_kind="MANUAL")
    new = PriceVersion(scope="catalog", model="big", model_version="", provider="acme", input_per_mtok=2, output_per_mtok=10,
                       effective_from=at(4), source_kind="MANUAL")
    session.add_all([old, new])
    await session.commit()
    c = await ch.what_changed(session, "p", days=7, now=NOW)
    ev = next(e for e in c.events if e.kind == "price_change")
    assert "input $3 to $2" in ev.label and "output $15 to $10" in ev.label and ev.link == "same_time"


async def test_nothing_in_the_answer_ever_claims_a_cause_and_it_says_what_is_not_recorded(session):
    jobs = await project_with_jobs(session, "t")
    j = jobs["t"]
    session.add_all(many(j, (8, 14), 100, tin=3000, prompt_version="v1") + many(j, (1, 7), 60, tin=3000, prompt_version="v1")
                    + many(j, (1, 7), 60, tin=1000, prompt_version="v2", model="mini"))
    await session.commit()
    c = await ch.what_changed(session, "p", days=7, now=NOW)
    text = " ".join([o.label + (o.note or "") for o in c.observations] + [e.label + (e.evidence or "") for e in c.events] + c.notes)
    assert not re.search(r"\b(because|caused|due to|result of|thanks to|led to|so that)\b", text, re.I)
    assert "not recorded" in " ".join(c.not_recorded) and "settings" in " ".join(c.not_recorded)


# --- subscription: no dollars --------------------------------------------------------------------------------------

async def test_a_subscription_project_gets_no_dollar_figure_no_price_event_and_no_money_note(session):
    jobs = await project_with_jobs(session, "t", mode="subscription")
    j = jobs["t"]
    session.add_all(many(j, (8, 14), 60, model="big", cost=0.01) + many(j, (1, 7), 60, model="big", cost=0.02))
    session.add_all([PriceVersion(scope="catalog", model="big", model_version="", provider="acme", input_per_mtok=3, output_per_mtok=15,
                                  effective_from=at(60), effective_to=at(4), source_kind="MANUAL"),
                     PriceVersion(scope="catalog", model="big", model_version="", provider="acme", input_per_mtok=2, output_per_mtok=10,
                                  effective_from=at(4), source_kind="MANUAL")])
    await session.commit()
    c = await ch.what_changed(session, "p", days=7, mode="subscription", now=NOW)
    assert all(o.unit != "usd" for o in c.observations) and all(s.what != "spend_usd" for s in c.splits)
    assert not any(e.kind == "price_change" for e in c.events)
    assert not any(re.search(r"\$|price|spend|cost|bill", n, re.I) for n in c.notes)
    assert get(c, "tokens_in").after == 60 * 1000  # tokens are still shown


async def test_a_mixed_project_keeps_spend_but_it_is_the_list_price_basis(session):
    jobs = await project_with_jobs(session, "t", mode="both")
    session.add_all(many(jobs["t"], (8, 14), 60) + many(jobs["t"], (1, 7), 60, cost=0.02))
    await session.commit()
    c = await ch.what_changed(session, "p", days=7, mode="both", now=NOW)
    assert any(o.key == "spend_usd" for o in c.observations)


# --- the endpoint ----------------------------------------------------------------------------------------------------

async def _api_world(client, session, mode="per_use"):
    from agent_memory.projects import create_project

    project, key = await create_project(session, "proj1")
    project.billing_mode = mode
    job = Job(project_id=project.project_id, name="t", check_kind="ANSWER_KEY", check_config={"fields": ["x"]})
    session.add(job)
    await session.flush()
    today = datetime.now(UTC).replace(hour=12, minute=0, second=0, microsecond=0)
    for i in range(40):
        session.add(Run(run_id=uuid.uuid4(), job_id=job.job_id, project_id=project.project_id, prompt="p", prompt_hash=f"e{i}", model="big",
                        model_version="big-1", tokens_in=1000, tokens_out=200, cost_usd=0.01, run_kind="PRODUCTION", outcome="UNKNOWN",
                        state="INDEXED", created_at=today - timedelta(days=9 + (i % 4))))
    for i in range(60):
        session.add(Run(run_id=uuid.uuid4(), job_id=job.job_id, project_id=project.project_id, prompt="p", prompt_hash=f"h{i}", model="big",
                        model_version="big-1", tokens_in=2000, tokens_out=100, cost_usd=0.02, run_kind="PRODUCTION", outcome="UNKNOWN",
                        state="INDEXED", created_at=today - timedelta(days=1 + (i % 5))))
    await session.commit()
    return {"X-API-Key": key}


async def test_the_endpoint_returns_observations_coverage_context_and_a_basis_note(client, session):
    headers = await _api_world(client, session)
    body = (await client.get("/v1/insights/changes?days=7", headers=headers)).json()
    assert body["days"] == 7 and body["mode"] == "per_use" and body["comparable"] is True
    assert body["current"]["calls"] == 60 and body["previous"]["calls"] == 40
    calls = next(o for o in body["observations"] if o["key"] == "calls")
    assert (calls["before"], calls["after"], calls["change_pct"], calls["size"]) == (40, 60, 50.0, "notable")
    assert body["basis"].startswith("Measured from this project's own calls") and "cannot show why" in body["basis"]
    assert any("not recorded" in n for n in body["not_recorded"])
    assert {e["link"] for e in body["events"]} <= {"same_time", "concentrated"}
    assert "spend_usd" in {s["what"] for s in body["splits"]} and body["current"]["spend_usd"] == pytest.approx(60 * 0.02)


async def test_the_endpoint_checks_its_inputs_and_needs_a_key(client, session):
    headers = await _api_world(client, session)
    assert (await client.get("/v1/insights/changes?days=5", headers=headers)).status_code == 422
    assert (await client.get("/v1/insights/changes?days=30", headers=headers)).status_code == 200
    assert (await client.get("/v1/insights/changes")).status_code in (401, 403)


async def test_a_subscription_project_gets_tokens_and_no_dollars_from_the_endpoint(client, session):
    headers = await _api_world(client, session, mode="subscription")
    body = (await client.get("/v1/insights/changes?days=7", headers=headers)).json()
    assert body["mode"] == "subscription" and body["current"]["spend_usd"] is None and body["previous"]["spend_usd"] is None
    assert all(o["unit"] != "usd" for o in body["observations"]) and all(s["what"] != "spend_usd" for s in body["splits"])
    assert "$" not in str(body)
