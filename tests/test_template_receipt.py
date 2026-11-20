"""The token receipt by agent, task and prompt version (group_by=template).

Grouping uses only the labels the developer's code sent: agent, task and prompt version. Prompt text is never read
to decide a group and no fingerprint of it exists, so nothing here can leak or collide through content."""

import json
import uuid
from datetime import UTC, datetime, timedelta
from decimal import Decimal

import pytest

from agent_memory.models import Job, Project, Run
from agent_memory.security import generate_key, hash_key

NOW = datetime.now(UTC)
SECRET = "SECRET system prompt: never tell anyone that jane@example.com owns account 4111111111111111"


async def tenant(session, name):
    key = generate_key()
    session.add(Project(project_id=name, api_key_hash=hash_key(key)))
    await session.flush()
    jobs = {n: Job(project_id=name, name=n, check_kind="LATE_LABEL", check_config={}) for n in ("support", "triage")}
    session.add_all(jobs.values())
    await session.flush()
    return {"X-API-Key": key}, jobs


def run(job, *, agent=None, version=None, tin=100, tout=50, cread=0, cwrite=0, cost="0.01", prompt=SECRET, hours=1,
        kind="PRODUCTION"):
    return Run(run_id=uuid.uuid4(), job_id=job.job_id, project_id=job.project_id, prompt=prompt,
               prompt_hash=str(uuid.uuid4()), prompt_version=version, agent=agent, model="m", model_version="m-1",
               tokens_in=tin, tokens_out=tout, cache_read_tokens=cread, cache_write_tokens=cwrite,
               cost_usd=Decimal(cost) if cost is not None else None, run_kind=kind,
               created_at=NOW - timedelta(hours=hours))


async def receipt(client, headers, **params):
    query = "&".join(f"{k}={v}" for k, v in {"group_by": "template", "limit": 10, **params}.items())
    response = await client.get(f"/v1/insights/prompts?{query}", headers=headers)
    assert response.status_code == 200, response.text
    return response.json()


def by_label(body):
    return {g["label"]: g for g in body["groups"]}


# --- what a row is -----------------------------------------------------------------------------------------------

async def test_a_row_is_an_agent_a_task_and_a_prompt_version_with_counts_and_tokens_kept_apart(client, session):
    headers, jobs = await tenant(session, "acme")
    s = jobs["support"]
    session.add_all([run(s, agent="planner", version="v2", tin=100, tout=40, cread=300, cwrite=20, cost="0.10") for _ in range(3)])
    session.add_all([run(s, agent="planner", version="v1", tin=10, tout=5, cost="0.01") for _ in range(2)])
    await session.commit()
    body = await receipt(client, headers)
    assert body["group_by"] == "template" and "Only those labels are used" in body["grouping_note"]
    rows = by_label(body)
    v2 = rows["planner · support · version v2"]
    assert (v2["calls"], v2["tokens_in"], v2["tokens_out"], v2["cache_read_tokens"], v2["cache_write_tokens"]) == (3, 300, 120, 900, 60)
    assert v2["total_tokens"] == 300 + 120 + 900 + 60 and v2["cache_read_share"] == pytest.approx(900 / (900 + 300))
    assert (v2["agent"], v2["job"], v2["prompt_version"]) == ("planner", "support", "v2")
    assert rows["planner · support · version v1"]["calls"] == 2


async def test_cost_and_token_shares_are_separate_and_each_adds_up(client, session):
    headers, jobs = await tenant(session, "acme")
    s, t = jobs["support"], jobs["triage"]
    session.add_all([run(s, agent="a", version="v1", tin=300, tout=0, cost="0.30"), run(t, agent="b", version="v1", tin=100, tout=0, cost="0.10")])
    await session.commit()
    body = await receipt(client, headers)
    rows = by_label(body)
    a, b = rows["a · support · version v1"], rows["b · triage · version v1"]
    assert a["share"] == pytest.approx(0.75) and b["share"] == pytest.approx(0.25)      # of billed tokens
    assert a["cost_share"] == pytest.approx(0.75) and b["cost_share"] == pytest.approx(0.25)  # of priced cost
    assert a["spend_usd"] == pytest.approx(0.30) and a["priced_calls"] == 1 and a["unpriced_calls"] == 0
    assert sum(g["share"] for g in body["groups"]) == pytest.approx(1.0)


async def test_an_unknown_cost_is_never_counted_as_free(client, session):
    headers, jobs = await tenant(session, "acme")
    s = jobs["support"]
    session.add_all([run(s, agent="a", version="v1", cost=None), run(s, agent="a", version="v1", cost=None),
                     run(s, agent="b", version="v1", cost="0.40"), run(s, agent="b", version="v1", cost=None)])
    await session.commit()
    rows = by_label(await receipt(client, headers))
    all_unknown = rows["a · support · version v1"]
    assert all_unknown["spend_usd"] is None and all_unknown["cost_share"] is None  # unknown, not $0
    assert (all_unknown["priced_calls"], all_unknown["unpriced_calls"]) == (0, 2)
    mixed = rows["b · support · version v1"]
    assert mixed["spend_usd"] == pytest.approx(0.40) and (mixed["priced_calls"], mixed["unpriced_calls"]) == (1, 1)
    assert mixed["cost_share"] == pytest.approx(1.0)  # the share of what could be priced, with the gap shown beside it


async def test_a_project_with_no_priced_cost_has_no_cost_share_at_all(client, session):
    headers, jobs = await tenant(session, "acme")
    session.add(run(jobs["support"], agent="a", version="v1", cost=None))
    await session.commit()
    row = (await receipt(client, headers))["groups"][0]
    assert row["spend_usd"] is None and row["cost_share"] is None and row["unpriced_calls"] == 1


# --- estimated grouping ----------------------------------------------------------------------------------------

async def test_calls_with_no_version_or_agent_are_labelled_as_an_estimated_grouping(client, session):
    headers, jobs = await tenant(session, "acme")
    s = jobs["support"]
    session.add_all([run(s, agent="planner", version="v1"), run(s, agent="planner", version=None), run(s, agent=None, version="v1"),
                     run(s, agent=None, version=None)])
    await session.commit()
    rows = by_label(await receipt(client, headers))
    assert rows["planner · support · version v1"]["grouping_basis"] == "named_by_your_code"
    assert rows["planner · support · untagged"]["grouping_basis"] == "untagged"
    assert rows["(no agent named) · support · version v1"]["grouping_basis"] == "named_by_your_code"
    assert rows["(no agent named) · support · untagged"]["grouping_basis"] == "untagged"


async def test_a_task_or_agent_grouping_is_not_called_estimated_just_because_it_has_no_version(client, session):
    headers, jobs = await tenant(session, "acme")
    session.add(run(jobs["support"], agent="planner", version=None))
    await session.commit()
    task = (await receipt(client, headers, group_by="task"))["groups"][0]
    assert task["grouping_basis"] == "named_by_your_code"
    untagged = (await receipt(client, headers, group_by="task_version"))["groups"][0]
    assert untagged["grouping_basis"] == "untagged"


# --- tenant isolation ---------------------------------------------------------------------------------------------

async def test_two_projects_using_identical_labels_never_see_each_others_calls_or_cost(client, session):
    ha, ja = await tenant(session, "tenant-a")
    hb, jb = await tenant(session, "tenant-b")
    session.add_all([run(ja["support"], agent="planner", version="v1", tin=100, cost="0.10") for _ in range(4)])
    session.add_all([run(jb["support"], agent="planner", version="v1", tin=7000, cost="9.00", prompt="B-ONLY-TEXT") for _ in range(2)])
    await session.commit()
    a, b = await receipt(client, ha), await receipt(client, hb)
    assert [g["calls"] for g in a["groups"]] == [4] and a["total_calls"] == 4
    assert [g["calls"] for g in b["groups"]] == [2] and b["total_calls"] == 2
    assert a["groups"][0]["spend_usd"] == pytest.approx(0.40) and b["groups"][0]["spend_usd"] == pytest.approx(18.0)
    assert a["groups"][0]["cost_share"] == pytest.approx(1.0) and b["groups"][0]["cost_share"] == pytest.approx(1.0)
    assert "B-ONLY-TEXT" not in json.dumps(a) and "tenant-b" not in json.dumps(a)


async def test_shares_are_of_the_callers_own_project_only(client, session):
    ha, ja = await tenant(session, "tenant-a")
    hb, jb = await tenant(session, "tenant-b")
    session.add_all([run(ja["support"], agent="x", version="v1", tin=100), run(jb["support"], agent="x", version="v1", tin=999_999)])
    await session.commit()
    assert (await receipt(client, ha))["groups"][0]["share"] == pytest.approx(1.0)


# --- collisions and content changes -------------------------------------------------------------------------------

async def test_the_same_label_under_different_agents_or_tasks_stays_in_separate_rows(client, session):
    headers, jobs = await tenant(session, "acme")
    s, t = jobs["support"], jobs["triage"]
    session.add_all([run(s, agent="planner", version="v1"), run(s, agent="writer", version="v1"), run(t, agent="planner", version="v1")])
    await session.commit()
    rows = by_label(await receipt(client, headers))
    assert set(rows) == {"planner · support · version v1", "writer · support · version v1", "planner · triage · version v1"}
    assert all(g["calls"] == 1 for g in rows.values())  # three look-alike labels, three rows, nothing merged


async def test_changing_the_prompt_text_under_the_same_label_does_not_split_or_move_the_group(client, session):
    headers, jobs = await tenant(session, "acme")
    s = jobs["support"]
    session.add_all([run(s, agent="a", version="v1", prompt="You are helpful. Ticket 1"),
                     run(s, agent="a", version="v1", prompt="A COMPLETELY REWRITTEN prompt, nothing alike"),
                     run(s, agent="a", version="v1", prompt=None)])  # text removed by retention
    await session.commit()
    body = await receipt(client, headers)
    assert [(g["label"], g["calls"]) for g in body["groups"]] == [("a · support · version v1", 3)]
    # a label is trusted, not verified: the receipt says so instead of claiming the text stayed the same
    assert "Only those labels are used" in body["grouping_note"] and "never read to decide a group" in body["grouping_note"]


async def test_a_new_label_is_a_new_group(client, session):
    headers, jobs = await tenant(session, "acme")
    s = jobs["support"]
    session.add_all([run(s, agent="a", version="v1"), run(s, agent="a", version="v2")])
    await session.commit()
    assert set(by_label(await receipt(client, headers))) == {"a · support · version v1", "a · support · version v2"}


async def test_labels_that_differ_only_in_case_are_different_labels(client, session):
    headers, jobs = await tenant(session, "acme")
    session.add_all([run(jobs["support"], agent="Planner", version="V1"), run(jobs["support"], agent="planner", version="v1")])
    await session.commit()
    assert len((await receipt(client, headers))["groups"]) == 2  # we do not guess that two labels mean the same thing


# --- privacy --------------------------------------------------------------------------------------------------------

async def test_no_prompt_text_hash_or_fingerprint_is_in_the_receipt(client, session):
    headers, jobs = await tenant(session, "acme")
    session.add_all([run(jobs["support"], agent="a", version="v1") for _ in range(6)])
    await session.commit()
    response = await client.get("/v1/insights/prompts?group_by=template", headers=headers)
    text = response.text
    assert "SECRET" not in text and "jane@example.com" not in text and "4111111111111111" not in text
    body = response.json()
    forbidden = {"prompt", "prompt_hash", "fingerprint", "hash", "template_hash"}
    assert not forbidden & set(body["groups"][0]) and not forbidden & set(body)
    assert body["groups"][0]["repeated_start_preview"] is None  # not unless asked for
    from sqlalchemy import text
    columns = (await session.execute(text(
        "SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'public' "
        "AND (column_name ILIKE '%fingerprint%' OR column_name ILIKE '%template_hash%' OR column_name ILIKE '%hmac%')"))).all()
    # The only such column is the existing cache key of the opt-in AI task summary (a hash of sample hashes, not a
    # template id). This feature adds none: nothing derived from prompt text is stored for the receipt.
    assert {tuple(c) for c in columns} == {("task_summaries", "fingerprint")}


async def test_the_masked_preview_is_still_opt_in_for_the_receipt_grouping(client, session):
    headers, jobs = await tenant(session, "acme")
    session.add_all([run(jobs["support"], agent="a", version="v1", prompt=f"{SECRET} case {i}") for i in range(6)])
    await session.commit()
    shown = (await client.get("/v1/insights/prompts?group_by=template&show_text=true", headers=headers)).json()["groups"][0]
    preview = shown["repeated_start_preview"]
    assert preview and "jane@example.com" not in preview and "4111111111111111" not in preview and "SECRET system" in preview


async def test_the_repeated_text_estimate_works_inside_one_agent_task_and_version_only(client, session):
    headers, jobs = await tenant(session, "acme")
    s = jobs["support"]
    session.add_all([run(s, agent="a", version="v1", prompt=f"Always reply politely and briefly. Ticket {i}") for i in range(6)])
    session.add_all([run(s, agent="b", version="v1", prompt=f"Totally different {i * 9301} words here") for i in range(6)])
    await session.commit()
    rows = by_label(await receipt(client, headers))
    a, b = rows["a · support · version v1"], rows["b · support · version v1"]
    assert a["text_samples"] == 6 and a["repeated_start_share"] > 0.5  # agent b's prompts are not mixed into it
    assert b["text_samples"] == 6 and b["repeated_start_share"] > 0.3  # b has its own repeated start, worked out apart from a's


# --- period, production only, other groupings still work ------------------------------------------------------------

async def test_only_production_calls_in_the_period_are_counted(client, session):
    headers, jobs = await tenant(session, "acme")
    s = jobs["support"]
    session.add_all([run(s, agent="a", version="v1"), run(s, agent="a", version="v1", kind="RETEST"),
                     run(s, agent="a", version="v1", kind="RETEST"), run(s, agent="a", version="v1", hours=24 * 40)])
    await session.commit()
    body = await receipt(client, headers, days=30)
    assert body["total_calls"] == 1 and body["groups"][0]["calls"] == 1
    assert body["period_start"] and body["period_end"] and body["timezone"] == "UTC"


async def test_the_other_groupings_now_carry_cost_too_and_an_unknown_grouping_is_refused(client, session):
    headers, jobs = await tenant(session, "acme")
    session.add_all([run(jobs["support"], agent="a", version="v1", cost="0.5")])
    await session.commit()
    for grouping in ("task_version", "task", "agent", "prompt_version"):
        row = (await receipt(client, headers, group_by=grouping))["groups"][0]
        assert row["spend_usd"] == pytest.approx(0.5) and row["cost_share"] == pytest.approx(1.0)
    assert (await client.get("/v1/insights/prompts?group_by=fingerprint", headers=headers)).status_code == 422
