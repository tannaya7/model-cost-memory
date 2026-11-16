"""Before and after a prompt change: tagged and detected versions, honesty signals, and GET /v1/insights/prompt-versions."""

import uuid
from datetime import UTC, datetime, timedelta

from agent_memory.insights.prompt_versions import RunRow, build_versions, detect_boundaries
from agent_memory.models import Job, Project, Run
from agent_memory.security import generate_key, hash_key

T0 = datetime(2026, 11, 1, tzinfo=UTC)
A = "You are a support assistant for Acme. Be brief and polite. Ticket: "
B = "You are a support assistant for Acme. Answer in two sentences at most and never guess. Ticket: "


def row(i, version=None, text=None, tin=100, tout=20, cread=0, cost=0.01, outcome="UNKNOWN"):
    return RunRow(T0 + timedelta(minutes=i), version, text, tin, tout, cread, 0, cost, outcome)


def test_tagged_side_by_side_and_summary():
    rows = []
    for i in range(60):
        rows.append(row(i, "v1", tin=100, outcome="PASS" if i % 5 else "FAIL"))
        rows.append(row(i, "v2", tin=68, outcome="PASS" if i % 5 else "FAIL"))
    r = build_versions(rows)
    assert r.source == "tagged" and r.reason is None
    assert [v.label for v in r.versions] == ["Version v1", "Version v2"]
    c = r.comparison
    assert c.side_by_side is True
    assert "Version v2 sends about 32% fewer input tokens than Version v1." in c.summary
    assert "Correct answers look about the same, but only 60 were checked." in c.summary
    for word in ("better", "worse", "saves", "because"):
        assert word not in c.summary


def test_ran_at_different_times():
    rows = [row(i, "v1") for i in range(10)] + [row(1000 + i, "v2") for i in range(10)]
    assert build_versions(rows).comparison.side_by_side is False


def test_unpriced_calls_counted_and_cost_is_for_priced_only():
    rows = [row(i, "v1", cost=0.02 if i < 6 else None) for i in range(10)] + [row(i, "v2", cost=0.01) for i in range(10)]
    v1 = build_versions(rows).versions[0]
    assert (v1.priced_calls, v1.unpriced_calls) == (6, 4)
    assert v1.cost_per_call == 0.02


def test_thin_checked_data_gives_no_rate():
    rows = [row(i, "v1", outcome="PASS") for i in range(24)] + [row(i, "v2", outcome="PASS") for i in range(30)]
    r = build_versions(rows)
    assert r.versions[0].correct_rate is None and r.versions[0].checked == 24
    assert r.versions[1].correct_rate == 1.0 and r.versions[1].rate_low < 1.0
    assert "not enough checked answers" in r.comparison.summary


def test_rate_difference_is_stated_as_numbers():
    rows = [row(i, "v1", outcome="PASS") for i in range(100)] + [row(i, "v2", outcome="PASS" if i < 50 else "FAIL") for i in range(100)]
    assert "Correct answers differ: 100% for Version v1 and 50% for Version v2" in build_versions(rows).comparison.summary


def test_single_tag_is_not_a_comparison():
    r = build_versions([row(i, "v1") for i in range(10)])
    assert r.source == "tagged" and r.reason == "no_change" and r.comparison is None


def test_cache_loss_is_visible():
    rows = [row(i, "v1", tin=100, cread=300) for i in range(10)] + [row(i, "v2", tin=70, cread=0) for i in range(10)]
    assert "cached share went down from 75% to 0%" in build_versions(rows).comparison.summary


def test_nothing_to_compare_and_no_calls():
    assert build_versions([]).reason == "no_calls"
    assert build_versions([row(i, text=A + str(i)) for i in range(12)]).reason == "no_change"


def test_detected_change_that_persists():
    rows = [row(i, text=A + f"issue {i}") for i in range(20)] + [row(20 + i, text=B + f"issue {i}", tin=60) for i in range(20)]
    r = build_versions(rows)
    assert r.source == "detected"
    assert [v.label for v in r.versions] == ["Detected version 1", "Detected version 2"]
    assert [v.calls for v in r.versions] == [20, 20]
    assert r.versions[1].start_preview.startswith("You are a support assistant for Acme. Answer in two")
    assert r.comparison.side_by_side is False


def test_one_off_difference_creates_no_version():
    rows = [row(i, text=A + f"x{i}") for i in range(20)]
    rows[10] = row(10, text=B + "odd one")
    rows[11] = row(11, text=B + "another odd one")
    assert build_versions(rows).reason == "no_change"


def test_flapping_back_is_the_same_version():
    seq = [A] * 8 + [B] * 8 + [A] * 8
    rows = [row(i, text=s + str(i)) for i, s in enumerate(seq)]
    r = build_versions(rows)
    assert r.source == "detected" and len(r.versions) == 2
    assert r.versions[0].calls == 16 and r.versions[1].calls == 8


def test_whitespace_changes_are_not_versions():
    rows = [row(i, text=A + str(i)) for i in range(10)] + [row(10 + i, text=A.replace(" ", "  \n") + str(i)) for i in range(10)]
    assert build_versions(rows).reason == "no_change"


def test_text_cleared_by_retention():
    assert build_versions([row(i) for i in range(20)]).reason == "text_not_kept"


def test_calls_without_text_join_the_version_by_time():
    rows = [row(i, text=A + str(i)) for i in range(10)] + [row(10 + i, text=B + str(i)) for i in range(10)]
    rows += [row(15), row(3)]
    assert [v.calls for v in build_versions(rows).versions] == [11, 11]


def test_detect_needs_stable_start():
    assert detect_boundaries(["short"] * 20) is None
    assert detect_boundaries([f"{i} different {i * 7} words here and there for padding" for i in range(20)]) is None


# ---- endpoint ----


async def test_endpoint(client, session):
    key, other = generate_key(), generate_key()
    session.add_all([Project(project_id="acme", api_key_hash=hash_key(key)), Project(project_id="other", api_key_hash=hash_key(other))])
    await session.flush()
    job = Job(project_id="acme", name="support", check_kind="LATE_LABEL", check_config={})
    elsewhere = Job(project_id="other", name="support", check_kind="LATE_LABEL", check_config={})
    session.add_all([job, elsewhere])
    await session.flush()
    now = datetime.now(UTC)
    for i in range(12):
        for v in ("v1", "v2"):
            session.add(Run(run_id=uuid.uuid4(), job_id=job.job_id, project_id="acme", prompt=f"p{i}", prompt_hash=str(uuid.uuid4()),
                            prompt_version=v, model="m", model_version="m-1", tokens_in=100 if v == "v1" else 70, tokens_out=10,
                            created_at=now - timedelta(hours=i), outcome="PASS"))
    session.add(Run(run_id=uuid.uuid4(), job_id=elsewhere.job_id, project_id="other", prompt="x", prompt_hash="h", prompt_version="v9",
                    model="m", model_version="m-1", created_at=now))
    await session.commit()
    h = {"X-API-Key": key}
    body = (await client.get("/v1/insights/prompt-versions?job=support", headers=h)).json()
    assert body["source"] == "tagged" and [v["label"] for v in body["versions"]] == ["Version v1", "Version v2"]
    assert body["comparison"]["side_by_side"] is True and body["versions"][0]["calls"] == 12
    assert body["versions"][0]["unpriced_calls"] == 12 and body["versions"][0]["cost_per_call"] is None
    assert (await client.get("/v1/insights/prompt-versions?job=nope", headers=h)).status_code == 404
    assert (await client.get("/v1/insights/prompt-versions", headers=h)).status_code == 422
    theirs = (await client.get("/v1/insights/prompt-versions?job=support", headers={"X-API-Key": other})).json()
    assert [v["label"] for v in theirs["versions"]] == ["Version v9"]


def test_f20_a_rollback_compares_the_version_in_use_now_as_the_newer_one():
    rows = ([row(i, "v1") for i in range(10)] + [row(10 + i, "v2") for i in range(10)]
            + [row(20 + i, "v1") for i in range(10)])
    c = build_versions(rows).comparison
    assert (c.older, c.newer) == ("Version v2", "Version v1")
    assert c.summary.startswith("Went back to Version v1")


def test_f20_a_b_a_detected_names_the_live_version_as_newer():
    rows = ([row(i, text=A + f"t{i}") for i in range(12)] + [row(12 + i, text=B + f"t{i}") for i in range(12)]
            + [row(24 + i, text=A + f"t{i}") for i in range(12)])
    r = build_versions(rows)
    assert r.source == "detected" and len(r.versions) == 2
    assert (r.comparison.older, r.comparison.newer) == ("Detected version 2", "Detected version 1")
