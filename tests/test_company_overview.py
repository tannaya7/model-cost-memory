"""The company overview: aggregates only, honest labels, permission-filtered, isolated per company.

Real Postgres, made-up data, no external connection."""

import json
import uuid
from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import update

from agent_memory.models import Job, Project, Run

SECRET = "SECRET PROMPT TEXT"


@pytest.fixture
def dev_login(monkeypatch):
    monkeypatch.setenv("DEV_LOGIN", "true")

    async def sign_in(client, email):
        await client.post("/auth/logout")
        assert (await client.post("/auth/dev/login", json={"email": email})).status_code == 200

    return sign_in


async def _company(client, name="Acme"):
    return (await client.post("/v1/organisations", json={"name": name})).json()["org_id"]


async def _project(client, session, org, name, mode="per_use"):
    made = (await client.post("/v1/projects", json={"name": name, "organisation_id": org, "billing_mode": mode})).json()
    pid = made["project"]["project_id"]
    return pid


async def _runs(session, pid, task, n, *, cost=0.01, tokens=1000, shape="openai_chat", model="mini", agent=None, trace=None, days_ago=1):
    job = (await session.execute(Job.__table__.select().where(Job.project_id == pid, Job.name == task))).first()
    if job is None:
        j = Job(project_id=pid, name=task, check_kind="ANSWER_KEY", check_config={"fields": ["t"]})
        session.add(j)
        await session.flush()
        job_id = j.job_id
    else:
        job_id = job.job_id
    for i in range(n):
        session.add(Run(
            run_id=uuid.uuid4(), job_id=job_id, project_id=pid, prompt=SECRET, output="SECRET ANSWER", prompt_hash="h",
            model=model, model_version=f"{model}-1", tokens_in=tokens, tokens_out=0, cost_usd=cost, usage_shape=shape,
            outcome="PASS", state="INDEXED", agent=agent, trace_id=trace,
            created_at=datetime.now(UTC) - timedelta(days=days_ago, minutes=i),
        ))
    await session.commit()


async def _get(client, org, days=30):
    return await client.get(f"/v1/organisations/{org}/overview?days={days}")


async def test_a_company_with_no_projects_or_no_data_gets_zeros_not_errors(client, dev_login, session):
    await dev_login(client, "owner@example.com")
    org = await _company(client)
    empty = (await _get(client, org)).json()
    assert empty["totals"]["has_data"] is False and empty["totals"]["calls"] == 0 and empty["projects"] == []
    assert empty["trend"] == [] and empty["tasks"] == [] and empty["models"] == [] and empty["projects_shown"] == 0
    assert empty["totals"]["billable_usd"] == 0.0 and empty["coverage"]["token_report_share"] is None
    await _project(client, session, org, "Quiet")
    quiet = (await _get(client, org)).json()
    assert quiet["projects_shown"] == 1 and quiet["totals"]["calls"] == 0 and quiet["projects"][0]["calls"] == 0
    assert quiet["totals"]["has_data"] is False and quiet["attribution"]  # the provenance is stated even with no data


async def test_a_one_person_company_shows_no_people_and_no_per_person_numbers(client, dev_login, session):
    await dev_login(client, "solo@example.com")
    org = await _company(client)
    pid = await _project(client, session, org, "Solo")
    await _runs(session, pid, "invoice", 8, agent="alice-the-accountant", trace="t1")
    body = (await _get(client, org)).json()
    assert body["members"] == 1 and body["totals"]["calls"] == 8
    blob = json.dumps(body)
    assert "solo@example.com" not in blob and "alice-the-accountant" not in blob  # no address, no agent label
    person = next(a for a in body["attribution"] if a["dimension"] == "person")
    assert person["source"] == "not_recorded" and "no per-person" in person["detail"].lower()
    for forbidden in ("user_id", "leaderboard", "rank", "score", "productivity", "employee"):
        assert forbidden not in blob.lower(), forbidden


async def test_pay_modes_are_kept_apart_and_flat_plans_show_no_dollars(client, dev_login, session):
    await dev_login(client, "owner@example.com")
    org = await _company(client)
    per_use = await _project(client, session, org, "Metered", "per_use")
    flat = await _project(client, session, org, "Flat", "subscription")
    mixed = await _project(client, session, org, "Mixed", "both")
    await _runs(session, per_use, "a", 10, cost=0.02, tokens=1000)
    await _runs(session, flat, "b", 10, cost=0.5, tokens=2000)  # a flat plan: cost is recorded but must not be shown
    await _runs(session, mixed, "c", 10, cost=0.03, tokens=500)
    body = (await _get(client, org)).json()
    rows = {r["name"]: r for r in body["projects"]}
    assert rows["Metered"]["cost_usd"] == pytest.approx(0.2) and rows["Metered"]["cost_kind"] == "billable_list_price"
    assert rows["Flat"]["cost_usd"] is None and rows["Flat"]["cost_kind"] == "none_flat_plan"
    assert rows["Flat"]["calls"] == 10 and rows["Flat"]["tokens"] == 20000  # counts and tokens remain
    assert rows["Mixed"]["cost_usd"] == pytest.approx(0.3) and rows["Mixed"]["cost_kind"] == "list_price_may_include_flat_plan"
    # The billable total is the per-use project only; the mixed project's dollars stay apart; the flat plan adds none.
    assert body["totals"]["billable_usd"] == pytest.approx(0.2) and body["totals"]["mixed_mode_usd"] == pytest.approx(0.3)
    assert body["by_mode"]["subscription"]["usd"] is None and body["by_mode"]["subscription"]["calls"] == 10
    assert body["totals"]["calls"] == 30 and body["totals"]["tokens"] == 10000 + 20000 + 5000
    assert "invoice" in body["totals"]["billable_basis"] and body["chargeback_grade"] is False
    assert "0.5" not in json.dumps([r for r in body["tasks"] if r["pay_mode"] == "subscription"])
    assert all(t["cost_usd"] is None for t in body["tasks"] if t["pay_mode"] == "subscription")
    assert sum(d["billable_usd"] for d in body["trend"]) == pytest.approx(0.2)  # the trend counts per-use projects only


async def test_unpriced_calls_are_counted_as_unknown_never_as_free(client, dev_login, session):
    await dev_login(client, "owner@example.com")
    org = await _company(client)
    pid = await _project(client, session, org, "Metered")
    await _runs(session, pid, "priced", 6, cost=0.01)
    await _runs(session, pid, "mystery", 6, cost=None, model="unlisted-model")
    await _runs(session, pid, "silent", 6, cost=None, tokens=0, shape="none")  # a provider that reported no usage
    body = (await _get(client, org)).json()
    assert body["totals"]["unpriced_calls"] == 12 and body["projects"][0]["unpriced_calls"] == 12
    assert body["totals"]["billable_usd"] == pytest.approx(0.06)  # only what could be priced
    cov = body["coverage"]
    assert cov["calls"] == 18 and cov["calls_priced"] == 6 and cov["calls_without_token_counts"] == 6
    assert cov["token_report_share"] == pytest.approx(12 / 18, abs=1e-3)
    assert any("report no token counts" in n for n in body["notes"])
    unlisted = next(m for m in body["models"] if m["model"] == "unlisted-model")
    assert unlisted["unpriced_calls"] == 6 and unlisted["cost_usd"] == 0.0


async def test_attribution_says_what_is_verified_and_what_the_app_supplied(client, dev_login, session):
    await dev_login(client, "owner@example.com")
    org = await _company(client)
    pid = await _project(client, session, org, "Metered")
    await _runs(session, pid, "t", 10, agent="a1", trace="x")
    await _runs(session, pid, "u", 10)
    body = (await _get(client, org)).json()
    prov = {a["dimension"]: a for a in body["attribution"]}
    assert prov["project"]["source"] == "verified"
    assert {prov[d]["source"] for d in ("task", "model", "agent", "task_trace")} == {"caller_supplied"}
    assert prov["person"]["source"] == "not_recorded"
    assert prov["agent"]["coverage_share"] == pytest.approx(0.5) and prov["task_trace"]["coverage_share"] == pytest.approx(0.5)
    assert all(t["label_source"] == "caller_supplied" for t in body["tasks"] + body["models"])
    text = " ".join(body["notes"]).lower()
    assert "spoofed" in text and "invoices" in text and "chargeback" in text
    assert "complian" not in json.dumps(body).lower()  # no legal-compliance claim anywhere


async def test_small_groups_are_folded_and_the_rest_is_ranked_by_calls_not_by_anyone(client, dev_login, session):
    await dev_login(client, "owner@example.com")
    org = await _company(client)
    pid = await _project(client, session, org, "Metered")
    await _runs(session, pid, "big", 12)
    await _runs(session, pid, "tiny-one", 2)
    await _runs(session, pid, "tiny-two", 1)
    body = (await _get(client, org)).json()
    names = [t["task"] for t in body["tasks"]]
    assert names == ["big", "Other small groups"]
    other = body["tasks"][-1]
    assert other["calls"] == 3 and other["folded_groups"] == 2 and other["project"] is None
    assert "tiny-one" not in json.dumps(body)


async def test_no_text_ever_leaves_in_the_overview(client, dev_login, session):
    await dev_login(client, "owner@example.com")
    org = await _company(client)
    pid = await _project(client, session, org, "Metered")
    await _runs(session, pid, "invoice", 10)
    for who_email in ("owner@example.com",):
        body = await _get(client, org)
        assert SECRET not in body.text and "SECRET ANSWER" not in body.text, who_email
    assert body.json()["notes"][-1].startswith("No prompt") or any("No prompt or answer text" in n for n in body.json()["notes"])


async def test_time_trend_groups_by_day_and_the_window_is_respected(client, dev_login, session):
    await dev_login(client, "owner@example.com")
    org = await _company(client)
    pid = await _project(client, session, org, "Metered")
    await _runs(session, pid, "t", 5, days_ago=1)
    await _runs(session, pid, "t", 5, days_ago=3)
    await _runs(session, pid, "t", 5, days_ago=20)
    week = (await _get(client, org, 7)).json()
    assert week["totals"]["calls"] == 10 and len(week["trend"]) in (2, 3)
    month = (await _get(client, org, 30)).json()
    assert month["totals"]["calls"] == 15
    assert [d["day"] for d in month["trend"]] == sorted(d["day"] for d in month["trend"])
    assert (await _get(client, org, 5)).status_code == 422


async def test_every_role_sees_the_aggregates_a_stranger_and_a_key_see_nothing(client, dev_login, session):
    await dev_login(client, "owner@example.com")
    org = await _company(client)
    created = (await client.post("/v1/projects", json={"name": "Metered", "organisation_id": org})).json()
    await _runs(session, created["project"]["project_id"], "t", 6)
    for role in ("viewer", "member", "admin"):
        await dev_login(client, "owner@example.com")
        token = (await client.post(f"/v1/organisations/{org}/invites", json={"email": f"{role}@example.com", "role": role})).json()["token"]
        await dev_login(client, f"{role}@example.com")
        await client.post("/v1/invites/accept", json={"token": token})
        got = await _get(client, org)
        assert got.status_code == 200 and got.json()["your_role"] == role and got.json()["totals"]["calls"] == 6, role
        assert SECRET not in got.text and f"{role}@example.com" not in got.text
    await dev_login(client, "stranger@example.com")
    assert (await _get(client, org)).status_code == 404
    await client.post("/auth/logout")
    assert (await _get(client, org)).status_code == 401
    assert (await client.get(f"/v1/organisations/{org}/overview", headers={"X-API-Key": created["api_key"]})).status_code == 401


async def test_two_companies_never_see_each_others_numbers(client, dev_login, session):
    await dev_login(client, "owner@example.com")
    a = await _company(client, "Acme")
    pa = await _project(client, session, a, "Alpha")
    await _runs(session, pa, "a-task", 10, model="model-a", cost=0.01)
    await dev_login(client, "rival@example.com")
    b = await _company(client, "Rival")
    pb = await _project(client, session, b, "Beta")
    await _runs(session, pb, "b-task", 20, model="model-b", cost=0.02)
    rival = (await _get(client, b)).json()
    assert rival["totals"]["calls"] == 20 and [r["name"] for r in rival["projects"]] == ["Beta"]
    assert {t["task"] for t in rival["tasks"]} == {"b-task"} and {m["model"] for m in rival["models"]} == {"model-b"}
    assert "Alpha" not in json.dumps(rival) and "a-task" not in json.dumps(rival)
    assert (await _get(client, a)).status_code == 404  # and no way in to the other company's overview
    await dev_login(client, "owner@example.com")
    mine = (await _get(client, a)).json()
    assert mine["totals"]["calls"] == 10 and "b-task" not in json.dumps(mine) and "Beta" not in json.dumps(mine)
    # a personal project of the same person is never part of a company's overview
    personal = (await client.post("/v1/projects", json={"name": "Private"})).json()["project"]["project_id"]
    await _runs(session, personal, "private-task", 9)
    assert "private-task" not in json.dumps((await _get(client, a)).json())


async def test_a_project_in_another_pay_mode_moves_between_buckets_when_changed(client, dev_login, session):
    await dev_login(client, "owner@example.com")
    org = await _company(client)
    pid = await _project(client, session, org, "Switcher")
    await _runs(session, pid, "t", 10, cost=0.01)
    assert (await _get(client, org)).json()["totals"]["billable_usd"] == pytest.approx(0.1)
    await session.execute(update(Project).where(Project.project_id == pid).values(billing_mode="subscription"))
    await session.commit()
    after = (await _get(client, org)).json()
    assert after["totals"]["billable_usd"] == 0.0 and after["projects"][0]["cost_usd"] is None and after["by_mode"]["subscription"]["calls"] == 10


async def test_a_model_used_by_only_a_few_calls_is_folded_like_a_small_task(client, dev_login, session):
    """A rarely used model name can point at one person's experiments, so it is not named (the same rule as small tasks)."""
    await dev_login(client, "owner@example.com")
    org = await _company(client)
    pid = await _project(client, session, org, "Metered")
    await _runs(session, pid, "big", 20, model="common")
    await _runs(session, pid, "big", 3, model="my-secret-experiment", cost=0.05)
    await _runs(session, pid, "big", 1, model="another-rare-one", cost=0.07)
    body = (await _get(client, org)).json()
    names = [m["model"] for m in body["models"]]
    assert names == ["common", "Other small groups"]
    other = body["models"][-1]
    assert other["calls"] == 4 and other["folded_groups"] == 2
    assert other["cost_usd"] == pytest.approx(3 * 0.05 + 0.07)
    assert "my-secret-experiment" not in json.dumps(body) and "another-rare-one" not in json.dumps(body)
    assert sum(m["calls"] for m in body["models"]) == body["totals"]["calls"]  # folding loses nothing


async def test_models_beyond_the_top_fifteen_are_folded_too_and_the_table_still_adds_up(client, dev_login, session):
    await dev_login(client, "owner@example.com")
    org = await _company(client)
    pid = await _project(client, session, org, "Metered")
    for i in range(17):
        await _runs(session, pid, "big", 6, model=f"model-{i:02d}")
    body = (await _get(client, org)).json()
    assert len(body["models"]) == 16 and body["models"][-1]["model"] == "Other small groups"
    assert body["models"][-1]["folded_groups"] == 2
    assert sum(m["calls"] for m in body["models"]) == 17 * 6 == body["totals"]["calls"]


async def test_a_model_with_exactly_the_minimum_calls_is_named(client, dev_login, session):
    await dev_login(client, "owner@example.com")
    org = await _company(client)
    pid = await _project(client, session, org, "Metered")
    await _runs(session, pid, "big", 5, model="five-calls")
    await _runs(session, pid, "big", 4, model="four-calls")
    names = [m["model"] for m in (await _get(client, org)).json()["models"]]
    assert names == ["five-calls", "Other small groups"]
