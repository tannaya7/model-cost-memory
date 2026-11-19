"""The savings tracker against a real Postgres: a change of model is found in a task's own history, and the observed change in cost per
correct answer is shown only when the data can carry it. Realized and estimated figures are separate. Negative results are valid.

Made-up names and prices. Nothing here calls anything outside the database."""

import uuid
from datetime import UTC, date, datetime, timedelta
from decimal import Decimal

import pytest
from sqlalchemy import text

from agent_memory.insights.savings import savings
from agent_memory.models import CatalogEntry, Job, Project, Retest, Run
from agent_memory.security import generate_key, hash_key

TODAY = date(2026, 11, 19)
LENGTHS = (500, 2000, 8000)  # prompt sizes that fall in three different size buckets


def day(offset):
    return TODAY - timedelta(days=offset)


@pytest.fixture
async def proj(session):
    key = generate_key()
    project = Project(project_id="acme", api_key_hash=hash_key(key), billing_mode="per_use")
    session.add(project)
    await session.flush()
    job = Job(project_id="acme", name="invoice", check_kind="ANSWER_KEY", check_config={"fields": ["total"]})
    session.add(job)
    await session.commit()
    return project, job, key


async def add(session, job, first, days, per_day, *, model, cost=0.010, pass_p=0.9, lengths=LENGTHS, prompt_version=None,
              tokens=(1000, 100), no_cost=0, no_cost_start=0, unchecked=False, unchecked_n=0, kind="PRODUCTION", project="acme", provider=None):
    """`days` days of `per_day` calls each, starting at `first`. Costs, passes and prompt sizes follow fixed patterns, so every run is repeatable."""
    rows, i = [], 0
    for n in range(days):
        for k in range(per_day):
            wobble = 1 + 0.04 * (((i * 37) % 11) - 5) / 5
            ok = ((i * 7) % 10) < round(pass_p * 10)
            rows.append(Run(
                run_id=uuid.uuid4(), job_id=job.job_id, project_id=project, prompt="x" * lengths[i % len(lengths)],
                prompt_hash=f"h{uuid.uuid4()}", model=model, model_version=model, provider=provider, tokens_in=tokens[0], tokens_out=tokens[1],
                cost_usd=None if no_cost_start <= i < no_cost_start + no_cost else round(cost * wobble, 6),
                outcome="UNKNOWN" if unchecked or i < unchecked_n else ("PASS" if ok else "FAIL"),
                state="INDEXED", run_kind=kind, usage_shape="openai_chat", prompt_version=prompt_version,
                created_at=datetime(first.year, first.month, first.day, 10, tzinfo=UTC) + timedelta(days=n, seconds=k),
            ))
            i += 1
    session.add_all(rows)
    await session.commit()


async def standard(session, job, *, before=0.010, after=0.006, pass_before=0.9, pass_after=0.9, **kw):
    await add(session, job, day(58), 28, 20, model="big", cost=before, pass_p=pass_before, **kw)
    await add(session, job, day(30), 30, 20, model="small", cost=after, pass_p=pass_after, **kw)


async def run(session, project):
    return await savings(session, project, today=TODAY)


# ---- a real change ----------------------------------------------------------------------------------------------------

async def test_a_real_saving_is_found_dated_and_shown_with_a_range(session, proj):
    project, job, _ = proj
    await standard(session, job)
    [e] = (await run(session, project)).entries
    assert (e.from_model, e.to_model, e.switch_date, e.status) == ("big", "small", day(30), "saving")
    r = e.realized
    assert r["unit"] == "usd" and r["before"] > r["after"] > 0
    assert r["change"] == pytest.approx((0.010 - 0.006) / 0.9, rel=0.08)
    assert 0 < r["range_low"] < r["change"] < r["range_high"]
    assert e.window["days"] == 28 and e.window["before"][1] == day(31).isoformat() and e.window["after"][0] == day(29).isoformat()
    assert (r["checked_before"], r["checked_after"]) == (560, 560) and r["pass_rate_before"] == r["pass_rate_after"] == 0.9


async def test_the_estimate_is_a_separate_labelled_counterfactual_and_is_never_added_to_the_realized_change(session, proj):
    project, job, _ = proj
    await standard(session, job)
    found = await run(session, project)
    e = found.entries[0]
    est = e.estimated_avoided
    assert "ESTIMATED" in est["label"] and est["assumptions"] and "same price table" in " ".join(est["assumptions"])
    assert est["correct_answers"] == 522  # 29 completed days after the change (not its first day), 580 calls at 90% correct
    assert est["point"] == pytest.approx(e.realized["change"] * est["correct_answers"], rel=0.001)
    assert est["low"] < est["point"] < est["high"] and est["low"] > 0
    assert e.realized["change"] != est["point"] and "estimated" not in str(e.realized).lower()  # nothing estimated inside the realized block


# ---- when it must say nothing -----------------------------------------------------------------------------------------

async def test_a_task_that_never_changed_model_has_no_entry(session, proj):
    project, job, _ = proj
    await add(session, job, day(58), 58, 20, model="big")
    assert (await run(session, project)).entries == []


async def test_a_change_with_too_few_days_waits_and_shows_no_number(session, proj):
    project, job, _ = proj
    await add(session, job, day(40), 28, 20, model="big")
    await add(session, job, day(12), 12, 20, model="small")  # 11 comparable days after the change
    [e] = (await run(session, project)).entries
    assert e.status == "waiting" and e.realized is None and e.estimated_avoided is None
    assert e.progress["days_after"] == 11 and "Waiting for 14 comparable days" in e.reason


async def test_a_task_with_too_little_traffic_never_even_registers_a_change(session, proj):
    project, job, _ = proj
    await add(session, job, day(58), 28, 2, model="big")
    await add(session, job, day(30), 30, 2, model="small", cost=0.006)  # 60 calls on the new model: too few to call it a change
    assert (await run(session, project)).entries == []


async def test_too_few_checked_calls_is_not_enough_comparable_data(session, proj):
    project, job, _ = proj
    await add(session, job, day(58), 28, 5, model="big")  # 140 calls, all checked
    await add(session, job, day(30), 30, 5, model="small", cost=0.006, unchecked_n=70)  # 150 calls, only 80 of them checked
    [e] = (await run(session, project)).entries
    assert e.status == "not_enough_data" and e.realized is None and "fewer than 100 checked calls" in e.reason


async def test_calls_that_were_never_checked_are_not_counted_and_cannot_make_a_figure(session, proj):
    project, job, _ = proj
    await add(session, job, day(58), 28, 20, model="big", unchecked=True)
    await add(session, job, day(30), 30, 20, model="small", cost=0.006, unchecked=True)
    [e] = (await run(session, project)).entries
    assert e.status == "not_enough_data" and e.coverage["checked_before"] == 0 and e.coverage["unchecked_after"] == 560


async def test_missing_costs_are_unknown_not_free_and_too_many_stop_the_figure(session, proj):
    project, job, _ = proj
    await add(session, job, day(58), 28, 20, model="big")
    await add(session, job, day(30), 30, 20, model="small", cost=0.006, no_cost=180)  # a third of the first 560 have no price
    [e] = (await run(session, project)).entries
    assert e.status == "not_enough_data" and "no cost" in e.reason and e.coverage["without_cost_after"] > 100


async def test_a_few_missing_costs_are_left_out_and_said_so(session, proj):
    project, job, _ = proj
    await add(session, job, day(58), 28, 20, model="big")
    await add(session, job, day(30), 30, 20, model="small", cost=0.006, no_cost=20, no_cost_start=100)
    [e] = (await run(session, project)).entries
    assert e.status == "saving" and any("no known cost" in n for n in e.data_notes) and e.coverage["without_cost_after"] == 20


# ---- negative and doubtful results ------------------------------------------------------------------------------------

async def test_a_cost_increase_is_shown_as_the_valid_negative_result_it_is(session, proj):
    project, job, _ = proj
    await standard(session, job, before=0.006, after=0.010)
    [e] = (await run(session, project)).entries
    assert e.status == "cost_up" and e.realized["change"] < 0 and e.realized["range_high"] < 0
    assert e.estimated_avoided["point"] < 0 and e.estimated_avoided["high"] < 0  # the estimate is negative too, and kept apart


async def test_no_real_change_is_no_clear_change(session, proj):
    project, job, _ = proj
    await standard(session, job, before=0.008, after=0.008)
    [e] = (await run(session, project)).entries
    assert e.status == "no_clear_change" and e.realized["range_low"] < 0 < e.realized["range_high"]


async def test_cheaper_but_less_correct_is_not_a_saving(session, proj):
    project, job, _ = proj
    await standard(session, job, before=0.010, after=0.006, pass_before=0.9, pass_after=0.6)
    [e] = (await run(session, project)).entries
    assert e.status == "less_correct" and "not shown as a saving" in e.reason
    assert e.estimated_avoided is None  # no counterfactual is offered for a change that made answers worse
    assert e.realized["pass_rate_change_high"] < 0


# ---- volume, mix, price, prompt, cache --------------------------------------------------------------------------------

async def test_a_jump_in_volume_does_not_change_cost_per_correct_answer_and_is_noted(session, proj):
    project, job, _ = proj
    await add(session, job, day(58), 28, 10, model="big", cost=0.008)
    await add(session, job, day(30), 30, 40, model="small", cost=0.008)  # four times the calls, same cost per call
    [e] = (await run(session, project)).entries
    assert e.status == "no_clear_change"
    assert any("number of calls changed a lot" in n for n in e.data_notes)


async def test_a_shift_to_bigger_prompts_is_not_mistaken_for_a_cost_increase(session, proj):
    project, job, _ = proj
    small_mix, big_mix = (500, 500, 2000, 8000), (500, 2000, 2000, 8000, 8000, 8000)

    class Cost:  # cost follows prompt size, the same for both models
        pass

    await add(session, job, day(58), 28, 20, model="big", cost=0.010, lengths=small_mix)
    await add(session, job, day(30), 30, 20, model="small", cost=0.010, lengths=big_mix)
    [e] = (await run(session, project)).entries
    # the per-call cost is flat, so whatever the mix does, no saving and no increase may be claimed
    assert e.status == "no_clear_change" and "like for like by prompt size" in e.realized["mix_compared"]


async def test_prompts_of_completely_different_sizes_cannot_be_compared(session, proj):
    project, job, _ = proj
    await add(session, job, day(58), 28, 20, model="big", lengths=(300, 600))
    await add(session, job, day(30), 30, 20, model="small", cost=0.006, lengths=(20000, 30000))
    [e] = (await run(session, project)).entries
    assert e.status == "not_enough_data" and "kinds of prompts changed" in e.reason


async def test_a_new_prompt_version_at_the_same_time_stops_the_credit(session, proj):
    project, job, _ = proj
    await add(session, job, day(58), 28, 20, model="big", prompt_version="v1")
    await add(session, job, day(30), 30, 20, model="small", cost=0.006, prompt_version="v2")
    [e] = (await run(session, project)).entries
    assert e.status == "not_enough_data" and "prompt version changed" in e.reason and e.realized is None


async def test_a_cache_change_is_pointed_out(session, proj):
    project, job, _ = proj
    await standard(session, job)
    await session.execute(text("UPDATE runs SET cache_read_tokens = 900 WHERE model = 'small'"))
    await session.commit()
    [e] = (await run(session, project)).entries
    assert any("Cache use changed" in n for n in e.data_notes)


async def test_a_price_change_inside_the_periods_is_not_counted_as_a_saving(engine, session, proj):
    """The old model's list price was cut during the before-period. Billed costs would make the move look bigger than the model
    change; both periods are re-priced with one table, so only the model's own difference is left."""
    project, job, _ = proj
    session.add(CatalogEntry(model="big", model_version="big", provider="acme", price_in_per_mtok=Decimal(10), price_out_per_mtok=Decimal(20)))
    session.add(CatalogEntry(model="small", model_version="small", provider="acme", price_in_per_mtok=Decimal(6), price_out_per_mtok=Decimal(12)))
    await session.commit()
    await session.execute(text("UPDATE model_catalog SET price_in_per_mtok = 7, price_out_per_mtok = 14 WHERE model = 'big'"))
    await session.commit()  # the old price version is closed now (real time); the new price stays in force
    now = datetime.now(UTC).date()
    switch = now + timedelta(days=5)
    today = switch + timedelta(days=30)
    await add(session, job, switch - timedelta(days=28), 28, 20, model="big", cost=0.012, provider="acme")  # billed at the old price
    await session.execute(text("UPDATE runs SET cost_usd = 0.0084 WHERE created_at >= :t"), {"t": datetime(now.year, now.month, now.day, tzinfo=UTC)})
    await add(session, job, switch, 30, 20, model="small", cost=0.0072, provider="acme")
    await session.commit()
    [e] = (await savings(session, project, today=today)).entries
    assert e.status == "saving" and e.realized["price_basis"] == "re-priced with one price table"
    assert any("list price changed" in n for n in e.data_notes)
    assert e.realized["change"] == pytest.approx((0.0084 - 0.0072) / 0.9, rel=0.06)  # the model's own difference, at one price table
    billed_view = (0.012 + 0.0084) / 2 - 0.0072  # what billed costs alone would have suggested per call
    assert e.realized["change"] * 0.9 < billed_view * 0.6


# ---- a second change, trials and recommendations, other projects ------------------------------------------------------

async def test_a_second_change_resets_the_baseline_and_the_entries_never_overlap(session, proj):
    project, job, _ = proj
    await add(session, job, day(88), 28, 20, model="a", cost=0.010)
    await add(session, job, day(60), 28, 20, model="b", cost=0.007)
    await add(session, job, day(32), 32, 20, model="c", cost=0.009)
    found = await run(session, project)
    first, second = found.entries
    assert (first.from_model, first.to_model, second.from_model, second.to_model) == ("a", "b", "b", "c")
    assert first.status == "saving" and second.status == "cost_up"  # c costs more than b: a negative second entry
    assert first.window["after"][1] < second.window["before"][0] or first.window["after"][1] <= second.switch_date.isoformat()
    assert date.fromisoformat(first.window["after"][1]) < second.switch_date
    assert second.realized["before"] == pytest.approx(0.007 / 0.9, rel=0.08)  # the baseline is the then-current model, not the first one
    total_estimated = (found.entries[0].estimated_avoided["point"], found.entries[1].estimated_avoided["point"])
    assert total_estimated[0] > 0 > total_estimated[1]  # the estimates differ in sign and are kept apart


async def test_trials_and_other_kinds_of_run_are_never_counted(session, proj):
    project, job, _ = proj
    await add(session, job, day(58), 58, 20, model="big", cost=0.010)
    # a heavy, cheap model that only ever ran as a trial must not create a "change" or a saving
    await add(session, job, day(30), 30, 60, model="trial-model", cost=0.001, kind="RETEST")
    assert (await run(session, project)).entries == []
    before = (await run(session, project)).entries
    session.add(Retest(job_id=job.job_id, project_id="acme", candidate_model="trial-model", trigger="MANUAL", budget_usd=Decimal(1), status="DONE", passed=99, failed=1))
    await session.commit()
    assert (await run(session, project)).entries == before  # an unrun or finished trial changes nothing


async def test_only_this_projects_calls_are_used(session, proj):
    project, job, _ = proj
    other = Project(project_id="other", api_key_hash=hash_key(generate_key()))
    session.add(other)
    await session.flush()
    oj = Job(project_id="other", name="invoice", check_kind="ANSWER_KEY", check_config={"fields": ["total"]})
    session.add(oj)
    await session.commit()
    await standard(session, oj, project="other") if False else None
    await add(session, oj, day(58), 28, 20, model="big", project="other")
    await add(session, oj, day(30), 30, 20, model="small", cost=0.002, project="other")
    assert (await run(session, project)).entries == []  # their change is not ours
    assert len((await run(session, other)).entries) == 1


async def test_the_same_day_gives_the_same_answer_every_time(session, proj):
    project, job, _ = proj
    await standard(session, job)
    one, two = await run(session, project), await run(session, project)
    a, b = one.entries[0], two.entries[0]
    assert (a.realized, a.estimated_avoided, a.status) == (b.realized, b.estimated_avoided, b.status)


async def test_it_only_reads(session, proj):
    project, job, _ = proj
    await standard(session, job)
    tables = ("runs", "jobs", "projects", "retests", "recommendations", "alerts")
    before = [(await session.execute(text(f"SELECT count(*) FROM {t}"))).scalar_one() for t in tables]
    stamp = (await session.execute(text("SELECT md5(string_agg(p::text, '|')) FROM projects p"))).scalar_one()
    await run(session, project)
    after = [(await session.execute(text(f"SELECT count(*) FROM {t}"))).scalar_one() for t in tables]
    assert before == after
    assert stamp == (await session.execute(text("SELECT md5(string_agg(p::text, '|')) FROM projects p"))).scalar_one()


async def test_a_flat_plan_gets_tokens_per_correct_answer_never_dollars(session, proj):
    project, job, _ = proj
    project.billing_mode = "subscription"
    await session.commit()
    await add(session, job, day(58), 28, 20, model="big", tokens=(2000, 200))
    await add(session, job, day(30), 30, 20, model="small", tokens=(1000, 100))
    found = await run(session, project)
    [e] = found.entries
    assert found.unit == "tokens" and e.realized["unit"] == "tokens" and e.estimated_avoided["unit"] == "tokens"
    assert e.status == "saving" and e.realized["change"] == pytest.approx((2200 - 1100) / 0.9, rel=0.08)
    assert "approximate" in e.realized["unit_words"] and any("flat plan" in n for n in found.notes)


# ---- over the API -----------------------------------------------------------------------------------------------------

async def test_the_api_returns_the_same_story_and_the_total_is_only_the_estimates(client, session, proj):
    project, job, key = proj
    await standard(session, job)
    r = await client.get("/v1/insights/savings", headers={"X-API-Key": key})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["unit"] == "usd" and body["counts"] == {"saving": 1} or body["counts"].get("saving") == 1
    est = body["entries"][0]["estimated_avoided"]
    total = body["estimated_avoided_total"]
    assert total["point"] == pytest.approx(est["point"]) and "ESTIMATED" in total["label"] and total["entries"] == 1
    assert any("never counted" in n for n in body["notes"])
    assert "promising" not in str(body["entries"]).lower()
    assert (await client.get("/v1/insights/savings")).status_code == 401


async def test_the_api_for_a_project_with_nothing_says_so_without_inventing_a_number(client, proj):
    project, job, key = proj
    body = (await client.get("/v1/insights/savings", headers={"X-API-Key": key})).json()
    assert body["entries"] == [] and body["estimated_avoided_total"] is None and body["jobs_checked"] == 1
