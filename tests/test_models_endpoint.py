"""GET /v1/models and catalog-based cost at ingest. Model names are made up."""

import uuid
from datetime import date
from decimal import Decimal

import pytest
from sqlalchemy import select

from agent_memory.models import CatalogEntry, Job, Project, Run
from agent_memory.security import generate_key, hash_key


@pytest.fixture
async def headers(session):
    key = generate_key()
    session.add(Project(project_id="demo", api_key_hash=hash_key(key)))
    await session.flush()
    session.add(Job(project_id="demo", name="j", check_kind="LATE_LABEL", check_config={}))
    for name, status, shutdown, price in [
        ("acme-large-2026-06-01", "ACTIVE", None, (3, 15)),
        ("acme-old-2025-01-01", "DEPRECATED", date(2026, 12, 1), (10, 30)),
        ("acme-gone", "RETIRED", date(2026, 1, 1), (10, 30)),
        ("zeta-small", "ACTIVE", None, (0.25, 1.25)),
    ]:
        session.add(CatalogEntry(model=name, model_version=name, provider="acme", status=status, shutdown_date=shutdown,
                                 price_in_per_mtok=Decimal(str(price[0])), price_out_per_mtok=Decimal(str(price[1]))))
    await session.commit()
    return {"X-API-Key": key}


async def test_the_catalog_needs_a_key_and_lists_models_in_name_order(client, headers):
    assert (await client.get("/v1/models")).status_code == 401
    page = (await client.get("/v1/models", headers=headers)).json()
    assert [m["model"] for m in page["items"]] == ["acme-gone", "acme-large-2026-06-01", "acme-old-2025-01-01", "zeta-small"]
    assert page["next_cursor"] is None
    large = page["items"][1]
    assert large["price_in_per_mtok"] == 3.0 and large["price_out_per_mtok"] == 15.0 and large["status"] == "ACTIVE"


async def test_a_deprecated_model_shows_its_shutdown_date(client, headers):
    page = (await client.get("/v1/models", headers=headers, params={"status": "DEPRECATED"})).json()
    assert [(m["model"], m["shutdown_date"]) for m in page["items"]] == [("acme-old-2025-01-01", "2026-12-01")]


async def test_filters_by_status_and_name(client, headers):
    retired = (await client.get("/v1/models", headers=headers, params={"status": "RETIRED"})).json()["items"]
    assert [m["model"] for m in retired] == ["acme-gone"]
    named = (await client.get("/v1/models", headers=headers, params={"q": "ACME-L"})).json()["items"]
    assert [m["model"] for m in named] == ["acme-large-2026-06-01"]
    assert (await client.get("/v1/models", headers=headers, params={"status": "BROKEN"})).status_code == 422


async def test_paging_walks_the_whole_catalog_once(client, headers):
    seen, cursor = [], None
    while True:
        params = {"limit": 2, **({"cursor": cursor} if cursor else {})}
        page = (await client.get("/v1/models", headers=headers, params=params)).json()
        seen += [m["model"] for m in page["items"]]
        cursor = page["next_cursor"]
        if cursor is None:
            break
    assert seen == ["acme-gone", "acme-large-2026-06-01", "acme-old-2025-01-01", "zeta-small"]
    assert (await client.get("/v1/models", headers=headers, params={"cursor": "bad"})).status_code == 422


async def test_models_the_project_has_used_are_flagged_and_can_be_filtered(client, headers, session):
    job = (await session.execute(select(Job))).scalar_one()
    session.add(Run(run_id=uuid.uuid4(), job_id=job.job_id, project_id="demo", prompt="p", prompt_hash="h",
                    model="acme-large", model_version="Acme/ACME-LARGE-2026-06-01"))
    await session.commit()
    everything = (await client.get("/v1/models", headers=headers)).json()["items"]
    assert {m["model"]: m["used_by_project"] for m in everything}["acme-large-2026-06-01"] is True
    assert sum(m["used_by_project"] for m in everything) == 1
    only_used = (await client.get("/v1/models", headers=headers, params={"used": "true"})).json()["items"]
    assert [m["model"] for m in only_used] == ["acme-large-2026-06-01"]


async def test_a_project_that_used_nothing_gets_an_empty_used_list(client, headers):
    assert (await client.get("/v1/models", headers=headers, params={"used": "true"})).json()["items"] == []


async def make_job(client, headers):
    job = {"name": "j2", "check_kind": "LATE_LABEL", "check_config": {}}
    assert (await client.post("/v1/jobs", json=job, headers=headers)).status_code == 201


async def post_run(client, headers, **over):
    body = {"run_id": str(uuid.uuid4()), "job": "j2", "prompt": "p", "tokens_in": 1000, "tokens_out": 100, **over}
    assert (await client.post("/v1/runs", json=body, headers=headers)).status_code == 202


async def test_cost_is_priced_from_the_resolved_version_even_when_the_alias_is_unknown(client, headers, session):
    await make_job(client, headers)
    await post_run(client, headers, model="acme-large", model_version="Acme/acme-large-2026-06-01")
    cost = (await session.execute(select(Run.cost_usd).where(Run.job_id != uuid.uuid4()))).scalar_one()
    assert cost == Decimal("0.004500")  # (1000 x 3 + 100 x 15) per million


async def test_cost_falls_back_to_the_requested_alias_then_to_the_senders_figure(client, headers, session):
    await make_job(client, headers)
    await post_run(client, headers, model="zeta-small", model_version="some-unlisted-build")  # alias is in the catalog
    await post_run(client, headers, model="unlisted", model_version="unlisted-1", cost_usd=0.5)  # nothing to price it by
    costs = sorted((await session.execute(select(Run.cost_usd))).scalars().all())
    assert costs == [Decimal("0.000375"), Decimal("0.500000")]
