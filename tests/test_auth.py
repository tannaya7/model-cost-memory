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
    assert config == {"google": False, "dev_login": False, "demo_project_id": None}


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
