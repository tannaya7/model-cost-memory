"""Sign-in, project ownership and the public demo, against a real Postgres. Emails are made up."""

import uuid
from datetime import UTC, datetime, timedelta

import pytest

from agent_memory.models import Job, Run
from agent_memory.projects import create_project


@pytest.fixture
def dev_login(monkeypatch):
    monkeypatch.setenv("DEV_LOGIN", "true")

    async def sign_in(client, email):
        response = await client.post("/auth/dev/login", json={"email": email})
        assert response.status_code == 200, response.text
        return response.json()

    return sign_in


async def test_dev_login_is_off_unless_enabled(client):
    assert (await client.post("/auth/dev/login", json={"email": "a@example.com"})).status_code == 404
    config = (await client.get("/auth/config")).json()
    assert config == {"google": False, "dev_login": False, "demo_project_id": None, "auto_replays": False}


async def test_google_sign_in_is_not_offered_without_credentials(client):
    assert (await client.get("/auth/google/login")).status_code == 404


async def test_a_signed_in_user_sees_only_their_own_projects(client, dev_login):
    me = await dev_login(client, "ana@example.com")
    assert (await client.get("/v1/me")).json()["email"] == "ana@example.com"
    created = (await client.post("/v1/projects", json={"name": "Ana's Invoices"})).json()
    project = created["project"]
    assert project["project_id"].startswith("ana-s-invoices-") and project["name"] == "Ana's Invoices"
    assert created["api_key"].startswith("mcm_live_") and project["key_prefix"] == created["api_key"][:13]
    assert project["webhook_secret"].startswith("whsec_")
    assert [p["project_id"] for p in (await client.get("/v1/projects")).json()] == [project["project_id"]]

    # Data routes act on the user's project through the session, without the key.
    assert (await client.post("/v1/jobs", json={"name": "invoice", "check_kind": "LATE_LABEL"})).status_code == 201
    assert [j["name"] for j in (await client.get("/v1/jobs")).json()] == ["invoice"]

    await client.post("/auth/logout")
    await dev_login(client, "ben@example.com")
    assert (await client.get("/v1/projects")).json() == []
    assert (await client.get(f"/v1/projects/{project['project_id']}")).status_code == 404
    headers = {"X-Project-Id": project["project_id"]}
    assert (await client.get("/v1/jobs", headers=headers)).status_code == 404  # not Ben's
    assert me["user_id"] != (await client.get("/v1/me")).json()["user_id"]


async def test_with_two_projects_the_user_must_choose_one(client, dev_login):
    await dev_login(client, "ana@example.com")
    first = (await client.post("/v1/projects", json={"name": "one"})).json()["project"]["project_id"]
    await client.post("/v1/projects", json={"name": "two"})
    assert (await client.get("/v1/jobs")).status_code == 400
    assert (await client.get("/v1/jobs", headers={"X-Project-Id": first})).status_code == 200


async def test_project_settings_and_key_rotation(client, dev_login):
    await dev_login(client, "ana@example.com")
    created = (await client.post("/v1/projects", json={"name": "Demo"})).json()
    pid, old_key = created["project"]["project_id"], created["api_key"]
    patched = (await client.patch(f"/v1/projects/{pid}", json={
        "webhook_url": "https://hooks.example/a", "retest_monthly_cap_usd": 25, "retest_allowed": False,
    })).json()
    assert (patched["webhook_url"], patched["retest_monthly_cap_usd"], patched["retest_allowed"]) == (
        "https://hooks.example/a", 25.0, False)
    assert (await client.patch(f"/v1/projects/{pid}", json={"webhook_url": "http://insecure"})).status_code == 422
    assert (await client.patch(f"/v1/projects/{pid}", json={"webhook_url": None})).json()["webhook_url"] is None

    new_key = (await client.post(f"/v1/projects/{pid}/key")).json()["api_key"]
    await client.post("/auth/logout")
    assert (await client.get("/v1/jobs", headers={"X-API-Key": old_key})).status_code == 401
    assert (await client.get("/v1/jobs", headers={"X-API-Key": new_key})).status_code == 200


async def test_signed_out_requests_are_refused(client):
    assert (await client.get("/v1/me")).status_code == 401
    assert (await client.get("/v1/projects")).status_code == 401
    assert (await client.get("/v1/jobs")).status_code == 401


async def test_the_public_demo_is_readable_by_anyone_but_never_changed(client, session, monkeypatch):
    await create_project(session, "public-demo")
    monkeypatch.setenv("DEMO_PROJECT_ID", "public-demo")
    assert (await client.get("/v1/jobs")).status_code == 200
    assert (await client.get("/auth/config")).json()["demo_project_id"] == "public-demo"
    refused = await client.post("/v1/jobs", json={"name": "spam", "check_kind": "LATE_LABEL"})
    assert refused.status_code == 401
    assert (await client.post("/v1/jobs/x/retest", json={"candidate_model": "m", "budget_usd": 1})).status_code == 401


async def test_job_insights_break_pass_rate_down_by_input_size_and_prompt_version(client, session):
    project, key = await create_project(session, "insights")
    job = Job(project_id="insights", name="invoice", check_kind="ANSWER_KEY", check_config={"fields": ["t"]})
    session.add(job)
    await session.flush()
    now = datetime.now(UTC)
    for i in range(40):
        long_doc = i % 2 == 1
        session.add(Run(
            run_id=uuid.uuid4(), job_id=job.job_id, project_id="insights", prompt="p", prompt_hash="h", model="mini",
            model_version="mini-2026-09", tokens_in=20_000 if long_doc else 1_000, prompt_version="v2" if i < 10 else "v1",
            outcome="FAIL" if long_doc and i % 4 == 1 else "PASS", cost_usd=0.002, state="INDEXED",
            created_at=now - timedelta(hours=i),
        ))
    await session.commit()
    body = (await client.get("/v1/jobs/invoice/insights", headers={"X-API-Key": key})).json()
    [overall] = body["overall"]
    assert (overall["model"], overall["runs"], overall["passed"]) == ("mini", 40, 30)
    assert overall["cost_per_success_usd"] == pytest.approx(0.002 / 0.75)
    bands = {b["group"]: b for b in body["by_input_size"]}
    assert bands["under 8k"]["pass_rate"] == 1.0 and bands["8k to 32k"]["pass_rate"] == 0.5
    assert bands["8k to 32k"]["pass_rate_low"] < 0.5 < bands["8k to 32k"]["pass_rate_high"]
    assert {b["group"] for b in body["by_prompt_version"]} == {"v1", "v2"}


async def test_a_person_can_remember_which_first_visit_guides_they_saw(client, dev_login):
    await dev_login(client, "ana@example.com")
    assert (await client.get("/v1/me")).json()["ui_flags"] == {}
    saved = await client.patch("/v1/me/ui-flags", json={"tour_seen": True})
    assert saved.status_code == 200 and saved.json()["ui_flags"] == {"tour_seen": True}
    again = await client.patch("/v1/me/ui-flags", json={"first_results_seen": True})
    assert again.json()["ui_flags"] == {"tour_seen": True, "first_results_seen": True}
    assert (await client.get("/v1/me")).json()["ui_flags"] == {"tour_seen": True, "first_results_seen": True}
    replay = await client.patch("/v1/me/ui-flags", json={"tour_seen": False})
    assert replay.json()["ui_flags"] == {"tour_seen": False, "first_results_seen": True}


async def test_only_the_two_guide_flags_can_be_saved_and_only_as_true_or_false(client, dev_login):
    await dev_login(client, "ana@example.com")
    for bad in ({"theme": True}, {"tour_seen": "yes"}, {"tour_seen": 1}, {"tour_seen": {"a": 1}}):
        assert (await client.patch("/v1/me/ui-flags", json=bad)).status_code == 422, bad
    assert (await client.get("/v1/me")).json()["ui_flags"] == {}


async def test_the_flags_belong_to_the_account_and_need_a_sign_in(client, dev_login):
    assert (await client.patch("/v1/me/ui-flags", json={"tour_seen": True})).status_code == 401
    await dev_login(client, "ana@example.com")
    await client.patch("/v1/me/ui-flags", json={"tour_seen": True})
    await client.post("/auth/logout")
    await dev_login(client, "ben@example.com")
    assert (await client.get("/v1/me")).json()["ui_flags"] == {}


async def test_tool_inputs_are_off_by_default_and_the_owner_can_switch_them(client, dev_login):
    await dev_login(client, "ana@example.com")
    pid = (await client.post("/v1/projects", json={"name": "Demo"})).json()["project"]["project_id"]
    assert (await client.get(f"/v1/projects/{pid}")).json()["store_tool_arguments"] is False
    on = await client.patch(f"/v1/projects/{pid}", json={"store_tool_arguments": True})
    assert on.json()["store_tool_arguments"] is True
    # an unrelated change leaves the switch alone
    assert (await client.patch(f"/v1/projects/{pid}", json={"name": "Renamed"})).json()["store_tool_arguments"] is True
    assert (await client.patch(f"/v1/projects/{pid}", json={"store_tool_arguments": False})).json()["store_tool_arguments"] is False
    assert (await client.patch(f"/v1/projects/{pid}", json={"store_tool_arguments": "maybe"})).status_code == 422


async def test_only_the_owner_changes_or_clears_tool_inputs(client, dev_login):
    await dev_login(client, "ana@example.com")
    pid = (await client.post("/v1/projects", json={"name": "Demo"})).json()["project"]["project_id"]
    await client.post("/auth/logout")
    assert (await client.patch(f"/v1/projects/{pid}", json={"store_tool_arguments": True})).status_code == 401
    assert (await client.delete(f"/v1/projects/{pid}/tool-inputs")).status_code == 401
    await dev_login(client, "ben@example.com")
    assert (await client.patch(f"/v1/projects/{pid}", json={"store_tool_arguments": True})).status_code in (403, 404)
    assert (await client.delete(f"/v1/projects/{pid}/tool-inputs")).status_code in (403, 404)


async def test_deleting_tool_inputs_keeps_names_and_other_runs(client, dev_login, session):
    me = await dev_login(client, "ana@example.com")
    assert me
    pid = (await client.post("/v1/projects", json={"name": "Demo"})).json()["project"]["project_id"]
    other, _ = await create_project(session, "someone-else")
    job = Job(project_id=pid, name="a", check_kind="ANSWER_KEY", check_config={"fields": ["t"]})
    other_job = Job(project_id="someone-else", name="a", check_kind="ANSWER_KEY", check_config={"fields": ["t"]})
    session.add_all([job, other_job])
    await session.flush()
    kept = [{"name": "lookup", "id": "c1", "arguments": {"q": "secret"}}, {"name": "send", "id": "c2"}]

    def run(job_id, project_id, calls):
        return Run(run_id=uuid.uuid4(), job_id=job_id, project_id=project_id, prompt="p", prompt_hash="h", model="m",
                   model_version="m-1", tokens_in=1, outcome="PASS", cost_usd=0.001, state="INDEXED", tool_calls=calls)

    mine, theirs, plain = run(job.job_id, pid, kept), run(other_job.job_id, "someone-else", kept), run(job.job_id, pid, [{"name": "x", "id": "c3"}])
    session.add_all([mine, theirs, plain])
    await session.commit()
    done = await client.delete(f"/v1/projects/{pid}/tool-inputs")
    assert done.status_code == 200 and done.json() == {"runs_cleared": 1}
    await session.refresh(mine), await session.refresh(theirs), await session.refresh(plain)
    assert mine.tool_calls == [{"name": "lookup", "id": "c1"}, {"name": "send", "id": "c2"}]
    assert theirs.tool_calls == kept and plain.tool_calls == [{"name": "x", "id": "c3"}]


async def test_billing_mode_defaults_to_per_use_and_the_owner_can_change_it(client, dev_login):
    await dev_login(client, "ana@example.com")
    made = (await client.post("/v1/projects", json={"name": "Demo"})).json()["project"]
    pid = made["project_id"]
    assert made["billing_mode"] == "per_use"  # existing behaviour is unchanged unless someone opts in
    assert (await client.get(f"/v1/projects/{pid}")).json()["billing_mode"] == "per_use"
    assert (await client.patch(f"/v1/projects/{pid}", json={"billing_mode": "subscription"})).json()["billing_mode"] == "subscription"
    # an unrelated change leaves it alone
    assert (await client.patch(f"/v1/projects/{pid}", json={"name": "Renamed"})).json()["billing_mode"] == "subscription"
    assert (await client.patch(f"/v1/projects/{pid}", json={"billing_mode": "both"})).json()["billing_mode"] == "both"
    assert [p["billing_mode"] for p in (await client.get("/v1/projects")).json()] == ["both"]
    assert (await client.patch(f"/v1/projects/{pid}", json={"billing_mode": "free"})).status_code == 422
    assert (await client.patch(f"/v1/projects/{pid}", json={"billing_mode": None})).json()["billing_mode"] == "both"


async def test_a_project_can_be_created_with_a_billing_mode(client, dev_login):
    await dev_login(client, "ana@example.com")
    made = await client.post("/v1/projects", json={"name": "Sub", "billing_mode": "subscription"})
    assert made.json()["project"]["billing_mode"] == "subscription"
    assert (await client.post("/v1/projects", json={"name": "Bad", "billing_mode": "x"})).status_code == 422


async def test_only_the_owner_changes_the_billing_mode(client, dev_login):
    await dev_login(client, "ana@example.com")
    pid = (await client.post("/v1/projects", json={"name": "Demo"})).json()["project"]["project_id"]
    await client.post("/auth/logout")
    assert (await client.patch(f"/v1/projects/{pid}", json={"billing_mode": "both"})).status_code == 401
    await dev_login(client, "ben@example.com")
    assert (await client.patch(f"/v1/projects/{pid}", json={"billing_mode": "both"})).status_code in (403, 404)


async def test_f22_input_size_band_counts_cached_tokens(client, session):
    project, key = await create_project(session, "bands")
    job = Job(project_id="bands", name="doc", check_kind="ANSWER_KEY", check_config={"fields": ["t"]})
    session.add(job)
    await session.flush()
    session.add(Run(
        run_id=uuid.uuid4(), job_id=job.job_id, project_id="bands", prompt="p", prompt_hash="h", model="mini",
        model_version="mini-2026-09", tokens_in=500, cache_read_tokens=100_000, outcome="PASS", cost_usd=0.002,
        state="INDEXED", created_at=datetime.now(UTC) - timedelta(hours=1),
    ))
    await session.commit()
    body = (await client.get("/v1/jobs/doc/insights", headers={"X-API-Key": key})).json()
    assert [b["group"] for b in body["by_input_size"]] != ["under 8k"]


async def test_the_welcome_flag_is_saved_per_account_and_nothing_else_is_accepted(client, dev_login):
    await dev_login(client, "new@example.com")
    assert (await client.get("/v1/me")).json()["ui_flags"] == {}
    saved = await client.patch("/v1/me/ui-flags", json={"welcome_seen": True})
    assert saved.status_code == 200 and saved.json()["ui_flags"] == {"welcome_seen": True}
    assert (await client.patch("/v1/me/ui-flags", json={"name": "x"})).status_code == 422
    await dev_login(client, "other@example.com")
    assert (await client.get("/v1/me")).json()["ui_flags"] == {}
