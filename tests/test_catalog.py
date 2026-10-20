"""Catalog sync and overrides. The price list here is made up."""

from datetime import date
from decimal import Decimal

import httpx
import pytest
from sqlalchemy import select

from agent_memory.catalog.sync import (
    clear_override,
    fetch_price_list,
    parse_price_list,
    set_override,
    status_for,
    sync_catalog,
)
from agent_memory.models import CatalogEntry

TODAY = date(2026, 10, 14)


def price_list(**over):
    data = {
        "sample_spec": {"input_cost_per_token": 0, "mode": "chat"},
        "acme-large-2026-06-01": {"litellm_provider": "Acme", "mode": "chat",
                                  "input_cost_per_token": 3e-06, "output_cost_per_token": 1.5e-05},
        "acme/acme-large-2026-06-01": {"litellm_provider": "acme-via-proxy", "mode": "chat",
                                       "input_cost_per_token": 9e-06, "output_cost_per_token": 9e-05},
        "acme-small": {"litellm_provider": "acme", "mode": "chat",
                       "input_cost_per_token": 2.5e-07, "output_cost_per_token": 1.25e-06},
        "acme-old-2025-01-01": {"litellm_provider": "acme", "mode": "chat", "deprecation_date": "2026-12-01",
                                "input_cost_per_token": 1e-05, "output_cost_per_token": 3e-05},
        "acme-gone": {"litellm_provider": "acme", "mode": "chat", "deprecation_date": "2026-01-01",
                      "input_cost_per_token": 1e-05, "output_cost_per_token": 3e-05},
        "acme-embed": {"litellm_provider": "acme", "mode": "embedding", "input_cost_per_token": 1e-07},
        "acme-unpriced": {"litellm_provider": "acme", "mode": "chat"},
        "not-a-dict": "oops",
    }
    data.update(over)
    return data


def by_model(records):
    return {r.model: r for r in records}


def test_prices_are_converted_from_per_token_to_per_million():
    rec = by_model(parse_price_list(price_list(), TODAY))
    assert rec["acme-large-2026-06-01"].price_in_per_mtok == Decimal("3.0000")
    assert rec["acme-large-2026-06-01"].price_out_per_mtok == Decimal("15.0000")
    assert rec["acme-small"].price_in_per_mtok == Decimal("0.2500")
    assert rec["acme-small"].price_out_per_mtok == Decimal("1.2500")


def test_only_priced_chat_models_are_kept():
    names = set(by_model(parse_price_list(price_list(), TODAY)))
    assert names == {"acme-large-2026-06-01", "acme-small", "acme-old-2025-01-01", "acme-gone"}


def test_a_provider_prefixed_duplicate_does_not_override_the_plain_entry():
    rec = by_model(parse_price_list(price_list(), TODAY))["acme-large-2026-06-01"]
    assert rec.provider == "acme" and rec.price_in_per_mtok == Decimal("3.0000")


@pytest.mark.parametrize(
    "shutdown, status",
    [(None, "ACTIVE"), (date(2026, 12, 1), "DEPRECATED"), (date(2026, 10, 14), "RETIRED"), (date(2026, 1, 1), "RETIRED")],
)
def test_status_follows_the_shutdown_date(shutdown, status):
    assert status_for(shutdown, TODAY) == status


def test_statuses_and_shutdown_dates_come_from_the_deprecation_date():
    rec = by_model(parse_price_list(price_list(), TODAY))
    assert rec["acme-small"].status == "ACTIVE" and rec["acme-small"].shutdown_date is None
    assert rec["acme-old-2025-01-01"].status == "DEPRECATED" and rec["acme-old-2025-01-01"].shutdown_date == date(2026, 12, 1)
    assert rec["acme-gone"].status == "RETIRED"


async def test_the_first_sync_adds_everything_and_the_second_changes_nothing(session):
    first = await sync_catalog(session, price_list(), today=TODAY)
    assert (first.added, first.updated) == (4, 0)
    second = await sync_catalog(session, price_list(), today=TODAY)
    assert (second.added, second.updated, second.unchanged) == (0, 0, 4)
    assert len((await session.execute(select(CatalogEntry))).scalars().all()) == 4


async def test_a_price_change_and_a_new_deprecation_are_picked_up_and_reported(session):
    await sync_catalog(session, price_list(), today=TODAY)
    changed = price_list(**{
        "acme-small": {"litellm_provider": "acme", "mode": "chat", "deprecation_date": "2026-11-30",
                       "input_cost_per_token": 5e-07, "output_cost_per_token": 2e-06},
    })
    result = await sync_catalog(session, changed, today=TODAY)
    assert result.updated == 1 and result.status_changes == [("acme-small", "ACTIVE", "DEPRECATED")]
    session.expunge_all()
    row = (await session.execute(select(CatalogEntry).where(CatalogEntry.model == "acme-small"))).scalar_one()
    assert row.status == "DEPRECATED" and row.shutdown_date == date(2026, 11, 30) and row.price_in_per_mtok == Decimal("0.5000")


async def test_time_passing_turns_deprecated_into_retired(session):
    await sync_catalog(session, price_list(), today=TODAY)
    result = await sync_catalog(session, price_list(), today=date(2026, 12, 2))
    assert ("acme-old-2025-01-01", "DEPRECATED", "RETIRED") in result.status_changes


async def test_a_manual_override_survives_the_sync_until_it_is_cleared(session):
    await sync_catalog(session, price_list(), today=TODAY)
    await set_override(session, "acme-small", price_in_per_mtok=0.1, price_out_per_mtok=0.2)
    result = await sync_catalog(session, price_list(), today=TODAY)
    assert result.skipped_manual == 1
    session.expunge_all()
    row = (await session.execute(select(CatalogEntry).where(CatalogEntry.model == "acme-small"))).scalar_one()
    assert row.price_in_per_mtok == Decimal("0.1000") and row.source == "MANUAL"

    assert await clear_override(session, "acme-small") is True
    await sync_catalog(session, price_list(), today=TODAY)
    session.expunge_all()
    row = (await session.execute(select(CatalogEntry).where(CatalogEntry.model == "acme-small"))).scalar_one()
    assert row.price_in_per_mtok == Decimal("0.2500") and row.source == "SYNC"
    assert await clear_override(session, "acme-small") is False


async def test_a_local_model_can_be_added_by_hand_at_zero_cost(session):
    row = await set_override(session, "local-llm:3b", provider="ollama", price_in_per_mtok=0, price_out_per_mtok=0)
    assert (row.provider, row.status, row.source) == ("ollama", "ACTIVE", "MANUAL")
    assert row.price_in_per_mtok == Decimal("0.0000")


async def test_overrides_can_set_a_shutdown_date_the_list_lags_on(session):
    await sync_catalog(session, price_list(), today=TODAY)
    row = await set_override(session, "acme-small", shutdown_date=date(2027, 3, 1))
    assert (row.status, row.shutdown_date) == ("DEPRECATED", date(2027, 3, 1))
    with pytest.raises(ValueError):
        await set_override(session, "acme-small", status="BROKEN")


async def test_the_price_list_is_fetched_over_http():
    seen = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(str(request.url))
        return httpx.Response(200, json=price_list())

    data = await fetch_price_list("https://prices.example/list.json", transport=httpx.MockTransport(handler))
    assert seen == ["https://prices.example/list.json"] and "acme-small" in data
    failing = httpx.MockTransport(lambda r: httpx.Response(503))
    with pytest.raises(httpx.HTTPStatusError):
        await fetch_price_list("https://prices.example/list.json", transport=failing)
