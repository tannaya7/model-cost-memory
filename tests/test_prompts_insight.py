"""Where your tokens went: pure prefix/suffix functions and GET /v1/insights/prompts."""

import uuid
from datetime import UTC, datetime, timedelta

import pytest

from agent_memory.insights.prompts import common_prefix_len, common_suffix_len, repeated_parts
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
    assert v1["repeated_start_preview"].startswith("SYSTEM: be brief and kind. Ticket")
    assert groups[3]["text_samples"] == 1 and groups[3]["repeated_start_share"] is None  # fewer than 5


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
    assert body == {"days": 30, "total_tokens": 0, "groups": []}
