"""Model catalog: which models exist, what they cost, and when they are retired.

The catalog is refreshed daily from a public price list (LiteLLM's model_prices_and_context_window.json)
and can be corrected by hand. A model is:

  ACTIVE      no shutdown date announced
  DEPRECATED  a shutdown date is announced and still in the future (it can still be recommended, with a warning)
  RETIRED     the shutdown date has passed (never recommended)

The catalog has one row per model name. The same open-weight model is often sold by several providers
at different prices, so each provider's own price is also kept (model_prices); a run that says which
provider served it is priced from there.

A row marked source MANUAL is an override: the daily sync never changes it, so a hand-entered price, a
shutdown date the list lags on, or a local model at $0 always wins. `clear_override` hands a row back
to the sync.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from datetime import UTC, date, datetime
from decimal import Decimal
from typing import Any

import httpx
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..config import get_settings
from ..models import CatalogEntry, ProviderPrice
from ..versions import normalize

log = logging.getLogger("agent_memory.catalog")

MILLION = Decimal(1_000_000)
FOUR_PLACES = Decimal("0.0001")
CHAT_MODES = {None, "chat", "completion", "responses"}


@dataclass(frozen=True)
class CatalogRecord:
    model: str
    model_version: str
    provider: str
    price_in_per_mtok: Decimal | None
    price_out_per_mtok: Decimal | None
    shutdown_date: date | None
    status: str


@dataclass
class SyncResult:
    added: int = 0
    updated: int = 0
    unchanged: int = 0
    skipped_manual: int = 0
    status_changes: list[tuple[str, str, str]] = field(default_factory=list)  # (model, old, new)
    # New (model, provider) pairs, each with that provider's price: candidates for re-tests.
    added_models: list[CatalogRecord] = field(default_factory=list)


def _per_mtok(per_token: Any) -> Decimal | None:
    if per_token is None or isinstance(per_token, bool):
        return None
    try:
        return (Decimal(str(per_token)) * MILLION).quantize(FOUR_PLACES)
    except ArithmeticError:
        return None


def _parse_date(value: Any) -> date | None:
    if not isinstance(value, str):
        return None
    try:
        return datetime.strptime(value.strip(), "%Y-%m-%d").date()
    except ValueError:
        return None


def status_for(shutdown: date | None, today: date) -> str:
    if shutdown is None:
        return "ACTIVE"
    return "RETIRED" if shutdown <= today else "DEPRECATED"


def _priced_entries(data: dict[str, Any], today: date):
    """Every priced chat model in the list, plain names before provider-prefixed duplicates."""
    for key in sorted(data, key=lambda k: ("/" in k, k)):
        spec = data[key]
        if key == "sample_spec" or not isinstance(spec, dict) or spec.get("mode") not in CHAT_MODES:
            continue
        price_in, price_out = _per_mtok(spec.get("input_cost_per_token")), _per_mtok(spec.get("output_cost_per_token"))
        if price_in is None and price_out is None:
            continue
        name = normalize(key)
        shutdown = _parse_date(spec.get("deprecation_date"))
        yield CatalogRecord(
            model=name, model_version=name, provider=str(spec.get("litellm_provider") or "unknown").lower(),
            price_in_per_mtok=price_in, price_out_per_mtok=price_out, shutdown_date=shutdown,
            status=status_for(shutdown, today),
        )


def parse_price_list(data: dict[str, Any], today: date | None = None) -> list[CatalogRecord]:
    """Turn the public price list into catalog records, one per model name; a plain name beats a
    provider-prefixed duplicate."""
    records: dict[str, CatalogRecord] = {}
    for rec in _priced_entries(data, today or datetime.now(UTC).date()):
        records.setdefault(rec.model, rec)
    return list(records.values())


def parse_provider_prices(data: dict[str, Any], today: date | None = None) -> list[CatalogRecord]:
    """One record per (model, provider): what each provider charges for the model."""
    records: dict[tuple[str, str], CatalogRecord] = {}
    for rec in _priced_entries(data, today or datetime.now(UTC).date()):
        records.setdefault((rec.model, rec.provider), rec)
    return list(records.values())


async def fetch_price_list(
    url: str | None = None, *, transport: httpx.AsyncBaseTransport | None = None, timeout: float = 30.0
) -> dict[str, Any]:
    url = url or get_settings().catalog_source_url
    async with httpx.AsyncClient(transport=transport, timeout=timeout, follow_redirects=True) as client:
        response = await client.get(url)
        response.raise_for_status()
        return response.json()


async def sync_catalog(session: AsyncSession, data: dict[str, Any], *, today: date | None = None) -> SyncResult:
    """Apply a price list to the catalog. Idempotent; manual rows are left alone."""
    today = today or datetime.now(UTC).date()
    records = parse_price_list(data, today)
    existing = {(e.model, e.model_version): e for e in (await session.execute(select(CatalogEntry))).scalars()}
    result = SyncResult()
    new_names: set[str] = set()
    for rec in records:
        row = existing.get((rec.model, rec.model_version))
        if row is None:
            session.add(CatalogEntry(
                model=rec.model, model_version=rec.model_version, provider=rec.provider, status=rec.status,
                shutdown_date=rec.shutdown_date, price_in_per_mtok=rec.price_in_per_mtok,
                price_out_per_mtok=rec.price_out_per_mtok, source="SYNC",
            ))
            result.added += 1
            new_names.add(rec.model)
            continue
        if row.source == "MANUAL":
            result.skipped_manual += 1
            continue
        new = (rec.provider, rec.status, rec.shutdown_date, rec.price_in_per_mtok, rec.price_out_per_mtok)
        old = (row.provider, row.status, row.shutdown_date, row.price_in_per_mtok, row.price_out_per_mtok)
        if new == old:
            result.unchanged += 1
            continue
        if row.status != rec.status:
            result.status_changes.append((rec.model, row.status, rec.status))
        row.provider, row.status, row.shutdown_date = rec.provider, rec.status, rec.shutdown_date
        row.price_in_per_mtok, row.price_out_per_mtok = rec.price_in_per_mtok, rec.price_out_per_mtok
        result.updated += 1
    await _sync_provider_prices(session, data, today, result, new_names, backfill=bool(existing))
    await session.commit()
    log.info("catalog sync: %d added, %d updated, %d unchanged, %d manual", result.added, result.updated,
             result.unchanged, result.skipped_manual)
    return result


async def _sync_provider_prices(
    session: AsyncSession, data: dict[str, Any], today: date, result: SyncResult, new_names: set[str], *,
    backfill: bool,
) -> None:
    """Upsert each provider's price. A pair is reported as new only when it really is: the first fill of
    an existing catalog (after migration 0010) reports just the models new to the catalog, so it does not
    start a re-test for every model already known."""
    prices = {(p.model, p.provider): p for p in (await session.execute(select(ProviderPrice))).scalars()}
    first_fill = backfill and not prices
    for rec in parse_provider_prices(data, today):
        row = prices.get((rec.model, rec.provider))
        if row is None:
            session.add(ProviderPrice(model=rec.model, provider=rec.provider, price_in_per_mtok=rec.price_in_per_mtok,
                                      price_out_per_mtok=rec.price_out_per_mtok, shutdown_date=rec.shutdown_date))
            if not first_fill or rec.model in new_names:
                result.added_models.append(rec)
            continue
        if (row.price_in_per_mtok, row.price_out_per_mtok) != (rec.price_in_per_mtok, rec.price_out_per_mtok):
            row.price_in_per_mtok, row.price_out_per_mtok = rec.price_in_per_mtok, rec.price_out_per_mtok
        if row.shutdown_date != rec.shutdown_date:
            # A provider announcing (or moving) its own shutdown date is a status change the alerts
            # check, even when the catalog row's provider has not changed anything.
            old, new = status_for(row.shutdown_date, today), status_for(rec.shutdown_date, today)
            row.shutdown_date = rec.shutdown_date
            if old != new and (rec.model, old, new) not in result.status_changes:
                result.status_changes.append((rec.model, old, new))


async def set_override(
    session: AsyncSession,
    model: str,
    model_version: str | None = None,
    *,
    provider: str | None = None,
    status: str | None = None,
    shutdown_date: date | None = None,
    price_in_per_mtok: Decimal | float | str | None = None,
    price_out_per_mtok: Decimal | float | str | None = None,
) -> CatalogEntry:
    """Create or correct a catalog row by hand. The row becomes MANUAL, so the sync never changes it."""
    name = normalize(model)
    version = normalize(model_version or model)
    row = (
        await session.execute(select(CatalogEntry).where(CatalogEntry.model == name, CatalogEntry.model_version == version))
    ).scalar_one_or_none()
    if row is None:
        row = CatalogEntry(model=name, model_version=version, provider=(provider or "manual").lower(), status="ACTIVE")
        session.add(row)
    if provider:
        row.provider = provider.lower()
    if price_in_per_mtok is not None:
        row.price_in_per_mtok = Decimal(str(price_in_per_mtok)).quantize(FOUR_PLACES)
    if price_out_per_mtok is not None:
        row.price_out_per_mtok = Decimal(str(price_out_per_mtok)).quantize(FOUR_PLACES)
    if shutdown_date is not None:
        row.shutdown_date = shutdown_date
        row.status = status or status_for(shutdown_date, datetime.now(UTC).date())
    if status:
        if status not in ("ACTIVE", "DEPRECATED", "RETIRED"):
            raise ValueError("status must be ACTIVE, DEPRECATED or RETIRED")
        row.status = status
    row.source = "MANUAL"
    await session.commit()
    return row


async def clear_override(session: AsyncSession, model: str, model_version: str | None = None) -> bool:
    """Hand a manual row back to the daily sync. Returns False when there was no such manual row."""
    row = (
        await session.execute(
            select(CatalogEntry).where(
                CatalogEntry.model == normalize(model), CatalogEntry.model_version == normalize(model_version or model),
                CatalogEntry.source == "MANUAL",
            )
        )
    ).scalar_one_or_none()
    if row is None:
        return False
    row.source = "SYNC"
    await session.commit()
    return True
