"""GET /v1/jobs/{job}/recommendation and GET /v1/insights/spend against a real Postgres.
Model names and prices are made up."""

import uuid
from datetime import UTC, datetime, timedelta

import pytest

from agent_memory.models import CatalogEntry, Job, Project, Run
from agent_memory.security import generate_key, hash_key

NOW = datetime.now(UTC)


@pytest.fixture
async def world(session):
    keys = {"demo": generate_key(), "other": generate_key()}
    for pid, key in keys.items():
        session.add(Project(project_id=pid, api_key_hash=hash_key(key)))
    session.add_all([
        CatalogEntry(model="big-2026-09", model_version="big-2026-09", provider="acme", status="ACTIVE"),
        CatalogEntry(model="mini", model_version="mini", provider="acme", status="ACTIVE"),
    ])
    await session.flush()
    jobs = {}
    for pid, name in [("demo", "invoice"), ("demo", "ticket"), ("other", "invoice")]:
        job = Job(project_id=pid, name=name, check_kind="ANSWER_KEY", check_config={"fields": ["total"]})
        session.add(job)
        await session.flush()
        jobs[(pid, name)] = job

    def add(n, *, model="big", version="big-2026-09", fail_every=0, cost=0.03, kind="PRODUCTION", age_days=1.0,
            job="invoice", pid="demo", outcome=None, state="INDEXED"):
        for i in range(n):
            failed = fail_every and i % fail_every == 0
            session.add(Run(
                run_id=uuid.uuid4(), job_id=jobs[(pid, job)].job_id, project_id=pid, prompt="p", prompt_hash="h",
                model=model, model_version=version, outcome=outcome or ("FAIL" if failed else "PASS"),
                outcome_reason="total: expected 100.0, got 99.0" if failed else "all 1 fields match",
                cost_usd=cost, run_kind=kind, state=state,
                created_at=NOW - timedelta(days=age_days, minutes=i),
            ))

    async def commit():
        await session.commit()

    return keys, add, commit


def auth(key):
    return {"X-API-Key": key}


async def get_rec(client, key, job="invoice"):
    response = await client.get(f"/v1/jobs/{job}/recommendation", headers=auth(key))
    assert response.status_code == 200, response.text
    return response.json()


async def test_a_cheaper_model_proven_by_re_tests_is_a_downgrade_with_its_receipt(client, world):
    keys, add, commit = world
    add(400, fail_every=100)  # production on 'big': 99% pass
    add(400, model="mini", version="mini", cost=0.001, kind="RETEST", fail_every=100)  # re-tested: also 99%
    await commit()
    body = await get_rec(client, keys["demo"])
    assert body["verdict"] == "DOWNGRADE"
    assert body["current"] == {"model": "big", "model_version": "big-2026-09"}
    assert body["recommended"] == {"model": "mini", "model_version": "mini"}
    assert body["rules"] == {"confidence": 0.95, "margin": 0.03, "evidence_floor": 25.0}
    mini = next(m for m in body["models"] if m["model"] == "mini")
    assert (mini["status"], mini["eligible"], mini["n_runs"], mini["failures"]) == ("GOOD_ENOUGH", True, 400, 4)
    assert mini["pass_rate_low"] < mini["weighted_pass_rate"] < mini["pass_rate_high"]
    assert mini["cost_per_success_usd"] == pytest.approx(0.001 / mini["weighted_pass_rate"])
    receipt = body["evidence"]["failing_runs"]
    assert len(receipt) == 5 and {r["model"] for r in receipt} <= {"big", "mini"}
    assert receipt[0]["outcome_reason"] == "total: expected 100.0, got 99.0"
    assert body["evidence"]["n_runs"] == 800


async def test_too_little_evidence_is_refused_with_progress(client, world):
    keys, add, commit = world
    add(10)
    await commit()
    body = await get_rec(client, keys["demo"])
    assert body["verdict"] == "INSUFFICIENT_EVIDENCE"
    assert body["recommended"] is None
    assert 0.3 < body["progress"] < 0.45  # about 10 of the 25 needed (a day's decay shaves a little)
    assert body["next_step"]


async def test_unchecked_archived_and_other_projects_runs_do_not_count(client, world):
    keys, add, commit = world
    add(30)
    add(50, outcome="UNKNOWN")  # waiting for a label
    add(50, state="ARCHIVED")
    add(50, pid="other")
    await commit()
    body = await get_rec(client, keys["demo"])
    assert body["evidence"]["n_runs"] == 30


async def test_evidence_about_a_superseded_version_fades_faster(client, world):
    keys, add, commit = world
    add(60, version="big-2026-08", fail_every=2, age_days=40)  # old version, half failed
    add(60, version="big-2026-09", age_days=1)  # current version, all pass
    await commit()
    big = (await get_rec(client, keys["demo"]))["models"][0]
    # Unweighted it is 75%. Superseded runs fade 4x faster (S = 7.5 days), so at 40 days the old version's
    # runs weigh ~0.005 each against ~0.97 for the current version's.
    assert big["weighted_pass_rate"] > 0.98
    assert big["model_version"] == "big-2026-09"


async def test_the_current_model_is_shown_even_before_any_of_its_runs_is_checked(client, world):
    keys, add, commit = world
    add(400, model="mini", version="mini", cost=0.001, kind="RETEST")
    add(20, model="big", version="big-2026-09", outcome="UNKNOWN")
    await commit()
    body = await get_rec(client, keys["demo"])
    assert body["current"]["model"] == "big"
    assert next(m for m in body["models"] if m["model"] == "big")["status"] == "BELOW_FLOOR"


async def test_unknown_job_is_404_and_another_projects_job_is_invisible(client, world):
    keys, add, commit = world
    add(30, pid="other")
    await commit()
    assert (await client.get("/v1/jobs/nope/recommendation", headers=auth(keys["demo"]))).status_code == 404
    other = await get_rec(client, keys["demo"])  # 'invoice' exists in both projects
    assert other["evidence"]["n_runs"] == 0
    assert (await client.get("/v1/jobs/invoice/recommendation")).status_code == 401


async def test_spend_by_job_counts_production_in_the_window_most_expensive_first(client, world):
    keys, add, commit = world
    add(10, cost=0.03)  # invoice: $0.30
    add(10, job="ticket", cost=0.01)  # ticket: $0.10
    add(10, cost=0.03, kind="RETEST")  # re-tests are not production spend
    add(10, cost=0.03, age_days=45)  # outside the 30-day window
    add(10, pid="other", cost=1.0)
    await commit()
    response = await client.get("/v1/insights/spend", headers=auth(keys["demo"]))
    assert response.status_code == 200
    assert response.json() == [
        {"job": "invoice", "runs": 10, "spend_usd": pytest.approx(0.30), "share": pytest.approx(0.75), "unpriced_runs": 0},
        {"job": "ticket", "runs": 10, "spend_usd": pytest.approx(0.10), "share": pytest.approx(0.25), "unpriced_runs": 0},
    ]
    wider = (await client.get("/v1/insights/spend?days=60", headers=auth(keys["demo"]))).json()
    assert wider[0] == {"job": "invoice", "runs": 20, "spend_usd": pytest.approx(0.60), "share": pytest.approx(6 / 7),
                        "unpriced_runs": 0}
    assert (await client.get("/v1/insights/spend?days=0", headers=auth(keys["demo"]))).status_code == 422


async def test_weights_do_not_depend_on_the_outcome_so_the_rate_is_unbiased(client, world):
    keys, add, commit = world
    add(300, fail_every=4, age_days=10)  # 75% pass, all ten days old
    await commit()
    big = (await get_rec(client, keys["demo"]))["models"][0]
    assert big["weighted_pass_rate"] == pytest.approx(0.75, abs=0.005)  # failures are not remembered longer
