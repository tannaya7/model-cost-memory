"""The daily series behind the web app's quality and spend charts."""

import uuid
from datetime import UTC, datetime, timedelta
from decimal import Decimal

from agent_memory.models import Job, Project, Run
from agent_memory.security import generate_key, hash_key


async def _world(session):
    key = generate_key()
    session.add(Project(project_id="acme", api_key_hash=hash_key(key)))
    session.add(Project(project_id="other", api_key_hash=hash_key(generate_key())))
    await session.flush()
    invoice = Job(project_id="acme", name="invoice", check_kind="LATE_LABEL", check_config={})
    ticket = Job(project_id="acme", name="ticket", check_kind="LATE_LABEL", check_config={})
    elsewhere = Job(project_id="other", name="invoice", check_kind="LATE_LABEL", check_config={})
    session.add_all([invoice, ticket, elsewhere])
    await session.flush()
    today = datetime.now(UTC).replace(hour=12, minute=0, second=0, microsecond=0)

    def run(job, model, outcome, days_ago, cost="0.01", kind="PRODUCTION"):
        return Run(run_id=uuid.uuid4(), job_id=job.job_id, project_id=job.project_id, prompt="p", prompt_hash="h",
                   model=model, model_version=f"{model}-1", outcome=outcome, run_kind=kind,
                   cost_usd=Decimal(cost) if cost else None, created_at=today - timedelta(days=days_ago))

    session.add_all([
        run(invoice, "mini", "PASS", 1), run(invoice, "mini", "FAIL", 1), run(invoice, "mini", "UNKNOWN", 1, cost=None),
        run(invoice, "big", "PASS", 1, cost="0.10"), run(invoice, "mini", "PASS", 0),
        run(ticket, "mini", "PASS", 0),
        run(invoice, "mini", "PASS", 0, kind="RETEST"),  # re-tests are not production
        run(invoice, "mini", "PASS", 90),  # outside the window
        run(elsewhere, "mini", "PASS", 0),  # another project
    ])
    await session.commit()
    return {"X-API-Key": key}, today


async def test_runs_outcomes_and_spend_per_day_job_and_model(client, session):
    headers, today = await _world(session)
    rows = (await client.get("/v1/insights/daily", headers=headers)).json()
    yesterday = (today - timedelta(days=1)).date().isoformat()
    first = rows[0]
    assert (first["day"], first["job"], first["model"]) == (yesterday, "invoice", "big")
    mini = next(r for r in rows if r["day"] == yesterday and r["model"] == "mini")
    assert (mini["runs"], mini["passed"], mini["failed"]) == (3, 1, 1)  # the UNKNOWN run is in neither
    assert mini["spend_usd"] == 0.02  # the unpriced run adds nothing
    assert [r["day"] for r in rows] == sorted(r["day"] for r in rows)  # oldest first
    assert sum(r["runs"] for r in rows) == 6  # no re-test, no old run, no other project


async def test_one_job_only(client, session):
    headers, _ = await _world(session)
    rows = (await client.get("/v1/insights/daily", headers=headers, params={"job": "ticket"})).json()
    assert [(r["job"], r["runs"]) for r in rows] == [("ticket", 1)]
    assert (await client.get("/v1/insights/daily", headers=headers, params={"job": "nope"})).status_code == 404
