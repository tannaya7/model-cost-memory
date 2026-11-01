"""Is a model still served to this job? Status per provider, not per name.

Providers retire the same model on different dates: Vertex AI retired gemini-2.5-flash on 2026-10-20
while the Gemini API still serves it. The catalog row holds one provider's date, so reading status
from it alone called a model RETIRED for a job that was still using it. Here the status comes from:

    1. a hand-entered (MANUAL) catalog row, which always wins
    2. the provider the job's runs name, from that provider's own date (model_prices)
    3. otherwise the catalog row, except that a model one provider has deprecated or retired while
       others still serve it is DEPRECATED with a note saying so, never RETIRED: without knowing the
       provider, "never recommend it" would be a guess
"""

from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass
from datetime import UTC, date, datetime

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..models import CatalogEntry, ProviderPrice
from .sync import status_for


@dataclass(frozen=True)
class Lifecycle:
    status: str  # ACTIVE, DEPRECATED, RETIRED or UNKNOWN (not in the catalog)
    shutdown_date: date | None = None
    note: str | None = None  # why, when providers disagree


UNKNOWN = Lifecycle("UNKNOWN")


async def lifecycles(
    session: AsyncSession, wanted: dict[str, str | None], *, today: date | None = None
) -> dict[str, Lifecycle]:
    """`wanted` maps catalog names to the provider the job's runs name (None when they do not say)."""
    today = today or datetime.now(UTC).date()
    names = set(wanted) or {""}
    catalog = {
        r.model: r for r in (await session.execute(select(CatalogEntry).where(CatalogEntry.model.in_(names)))).scalars()
    }
    sold: dict[str, dict[str, date | None]] = defaultdict(dict)
    for p in (await session.execute(select(ProviderPrice).where(ProviderPrice.model.in_(names)))).scalars():
        sold[p.model][p.provider] = p.shutdown_date

    out: dict[str, Lifecycle] = {}
    for name, provider in wanted.items():
        row, offers = catalog.get(name), sold.get(name, {})
        if row is not None and row.source == "MANUAL":
            out[name] = Lifecycle(row.status, row.shutdown_date)
        elif provider and provider.lower() in offers:
            shutdown = offers[provider.lower()]
            out[name] = Lifecycle(status_for(shutdown, today), shutdown)
        elif row is None:
            out[name] = UNKNOWN
        elif row.status != "ACTIVE" and (still := sorted(p for p, d in offers.items() if d is None or d > today)):
            verb = "retired it on" if row.status == "RETIRED" else "retires it on"
            out[name] = Lifecycle("DEPRECATED", row.shutdown_date, (
                f"{row.provider} {verb} {row.shutdown_date}, but {', '.join(still[:3])} still serve "
                f"{name}; record which provider this job uses to know for sure"))
        else:
            out[name] = Lifecycle(row.status, row.shutdown_date)
    return out


def most_used(providers: list[str | None]) -> str | None:
    """The provider most of a model's runs name, or None when none do."""
    named = [p.lower() for p in providers if p]
    return max(set(named), key=named.count) if named else None
