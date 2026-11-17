"""The read endpoints, against a real (embedded) Postgres."""

import uuid
from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import select

from agent_memory.models import Job, Project, Run
from agent_memory.security import generate_key, hash_key

T0 = datetime(2026, 10, 1, 12, 0, tzinfo=UTC)


@pytest.fixture
async def seeded(session):
    """Two projects; 'demo' has two jobs and five runs, 'other' has one run."""
    keys = {"demo": generate_key(), "other": generate_key()}
    for pid, key in keys.items():
        session.add(Project(project_id=pid, api_key_hash=hash_key(key)))
    await session.flush()
    jobs = {}
    for pid, name in [("demo", "invoice-extract"), ("demo", "ticket-classify"), ("other", "secret-job")]:
        job = Job(project_id=pid, name=name, check_kind="ANSWER_KEY", check_config={"fields": ["total"]},
                  description=f"{name} job")
        session.add(job)
        await session.flush()
        jobs[name] = job

    def add(job, i, model="small", outcome="PASS", state="CHECKED", pid="demo"):
        session.add(Run(
            run_id=uuid.UUID(int=i), job_id=jobs[job].job_id, project_id=pid, prompt="P" * 300,
            prompt_hash="h", model=model, model_version="v1", outcome=outcome, state=state,
            output="O" * 300, created_at=T0 + timedelta(minutes=i), cost_usd=0.002,
        ))

    for i in range(1, 4):
        add("invoice-extract", i)
    add("invoice-extract", 4, model="big", outcome="FAIL", state="INDEXED")
    add("ticket-classify", 5, model="big")
    add("secret-job", 6, pid="other")
    await session.commit()
    return keys


def auth(key):
    return {"X-API-Key": key}


async def test_health_needs_no_key(client):
    r = await client.get("/healthz")
    assert r.status_code == 200 and r.json() == {"status": "ok"}


async def test_v1_routes_reject_missing_and_wrong_keys(client, seeded):
    assert (await client.get("/v1/jobs")).status_code == 401
    assert (await client.get("/v1/runs", headers=auth("mcm_live_wrong"))).status_code == 401


async def test_both_header_styles_work(client, seeded):
    key = seeded["demo"]
    assert (await client.get("/v1/jobs", headers=auth(key))).status_code == 200
    assert (await client.get("/v1/jobs", headers={"Authorization": f"Bearer {key}"})).status_code == 200


async def test_jobs_show_only_my_project_with_counts(client, seeded):
    jobs = (await client.get("/v1/jobs", headers=auth(seeded["demo"]))).json()
    assert [j["name"] for j in jobs] == ["invoice-extract", "ticket-classify"]
    invoice = jobs[0]
    assert invoice["run_count"] == 4
    assert invoice["runs_by_state"] == {"CHECKED": 3, "INDEXED": 1}
    assert invoice["description"] == "invoice-extract job"


async def test_runs_are_newest_first_and_previews_are_short(client, seeded):
    page = (await client.get("/v1/runs", headers=auth(seeded["demo"]))).json()
    assert [r["run_id"][-1] for r in page["items"]] == ["5", "4", "3", "2", "1"]
    assert page["next_cursor"] is None
    first = page["items"][0]
    assert first["prompt_preview"] == "P" * 240 + "…" and first["output_preview"] == "O" * 240 + "…"
    assert first["job"] == "ticket-classify" and first["cost_usd"] == 0.002


async def test_paging_covers_every_run_once(client, seeded):
    key, seen, cursor = seeded["demo"], [], None
    while True:
        params = {"limit": 2, **({"cursor": cursor} if cursor else {})}
        page = (await client.get("/v1/runs", headers=auth(key), params=params)).json()
        seen += [r["run_id"] for r in page["items"]]
        cursor = page["next_cursor"]
        if cursor is None:
            break
    assert len(seen) == 5 and len(set(seen)) == 5


async def test_filters_and_project_isolation(client, seeded):
    key = seeded["demo"]
    by_job = (await client.get("/v1/runs", headers=auth(key), params={"job": "invoice-extract"})).json()
    assert len(by_job["items"]) == 4
    big = (await client.get("/v1/runs", headers=auth(key), params={"model": "big"})).json()
    assert len(big["items"]) == 2
    failed = (await client.get("/v1/runs", headers=auth(key), params={"outcome": "FAIL"})).json()
    assert len(failed["items"]) == 1
    names = {r["job"] for r in (await client.get("/v1/runs", headers=auth(key))).json()["items"]}
    assert "secret-job" not in names


async def test_bad_input_is_a_422(client, seeded):
    key = seeded["demo"]
    assert (await client.get("/v1/runs", headers=auth(key), params={"cursor": "not-a-cursor"})).status_code == 422
    assert (await client.get("/v1/runs", headers=auth(key), params={"limit": 0})).status_code == 422
    assert (await client.get("/v1/runs", headers=auth(key), params={"outcome": "MAYBE"})).status_code == 422


async def test_each_run_shows_its_importance_and_its_weight_in_the_recommendation_now(client, seeded, session):
    # The weight is e^(-age/S): a month-old run on the current version counts e^-1 at the default 30 days.
    runs = (await client.get("/v1/runs?job=invoice-extract", headers=auth(seeded["demo"]))).json()["items"]
    assert {r["importance_score"] for r in runs} == {1.0}
    assert all(0 < r["weight"] < 1 for r in runs)
    detail = (await client.get(f"/v1/runs/{runs[0]['run_id']}", headers=auth(seeded["demo"]))).json()
    assert detail["weight"] == pytest.approx(runs[0]["weight"], rel=1e-3)
    # A run on a version that has since been replaced fades four times faster.
    job = (await session.execute(select(Job).where(Job.name == "invoice-extract"))).scalar_one()
    for n, version, minutes in ((97, "small-2026-01-01", 1), (98, "small-2026-09-01", 2)):
        session.add(Run(run_id=uuid.UUID(int=n), job_id=job.job_id, project_id="demo", prompt="p", prompt_hash="h",
                        model="small", model_version=version, outcome="PASS", state="CHECKED", run_kind="PRODUCTION",
                        created_at=T0 + timedelta(minutes=minutes)))
    await session.commit()
    weights = {r["run_id"]: r["weight"] for r in
               (await client.get("/v1/runs?job=invoice-extract", headers=auth(seeded["demo"]))).json()["items"]}
    old, new = weights[str(uuid.UUID(int=97))], weights[str(uuid.UUID(int=98))]
    assert old == pytest.approx(new ** 4, rel=1e-2)


async def test_run_previews_collapse_whitespace_and_cut_at_240(client, seeded, session):
    key = seeded["demo"]
    job = (await session.execute(select(Job).where(Job.name == "ticket-classify"))).scalar_one()

    def add(i, prompt, output, removed=None):
        session.add(Run(
            run_id=uuid.UUID(int=i), job_id=job.job_id, project_id="demo", prompt=prompt, prompt_hash="h",
            model="m", model_version="v1", outcome="PASS", state="CHECKED", output=output,
            created_at=T0 + timedelta(minutes=i), content_removed_at=removed,
        ))

    add(100, "hello\n\n  world\tagain", "short")
    add(101, "x " * 400, "y" * 240)
    add(102, None, None, removed=T0)
    await session.commit()
    items = {str(int(r["run_id"].replace("-", ""), 16)): r for r in (await client.get("/v1/runs", headers=auth(key))).json()["items"]}
    short, long_, gone = items["100"], items["101"], items["102"]
    assert short["prompt_preview"] == "hello world again" and short["output_preview"] == "short"
    assert len(long_["prompt_preview"]) in (240, 241) and long_["prompt_preview"].endswith("…")
    assert long_["output_preview"] == "y" * 240  # exactly 240: not cut
    assert gone["prompt_preview"] is None and gone["output_preview"] is None


async def test_patch_job_description(client, seeded, session):
    key = seeded["demo"]
    r = await client.patch("/v1/jobs/invoice-extract", headers=auth(key), json={"description": "  Reads invoices  "})
    assert r.status_code == 200
    body = r.json()
    assert body["description"] == "Reads invoices" and body["name"] == "invoice-extract"
    assert body["check_kind"] == "ANSWER_KEY" and body["check_config"] == {"fields": ["total"]}
    assert body["run_count"] == 4
    for clear in ("", None, "   "):
        r = await client.patch("/v1/jobs/invoice-extract", headers=auth(key), json={"description": clear})
        assert r.status_code == 200 and r.json()["description"] is None
    stored = (await session.execute(select(Job).where(Job.name == "invoice-extract"))).scalar_one()
    await session.refresh(stored)
    assert stored.description is None and stored.name == "invoice-extract"


async def test_patch_job_rejects_too_long_unknown_and_other_projects(client, seeded, session):
    key = seeded["demo"]
    too_long = await client.patch("/v1/jobs/invoice-extract", headers=auth(key), json={"description": "x" * 501})
    assert too_long.status_code == 422
    assert (await client.patch("/v1/jobs/nope", headers=auth(key), json={"description": "a"})).status_code == 404
    assert (await client.patch("/v1/jobs/secret-job", headers=auth(key), json={"description": "hacked"})).status_code == 404
    other = (await session.execute(select(Job).where(Job.name == "secret-job"))).scalar_one()
    await session.refresh(other)
    assert other.description == "secret-job job"
    assert (await client.patch("/v1/jobs/invoice-extract", json={"description": "a"})).status_code == 401
