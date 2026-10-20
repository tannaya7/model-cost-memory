"""Outcomes are resolved on arrival, or later by a label (embedded Postgres)."""

import uuid

import pytest
from sqlalchemy import select

from agent_memory.models import Project, Run
from agent_memory.security import generate_key, hash_key

INVOICE = {"vendor": "ShopCo Ltd", "total": 1250.0}


@pytest.fixture
async def headers(session):
    key = generate_key()
    session.add(Project(project_id="demo", api_key_hash=hash_key(key)))
    session.add(Project(project_id="other", api_key_hash=hash_key(generate_key())))
    await session.commit()
    return {"X-API-Key": key}


async def make_job(client, headers, kind, config, name="j"):
    r = await client.post("/v1/jobs", json={"name": name, "check_kind": kind, "check_config": config}, headers=headers)
    assert r.status_code == 201
    return name


def run(job, **over):
    return {"run_id": str(uuid.uuid4()), "job": job, "prompt": "p", "model": "m", "model_version": "v1", **over}


async def send(client, headers, body):
    assert (await client.post("/v1/runs", json=body, headers=headers)).status_code == 202
    return (await client.get(f"/v1/runs/{body['run_id']}", headers=headers)).json()


async def test_an_answer_key_job_passes_a_correct_answer(client, headers):
    job = await make_job(client, headers, "ANSWER_KEY", {"fields": ["vendor", "total"]})
    got = await send(client, headers, run(job, output='{"vendor": "shopco ltd", "total": "1,250.00"}', expected=INVOICE))
    assert got["outcome"] == "PASS" and got["state"] == "CHECKED" and "all 2 fields" in got["outcome_reason"]


async def test_an_answer_key_job_fails_a_wrong_answer_and_says_why(client, headers):
    job = await make_job(client, headers, "ANSWER_KEY", {"fields": ["vendor", "total"]})
    got = await send(client, headers, run(job, output='{"vendor": "ShopCo Ltd", "total": 1205}', expected=INVOICE))
    assert got["outcome"] == "FAIL" and "total: expected 1250.0, got 1205" in got["outcome_reason"]
    assert got["state"] == "CHECKED"


async def test_without_an_expected_answer_the_run_stays_unknown(client, headers):
    job = await make_job(client, headers, "ANSWER_KEY", {"fields": ["total"]})
    got = await send(client, headers, run(job, output='{"total": 1}'))
    assert got["outcome"] == "UNKNOWN" and got["state"] == "CAPTURED"
    assert "no expected value" in got["outcome_reason"]


async def test_the_expected_answer_is_used_but_not_stored(client, headers, session):
    job = await make_job(client, headers, "ANSWER_KEY", {"fields": ["total"]})
    await send(client, headers, run(job, output='{"total": 5}', expected={"total": 5}))
    stored = (await session.execute(select(Run))).scalar_one()
    assert "expected" not in {c.name for c in Run.__table__.columns} and stored.outcome == "PASS"


async def test_a_schema_job_checks_the_shape(client, headers):
    schema = {"type": "object", "required": ["category"], "properties": {"category": {"enum": ["bug", "billing"]}}}
    job = await make_job(client, headers, "SCHEMA", {"schema": schema})
    good = await send(client, headers, run(job, output='```json\n{"category": "bug"}\n```'))
    bad = await send(client, headers, run(job, output='{"category": "spam"}'))
    assert good["outcome"] == "PASS"
    assert bad["outcome"] == "FAIL" and "category" in bad["outcome_reason"]


async def test_a_late_label_job_is_unknown_until_labelled(client, headers):
    job = await make_job(client, headers, "LATE_LABEL", {})
    body = run(job, output="whatever")
    got = await send(client, headers, body)
    assert got["outcome"] == "UNKNOWN"
    labelled = await client.post(f"/v1/runs/{body['run_id']}/label", json={"outcome": "FAIL", "reason": "customer rejected it"}, headers=headers)
    assert labelled.status_code == 200
    data = labelled.json()
    assert data["outcome"] == "FAIL" and data["state"] == "CHECKED"
    assert data["outcome_reason"] == "labelled FAIL: customer rejected it"


async def test_an_unknown_answer_key_run_can_be_labelled_later(client, headers):
    job = await make_job(client, headers, "ANSWER_KEY", {"fields": ["total"]})
    body = run(job, output='{"total": 5}')  # no expected answer was sent
    await send(client, headers, body)
    r = await client.post(f"/v1/runs/{body['run_id']}/label", json={"outcome": "PASS"}, headers=headers)
    assert r.json()["outcome"] == "PASS"


async def test_a_resolved_run_cannot_be_relabelled(client, headers):
    job = await make_job(client, headers, "ANSWER_KEY", {"fields": ["total"]})
    body = run(job, output='{"total": 5}', expected={"total": 5})
    await send(client, headers, body)
    r = await client.post(f"/v1/runs/{body['run_id']}/label", json={"outcome": "FAIL"}, headers=headers)
    assert r.status_code == 409


async def test_label_input_and_ownership_are_checked(client, headers):
    job = await make_job(client, headers, "LATE_LABEL", {})
    body = run(job)
    await send(client, headers, body)
    url = f"/v1/runs/{body['run_id']}/label"
    assert (await client.post(url, json={"outcome": "UNKNOWN"}, headers=headers)).status_code == 422
    assert (await client.post(f"/v1/runs/{uuid.uuid4()}/label", json={"outcome": "PASS"}, headers=headers)).status_code == 404
    assert (await client.post(url, json={"outcome": "PASS"})).status_code == 401


async def test_run_detail_has_the_full_text_and_is_private_to_the_project(client, headers, session):
    job = await make_job(client, headers, "LATE_LABEL", {})
    body = run(job, prompt="P" * 500, output="O" * 500)
    got = await send(client, headers, body)
    assert len(got["prompt"]) == 500 and len(got["output"]) == 500 and len(got["prompt_preview"]) == 200
    other_key = generate_key()
    other = (await session.execute(select(Project).where(Project.project_id == "other"))).scalar_one()
    other.api_key_hash = hash_key(other_key)
    await session.commit()
    assert (await client.get(f"/v1/runs/{body['run_id']}", headers={"X-API-Key": other_key})).status_code == 404
    assert (await client.get(f"/v1/runs/{uuid.uuid4()}", headers=headers)).status_code == 404
