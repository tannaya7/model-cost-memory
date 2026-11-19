"""What each maker's own pages say about a model, kept next to the catalog's number so the two can be told apart.

The catalog's price comes from a community-maintained list (LiteLLM's model_prices_and_context_window.json). That list is
useful and usually right, but it is not the provider. So for the three makers whose pricing pages can be read reliably
(Anthropic, Google, OpenAI) this module reads the maker's own page once a day, keeps the standard price it states with a
checked-at date, and compares it with the catalog's number. The answer for a model is one of:

    confirmed      the maker's page states the same input and output price
    differs        the maker's page states a different price (both numbers are shown; the maker's page is the authority)
    not_readable   the maker's page lists the model but states its price in a way that cannot be read as one number
                   (a price that changes on a date, or differs by kind of input): shown as unknown, never guessed
    not_listed     the page was read and does not list this model
    other_host     the catalog's price is a cloud partner's or router's, which may differ from the maker's page
    not_checked    no page of the maker's is read for this model yet (never read, or another provider altogether)

Every record also carries links to the maker's own model, pricing and deprecation pages. Nothing here ranks a model, copies a
benchmark or a leaderboard, or says a public benchmark predicts quality on anyone's work: it is reference information. API
models are what the catalog lists; coding tools and subscription apps (Cursor, Copilot and the like) are not API endpoints and
are never listed or ranked here.
"""

from __future__ import annotations

import logging
import re
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from decimal import Decimal

from sqlalchemy import delete, select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from ..models import OfficialPrice, PriceSource
from . import official_parse as parse

log = logging.getLogger("agent_memory.catalog.official")

STALE_AFTER = timedelta(days=7)
TOLERANCE = Decimal("0.0001")  # the catalog keeps four decimal places
BASIS = (
    "List price in US dollars per million tokens, standard rate for text. Batch discounts, cached-input rates, "
    "long-context tiers and a price that changes on a date are not shown, so your bill can differ."
)
CATALOG_SOURCE = "LiteLLM community price list (not the provider)"
Fetcher = Callable[[str], Awaitable[str]]


@dataclass(frozen=True)
class PriceSourceDef:
    source_id: str
    name: str
    provider: str  # the maker whose own page this is
    maker: str  # as the maker is named on screen
    docs_url: str
    pricing_url: str
    deprecations_url: str
    parse: Callable[[str], list[parse.OfficialPrice]]
    first_party: frozenset[str]  # catalog provider names that mean "sold by the maker itself"


PRICE_SOURCES: tuple[PriceSourceDef, ...] = (
    PriceSourceDef("anthropic", "Anthropic: Pricing", "anthropic", "Anthropic",
                   "https://platform.claude.com/docs/en/models/overview",
                   "https://platform.claude.com/docs/en/about-claude/pricing",
                   "https://platform.claude.com/docs/en/about-claude/model-deprecations",
                   parse.parse_anthropic, frozenset({"anthropic"})),
    PriceSourceDef("google", "Google: Gemini API pricing", "google", "Google",
                   "https://aistudio.google.com/docs/models", "https://aistudio.google.com/docs/pricing",
                   "https://aistudio.google.com/docs/deprecations", parse.parse_google, frozenset({"gemini", "google"})),
    PriceSourceDef("openai", "OpenAI: Pricing", "openai", "OpenAI",
                   "https://developers.openai.com/api/docs/models", "https://developers.openai.com/api/docs/pricing",
                   "https://developers.openai.com/api/docs/deprecations", parse.parse_openai, frozenset({"openai"})),
)
BY_PROVIDER = {s.provider: s for s in PRICE_SOURCES}
BY_FIRST_PARTY = {name: s for s in PRICE_SOURCES for name in s.first_party}


def official_links() -> list[str]:
    """Every official address this module points at: all must be https on a maker's own host (tests check it)."""
    return [u for s in PRICE_SOURCES for u in (s.docs_url, s.pricing_url, s.deprecations_url)]


# ---------------------------------------------------------------------------------------------------------- reading

async def sync_official_prices(session: AsyncSession, *, now: datetime | None = None, fetch: Fetcher | None = None,
                               sources: tuple[PriceSourceDef, ...] = PRICE_SOURCES) -> dict[str, str]:
    """Read each maker's pricing page and keep what it states. Returns {source_id: status}. A page that cannot be fetched
    or read keeps the last good prices and records why: it never empties them or invents any."""
    from ..notices.service import default_fetch  # the same fixed-address, https-only fetcher the notices use

    now = now or datetime.now(UTC)
    fetch = fetch or default_fetch
    result: dict[str, str] = {}
    for s in sources:
        await session.execute(
            insert(PriceSource).values(source_id=s.source_id, name=s.name, provider=s.provider, url=s.pricing_url)
            .on_conflict_do_update(index_elements=["source_id"], set_={"name": s.name, "url": s.pricing_url}))
        try:
            text = await fetch(s.pricing_url)
        except Exception as exc:  # noqa: BLE001 - recorded, never raised into the scheduler
            log.warning("price source %s could not be read: %s", s.source_id, exc)
            await _record(session, s, "FETCH_FAILED", now, f"{type(exc).__name__}: {str(exc)[:200]}")
            result[s.source_id] = "FETCH_FAILED"
            continue
        try:
            rows = s.parse(text)
        except Exception as exc:  # noqa: BLE001
            log.warning("price source %s could not be parsed: %s", s.source_id, exc)
            rows = []
        if not rows:
            await _record(session, s, "UNREADABLE", now, "The page was fetched but no prices could be read from it")
            result[s.source_id] = "UNREADABLE"
            continue
        await session.execute(delete(OfficialPrice).where(OfficialPrice.provider == s.provider))
        for r in {r.model: r for r in rows}.values():
            session.add(OfficialPrice(provider=s.provider, model=r.model, input_per_mtok=r.input_per_mtok,
                                      output_per_mtok=r.output_per_mtok, note=r.note, read_at=now))
        await _record(session, s, "OK", now, None, count=len(rows))
        result[s.source_id] = "OK"
    await session.commit()
    return result


async def _record(session: AsyncSession, s: PriceSourceDef, status: str, now: datetime, detail: str | None, count: int | None = None) -> None:
    values: dict = {"status": status, "last_checked_at": now, "detail": detail}
    if status == "OK":
        values.update(last_ok_at=now, model_count=count or 0)
    await session.execute(PriceSource.__table__.update().where(PriceSource.source_id == s.source_id).values(**values))


# ------------------------------------------------------------------------------------------------------ comparing

def matches_id(catalog_model: str, official_model: str) -> bool:
    """The same model: equal ids, or the catalog's id is the official id with an 8-digit date ("claude-haiku-4-5-20251001")."""
    c, o = catalog_model.lower(), official_model.lower()
    return c == o or re.fullmatch(re.escape(o) + r"-\d{8}", c) is not None


@dataclass(frozen=True)
class Reference:
    provider_name: str | None
    docs_url: str | None
    pricing_url: str | None
    deprecations_url: str | None
    price_check: str  # confirmed | differs | not_readable | not_listed | other_host | not_checked
    price_check_note: str
    checked_at: datetime | None
    stale: bool
    official_input: Decimal | None
    official_output: Decimal | None
    price_basis: str
    catalog_source: str


def _close(a: Decimal | None, b: Decimal | None) -> bool:
    return a is not None and b is not None and abs(a - b) <= TOLERANCE


def reference_for(model: str, provider: str, catalog_in: Decimal | None, catalog_out: Decimal | None, *, manual: bool,
                  sources: dict[str, PriceSource], official: dict[str, list[OfficialPrice]], now: datetime) -> Reference:
    """Everything the screens may say about where a model's price and links come from, and nothing more."""
    source_by_name = BY_FIRST_PARTY.get(provider.lower())
    base = dict(price_basis=BASIS, catalog_source="Entered by hand" if manual else CATALOG_SOURCE)
    if source_by_name is None:
        if _is_partner(provider):
            return Reference(None, None, None, None, "other_host",
                             "Sold through a platform other than the model's maker, which sets its own price, so the maker's page "
                             "may differ. We do not read this platform's page yet.", None, False, None, None, **base)
        return Reference(None, None, None, None, "not_checked", "We do not read this provider's own pages yet, so this price is not "
                         "confirmed against them.", None, False, None, None, **base)
    src = sources.get(source_by_name.source_id)
    links = dict(provider_name=source_by_name.maker, docs_url=source_by_name.docs_url, pricing_url=source_by_name.pricing_url,
                 deprecations_url=source_by_name.deprecations_url)
    if src is None or src.last_ok_at is None:
        why = "The maker's pricing page has not been read yet." if src is None or src.status == "NEVER" else \
            "The maker's pricing page could not be read the last time we tried, so nothing is confirmed."
        return Reference(**links, price_check="not_checked", price_check_note=why, checked_at=None, stale=False,
                         official_input=None, official_output=None, **base)
    stale = now - src.last_ok_at > STALE_AFTER
    rows = official.get(source_by_name.provider, [])
    row = next((r for r in rows if matches_id(model, r.model)), None)
    common = dict(**links, checked_at=src.last_ok_at, stale=stale, **base)
    if row is None:
        return Reference(**common, price_check="not_listed", price_check_note="The maker's pricing page does not list this model.",
                         official_input=None, official_output=None)
    if row.input_per_mtok is None or row.output_per_mtok is None:
        return Reference(**common, price_check="not_readable", official_input=row.input_per_mtok, official_output=row.output_per_mtok,
                         price_check_note=f"The maker lists this model, but {row.note or 'its price cannot be read as one number'}. Shown as unknown.")
    if _close(catalog_in, row.input_per_mtok) and _close(catalog_out, row.output_per_mtok):
        return Reference(**common, price_check="confirmed", price_check_note="The maker's pricing page states the same price.",
                         official_input=row.input_per_mtok, official_output=row.output_per_mtok)
    return Reference(**common, price_check="differs", official_input=row.input_per_mtok, official_output=row.output_per_mtok,
                     price_check_note="The maker's pricing page states a different price. The maker's page is the authority.")


_PARTNERS = ("bedrock", "vertex", "azure", "openrouter", "together", "groq", "fireworks", "deepinfra", "sagemaker", "databricks", "watsonx")


def _is_partner(provider: str) -> bool:
    p = provider.lower()
    return any(p.startswith(x) for x in _PARTNERS)


async def load(session: AsyncSession) -> tuple[dict[str, PriceSource], dict[str, list[OfficialPrice]]]:
    sources = {s.source_id: s for s in (await session.execute(select(PriceSource))).scalars().all()}
    rows = (await session.execute(select(OfficialPrice))).scalars().all()
    by_provider: dict[str, list[OfficialPrice]] = {}
    for r in rows:
        by_provider.setdefault(r.provider, []).append(r)
    return sources, by_provider
