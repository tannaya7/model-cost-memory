"""Where your tokens went: pure prefix/suffix functions and GET /v1/insights/prompts."""

import uuid
from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import select

from agent_memory.insights.prompts import common_prefix_len, common_suffix_len, prompt_insights, repeated_parts
from agent_memory.models import Job, Project, Run
from agent_memory.security import generate_key, hash_key

# ---- pure functions ----


def _five(*texts):
    return list(texts) + [texts[-1]] * (5 - len(texts))


def test_identical_prompts_are_fully_repeated():
    r = repeated_parts(["same text here"] * 6)
    assert r.start_share == 1.0 and r.end_share == 0.0  # the end can not overlap the start
    assert r.start_chars == len("same text here")


def test_fully_different_prompts_share_nothing():
    r = repeated_parts(["alpha one", "beta two", "gamma three", "delta four", "epsilon five"])
    assert (r.start_chars, r.end_chars, r.start_share, r.end_share, r.start_text) == (0, 0, 0.0, 0.0, "")


def test_shared_start():
    prompts = [f"You are a helpful bot. Question {i} please" for i in "abcde"]
    r = repeated_parts([p.replace(" please", f" {i * 3}") for p, i in zip(prompts, "vwxyz")])
    assert r.start_text == "You are a helpful bot. Question "
    assert r.start_share == pytest.approx(0.8, abs=0.1) and r.end_chars == 0


def test_shared_end():
    r = repeated_parts([f"{w} then answer in JSON only." for w in ("one", "two", "three", "four", "five")])
    assert r.start_chars == 0 and r.end_chars == len(" then answer in JSON only.")
    assert 0 < r.end_share < 1


def test_shared_start_and_end():
    r = repeated_parts([f"Header line. {w} Footer line." for w in ("aaa", "bbb", "ccc", "ddd", "eee")])
    assert r.start_text == "Header line. "
    assert r.start_chars == 13 and r.end_chars == len(" Footer line.")


def test_cut_at_word_boundaries():
    prompts = ["the cat sat", "the car ran", "the cab left", "the cap fell", "the can broke"]
    assert common_prefix_len(prompts) == 4  # "the " and never "the ca"
    ends = ["xx running fast", "yy gunning fast", "zz funning fast", "ww sunning fast", "vv bunning fast"]
    assert common_suffix_len(ends) == len(" fast")  # "unning fast" would cut a word


def test_fewer_than_five_samples_say_nothing():
    assert repeated_parts(["same"] * 4) is None


def test_start_and_end_never_overlap():
    prompts = ["a a a a"] * 5 + ["a a a a"]
    r = repeated_parts(prompts)
    assert r.start_chars + r.end_chars <= len("a a a a")
    overlapping = ["go go", "go go", "go go", "go go", "go go go"]
    r = repeated_parts(overlapping)
    assert r.start_chars + r.end_chars <= 5


def test_unicode_is_compared_by_characters():
    r = repeated_parts([f"Résumé du texte — {w} fin" for w in ("é", "ü", "ß", "ñ", "ç")])
    assert r.start_text == "Résumé du texte — "
    assert r.end_chars == len(" fin")


# ---- endpoint ----


async def _world(session):
    key, other_key = generate_key(), generate_key()
    session.add_all([Project(project_id="acme", api_key_hash=hash_key(key)),
                     Project(project_id="other", api_key_hash=hash_key(other_key))])
    await session.flush()
    jobs = {n: Job(project_id="acme", name=n, check_kind="LATE_LABEL", check_config={}) for n in ("support", "triage")}
    elsewhere = Job(project_id="other", name="support", check_kind="LATE_LABEL", check_config={})
    session.add_all([*jobs.values(), elsewhere])
    await session.flush()
    now = datetime.now(UTC)

    def run(j, prompt, tin, tout=0, version=None, cread=0, cwrite=0, days_ago=0, kind="PRODUCTION", removed=False):
        return Run(run_id=uuid.uuid4(), job_id=j.job_id, project_id=j.project_id, prompt=None if removed else prompt,
                   prompt_hash=str(uuid.uuid4()), prompt_version=version, model="m", model_version="m-1",
                   tokens_in=tin, tokens_out=tout, cache_read_tokens=cread, cache_write_tokens=cwrite,
                   run_kind=kind, created_at=now - timedelta(days=days_ago),
                   content_removed_at=now if removed else None)

    s, t = jobs["support"], jobs["triage"]
    rows = [run(s, f"SYSTEM: be brief and kind. Ticket {i}: customer says {'x' * i} thanks", 100, 20, "v1",
                cread=300, cwrite=10) for i in range(6)]  # 6 * 430 = 2580
    rows += [run(s, "other text", 50, 10, "v2"), run(s, "unversioned", 40, 0), run(s, "unversioned two", 40, 0)]  # 60, 80
    rows += [run(t, "t", 300, 100, removed=True)]  # 400, text removed
    rows += [run(s, "old", 9000, days_ago=90), run(s, "retest", 9000, kind="RETEST"), run(elsewhere, "spy", 9999)]
    session.add_all(rows)
    await session.commit()
    return {"X-API-Key": key}, {"X-API-Key": other_key}


async def test_groups_by_job_and_version_with_share_of_project_total(client, session):
    headers, _ = await _world(session)
    body = (await client.get("/v1/insights/prompts?limit=10", headers=headers)).json()
    assert body["days"] == 30 and body["total_tokens"] == 2580 + 60 + 80 + 400 == 3120
    keys = [(g["job"], g["prompt_version"]) for g in body["groups"]]
    assert keys == [("support", "v1"), ("triage", None), ("support", None), ("support", "v2")]
    top = body["groups"][0]
    assert (top["calls"], top["tokens_in"], top["tokens_out"], top["cache_read_tokens"], top["cache_write_tokens"]) \
        == (6, 600, 120, 1800, 60)
    assert top["total_tokens"] == 2580 and top["share"] == pytest.approx(2580 / 3120)
    assert top["avg_tokens_in"] == 100 and top["avg_tokens_out"] == 20
    assert top["cache_read_share"] == pytest.approx(1800 / 2400)
    assert isinstance(top["tokens_in"], int) and isinstance(top["share"], float)
    assert body["groups"][3]["cache_read_share"] == 0.0
    unversioned = body["groups"][2]
    assert unversioned["calls"] == 2 and unversioned["total_tokens"] == 80


async def test_limit_and_job_filter_keep_share_against_project_total(client, session):
    headers, _ = await _world(session)
    one = (await client.get("/v1/insights/prompts?limit=1", headers=headers)).json()
    assert len(one["groups"]) == 1 and one["total_tokens"] == 3120
    only = (await client.get("/v1/insights/prompts?job=triage", headers=headers)).json()
    assert [g["job"] for g in only["groups"]] == ["triage"]
    assert only["groups"][0]["share"] == pytest.approx(400 / 3120)
    assert (await client.get("/v1/insights/prompts?limit=11", headers=headers)).status_code == 422


async def test_production_only_window_and_project_isolation(client, session):
    headers, other = await _world(session)
    body = (await client.get("/v1/insights/prompts?limit=10", headers=headers)).json()
    assert body["total_tokens"] == 3120  # no re-test, no 90-day-old run, nothing from the other project
    wide = (await client.get("/v1/insights/prompts?days=365&limit=10", headers=headers)).json()
    assert wide["total_tokens"] == 3120 + 9000
    theirs = (await client.get("/v1/insights/prompts", headers=other)).json()
    assert theirs["total_tokens"] == 9999 and [g["job"] for g in theirs["groups"]] == ["support"]


async def test_text_analysis_finds_the_shared_start(client, session):
    headers, _ = await _world(session)
    groups = (await client.get("/v1/insights/prompts?limit=10", headers=headers)).json()["groups"]
    v1 = groups[0]
    assert v1["text_samples"] == 6
    assert v1["repeated_start_share"] > 0.3 and v1["repeated_end_share"] > 0
    assert v1["repeated_start_preview"] is None  # prompt text is not returned unless asked for
    assert groups[3]["text_samples"] == 1 and groups[3]["repeated_start_share"] is None  # fewer than 5
    shown = (await client.get("/v1/insights/prompts?limit=10&show_text=true", headers=headers)).json()["groups"][0]
    assert shown["repeated_start_preview"].startswith("SYSTEM: be brief and kind. Ticket")


async def test_removed_text_gives_null_analysis(client, session):
    headers, _ = await _world(session)
    triage = (await client.get("/v1/insights/prompts?job=triage", headers=headers)).json()["groups"][0]
    assert triage["text_samples"] == 0
    assert triage["repeated_start_share"] is None and triage["repeated_end_share"] is None
    assert triage["repeated_start_preview"] is None


async def test_empty_project(client, session):
    key = generate_key()
    session.add(Project(project_id="empty", api_key_hash=hash_key(key)))
    await session.commit()
    body = (await client.get("/v1/insights/prompts", headers={"X-API-Key": key})).json()
    assert body["days"] == 30 and body["total_tokens"] == 0 and body["groups"] == [] and body["total_calls"] == 0
    assert body["timezone"] == "UTC" and body["group_by"] == "task_version" and body["period_start"] and body["period_end"]


# ---- variable prompt fragments ----


def test_a_variable_fragment_in_the_middle_leaves_the_fixed_start_and_end():
    prompts = [f"You are an invoice reader. Invoice {i * 7919}: total {i * 13} EUR. Reply with JSON only." for i in range(6)]
    r = repeated_parts(prompts)
    assert r.start_text.startswith("You are an invoice reader. Invoice")
    shared_end = prompts[0][len(prompts[0]) - r.end_chars:].strip()
    assert shared_end == "EUR. Reply with JSON only."  # the digits vary, so only what really repeats is kept
    assert 0.2 < r.start_share < 0.5 and 0.2 < r.end_share < 0.5  # a share of each prompt, not of a different one


def test_a_variable_fragment_at_the_start_means_nothing_repeats_at_the_start():
    prompts = [f"Ticket {i}: please summarise what the customer wrote above in two lines." for i in range(100, 106)]
    r = repeated_parts(prompts)
    assert r.start_chars <= len("Ticket ") and r.end_share > 0.7  # the start varies; the long tail is shared


def test_a_variable_id_is_never_mistaken_for_a_repeat_by_a_shared_digit():
    r = repeated_parts([f"id {n} done" for n in (11, 12, 13, 14, 15, 16)])
    assert r.start_text.strip() == "id" and r.end_chars >= len(" done")  # "1" is not kept as part of the start


def test_prompts_of_very_different_length_cannot_make_the_shares_exceed_one():
    r = repeated_parts(["a b c d e f", "a b c d e f g h i j k l m n o p", "a b c d e f x", "a b c d e f y", "a b c d e f z"])
    assert 0 <= r.start_share <= 1 and 0 <= r.end_share <= 1 and r.start_share + r.end_share <= 1.0001


# ---- grouping, period, coverage, privacy ----


async def _ledger_world(session):
    """Three calls with ledger shapes (OpenAI reasoning, Gemini tool-use, Anthropic cache), plus a call with no usage
    block and an older call from before the ledger."""
    key = generate_key()
    session.add(Project(project_id="led", api_key_hash=hash_key(key)))
    await session.flush()
    job = Job(project_id="led", name="writer", check_kind="LATE_LABEL", check_config={})
    session.add(job)
    await session.flush()
    now = datetime.now(UTC)

    def run(prompt, *, shape=None, tin=100, tout=50, cread=0, cwrite=0, reasoning=None, tool=None, agent=None,
            version=None, days_ago=1, hours_ago=0, kind="PRODUCTION"):
        return Run(run_id=uuid.uuid4(), job_id=job.job_id, project_id="led", prompt=prompt, prompt_hash=str(uuid.uuid4()),
                   prompt_version=version, model="m", model_version="m-1", tokens_in=tin, tokens_out=tout,
                   cache_read_tokens=cread, cache_write_tokens=cwrite, usage_shape=shape, reasoning_tokens=reasoning,
                   tool_use_input_tokens=tool, agent=agent, run_kind=kind,
                   created_at=now - timedelta(days=days_ago, hours=hours_ago))

    session.add_all([
        run("p1", shape="openai_chat", reasoning=30, agent="planner", version="v1"),
        run("p2", shape="openai_chat", reasoning=20, agent="planner", version="v1"),
        run("p3", shape="gemini", tool=40, cread=10, agent="writer-bot", version="v2"),
        run("p4", shape="anthropic_messages", cread=500, cwrite=60, agent="writer-bot", version="v2"),
        run("p5", shape="none", tin=0, tout=0, agent=None, version=None),
        run("p6", shape=None, tin=70, tout=30, agent=None, version=None),  # recorded before the ledger
    ])
    await session.commit()
    return key, now


async def test_a_part_is_measured_not_reported_or_unknown_never_a_silent_zero(client, session):
    key, _ = await _ledger_world(session)
    body = (await client.get("/v1/insights/prompts?group_by=agent&limit=10", headers={"X-API-Key": key})).json()
    by = {g["label"]: {p["key"]: p for p in g["breakdown"]} for g in body["groups"]}
    planner = by["planner"]  # two OpenAI Chat calls: reasoning reported, tool-use not something OpenAI reports
    assert (planner["reasoning"]["state"], planner["reasoning"]["tokens"], planner["reasoning"]["calls"]) == ("measured", 50, 2)
    assert (planner["tool_use_input"]["state"], planner["tool_use_input"]["tokens"]) == ("not_reported", None)
    writer = by["writer-bot"]  # Gemini + Anthropic: tool-use measured, reasoning never reported by these layouts
    assert (writer["tool_use_input"]["state"], writer["tool_use_input"]["tokens"]) == ("measured", 40)
    assert (writer["cache_write"]["state"], writer["cache_write"]["tokens"]) == ("measured", 60)
    assert writer["cached_input"]["tokens"] == 510
    # the older call and the call with no usage block are not "0 reasoning": they are unknown
    other = by["(no agent named)"]
    assert (other["reasoning"]["state"], other["reasoning"]["tokens"]) == ("unknown", None)
    assert other["cache_write"]["state"] == "unknown" and other["cached_input"]["tokens"] is None


async def test_a_group_of_calls_with_no_usage_block_has_unknown_input_and_output(client, session):
    key, _ = await _ledger_world(session)
    p5 = (await client.get("/v1/insights/prompts?group_by=prompt_version&limit=10", headers={"X-API-Key": key})).json()
    none = next(g for g in p5["groups"] if g["label"] == "(no version tagged)")
    assert none["calls"] == 2 and none["no_usage_calls"] == 1 and none["legacy_calls"] == 1
    assert {p["key"]: p["state"] for p in none["breakdown"]}["input"] == "measured"  # the older call did record tokens


async def test_coverage_counts_say_how_many_calls_have_a_ledger(client, session):
    key, _ = await _ledger_world(session)
    body = (await client.get("/v1/insights/prompts?group_by=agent&limit=10", headers={"X-API-Key": key})).json()
    planner = next(g for g in body["groups"] if g["label"] == "planner")
    assert (planner["calls"], planner["ledger_calls"], planner["no_usage_calls"], planner["legacy_calls"]) == (2, 2, 0, 0)
    anon = next(g for g in body["groups"] if g["label"] == "(no agent named)")
    assert (anon["calls"], anon["ledger_calls"], anon["no_usage_calls"], anon["legacy_calls"]) == (2, 0, 1, 1)


async def test_each_grouping_is_chosen_by_the_caller_and_says_what_it_is(client, session):
    key, _ = await _ledger_world(session)
    h = {"X-API-Key": key}
    by_version = (await client.get("/v1/insights/prompts?limit=10", headers=h)).json()
    assert by_version["group_by"] == "task_version" and "prompt version your code tagged" in by_version["grouping_note"]
    assert {g["label"] for g in by_version["groups"]} == {"writer · version v1", "writer · version v2", "writer"}
    task = (await client.get("/v1/insights/prompts?group_by=task", headers=h)).json()
    assert [g["label"] for g in task["groups"]] == ["writer"] and task["groups"][0]["calls"] == 6
    agent = (await client.get("/v1/insights/prompts?group_by=agent&limit=10", headers=h)).json()
    assert {g["label"] for g in agent["groups"]} == {"planner", "writer-bot", "(no agent named)"}
    assert "agent name your code sent" in agent["grouping_note"]
    version = (await client.get("/v1/insights/prompts?group_by=prompt_version&limit=10", headers=h)).json()
    assert {g["label"] for g in version["groups"]} == {"v1", "v2", "(no version tagged)"}
    assert (await client.get("/v1/insights/prompts?group_by=colour", headers=h)).status_code == 422
    # every grouping adds up to the same project total: nothing lost or counted twice
    totals = {sum(g["total_tokens"] for g in r["groups"]) for r in (by_version, task, agent, version)}
    assert len(totals) == 1 and totals == {by_version["total_tokens"]}


async def test_the_split_of_repeated_text_is_only_worked_out_for_one_task_and_version(client, session):
    key, _ = await _ledger_world(session)
    agent = (await client.get("/v1/insights/prompts?group_by=agent&limit=10", headers={"X-API-Key": key})).json()
    for g in agent["groups"]:
        assert g["text_samples"] == 0 and g["repeated_start_share"] is None
        assert "one task and prompt version at a time" in g["text_note"]


async def test_the_period_is_exact_and_calls_outside_it_are_left_out(session):
    key, now = await _ledger_world(session)
    job = (await session.execute(select(Job).where(Job.project_id == "led"))).scalar_one()
    session.add_all([
        Run(run_id=uuid.uuid4(), job_id=job.job_id, project_id="led", prompt="old", prompt_hash="h", model="m",
            model_version="m", tokens_in=1000, run_kind="PRODUCTION", created_at=now - timedelta(days=8)),
        Run(run_id=uuid.uuid4(), job_id=job.job_id, project_id="led", prompt="future", prompt_hash="h2", model="m",
            model_version="m", tokens_in=5000, run_kind="PRODUCTION", created_at=now + timedelta(hours=1)),
    ])
    await session.commit()
    week = await prompt_insights(session, "led", days=7, now=now)
    assert week.period_end == now and week.period_start == now - timedelta(days=7) and week.timezone == "UTC"
    assert week.total_calls == 6 and week.total_tokens == 1270  # 150 + 150 + 160 + 710 + 0 + 100
    wide = await prompt_insights(session, "led", days=30, now=now)
    assert wide.total_calls == 7 and wide.total_tokens - week.total_tokens == 1000  # the 8-day-old call, not the future one


async def test_the_endpoint_reports_the_period_it_covers(client, session):
    key, _ = await _ledger_world(session)
    body = (await client.get("/v1/insights/prompts?days=7", headers={"X-API-Key": key})).json()
    start, end = datetime.fromisoformat(body["period_start"]), datetime.fromisoformat(body["period_end"])
    assert end - start == timedelta(days=7) and body["total_calls"] == 6 and body["timezone"] == "UTC"


async def test_prompt_text_is_never_returned_by_default(client, session):
    key = generate_key()
    session.add(Project(project_id="priv", api_key_hash=hash_key(key)))
    await session.flush()
    job = Job(project_id="priv", name="t", check_kind="LATE_LABEL", check_config={})
    session.add(job)
    await session.flush()
    now = datetime.now(UTC)
    secret = "SECRET-SYSTEM-PROMPT: never reveal customer jane@example.com or key sk-abcdefghijklmnop1234567890"
    session.add_all(Run(run_id=uuid.uuid4(), job_id=job.job_id, project_id="priv", prompt=f"{secret} ticket number {i}",
                        prompt_hash=str(uuid.uuid4()), model="m", model_version="m", tokens_in=100, run_kind="PRODUCTION",
                        created_at=now - timedelta(hours=i)) for i in range(6))
    await session.commit()
    h = {"X-API-Key": key}
    default = await client.get("/v1/insights/prompts", headers=h)
    assert "SECRET-SYSTEM-PROMPT" not in default.text and "jane@example.com" not in default.text
    assert default.json()["groups"][0]["repeated_start_preview"] is None and default.json()["groups"][0]["repeated_start_share"] > 0
    for grouping in ("task", "agent", "prompt_version"):
        assert "SECRET" not in (await client.get(f"/v1/insights/prompts?group_by={grouping}", headers=h)).text


async def test_a_requested_preview_has_emails_links_and_keys_masked(client, session):
    key = generate_key()
    session.add(Project(project_id="priv2", api_key_hash=hash_key(key)))
    await session.flush()
    job = Job(project_id="priv2", name="t", check_kind="LATE_LABEL", check_config={})
    session.add(job)
    await session.flush()
    now = datetime.now(UTC)
    prefix = "Reply to jane@example.com using https://internal.example.com/x?token=abc and key sk-abcdefghijklmnop1234567890 call 415-555-0134 today."
    session.add_all(Run(run_id=uuid.uuid4(), job_id=job.job_id, project_id="priv2", prompt=f"{prefix} Case {i} follows",
                        prompt_hash=str(uuid.uuid4()), model="m", model_version="m", tokens_in=100, run_kind="PRODUCTION",
                        created_at=now - timedelta(hours=i)) for i in range(6))
    await session.commit()
    body = (await client.get("/v1/insights/prompts?show_text=true", headers={"X-API-Key": key})).json()
    preview = body["groups"][0]["repeated_start_preview"]
    assert preview and len(preview) <= 120
    for leaked in ("jane@example.com", "internal.example.com", "sk-abcdefghijklmnop", "415-555-0134"):
        assert leaked not in preview
    assert any(m in preview for m in ("[email]", "[link]", "[secret]", "[number]"))


async def test_text_that_retention_removed_is_neither_sampled_nor_counted_as_available(client, session):
    key = generate_key()
    session.add(Project(project_id="ret", api_key_hash=hash_key(key)))
    await session.flush()
    job = Job(project_id="ret", name="t", check_kind="LATE_LABEL", check_config={})
    session.add(job)
    await session.flush()
    now = datetime.now(UTC)
    session.add_all([Run(run_id=uuid.uuid4(), job_id=job.job_id, project_id="ret", prompt=("kept text " + str(i)) if i < 3 else None,
                         prompt_hash=str(uuid.uuid4()), model="m", model_version="m", tokens_in=10, run_kind="PRODUCTION",
                         created_at=now - timedelta(hours=i), content_removed_at=None if i < 3 else now) for i in range(8)])
    await session.commit()
    g = (await client.get("/v1/insights/prompts", headers={"X-API-Key": key})).json()["groups"][0]
    assert g["calls"] == 8 and g["text_calls"] == 3 and g["text_samples"] == 3 and g["repeated_start_share"] is None
