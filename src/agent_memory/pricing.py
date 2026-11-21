"""Which price priced a run, and how to price it again later.

A price is only ever one of:
  - a version that is in force at the moment of the call (effective_from <= at < effective_to), or
  - nothing: the run is UNPRICED, with the reason (unknown model, price not yet in force, price expired).

Names are matched exactly after `versions.normalize` (lower-case, alias-free): the run's resolved model name
first, then the name that was asked for. There is no fuzzy or prefix match, so "gpt-5-mini" can never borrow
the price of "gpt-5". The one family rule that exists is for CACHE factors (costing.cache_factors), which are
verified per family against the providers' pages.

These are public list prices from the source named on each version. They are not a customer's negotiated,
discounted or invoiced price, and the app never says they are.

Modifiers. Two Anthropic multipliers are verified on its pricing page
(https://platform.claude.com/docs/en/about-claude/pricing, opened 2026-11-17) and applied only to a response
that Anthropic itself labelled: usage.service_tier "batch" is 50% of both input and output (and "stacks with the
cache multipliers"), and usage.inference_geo "us" is 1.1x on every token category for Claude 4.6 and later.
Anything else the response reports that changes the price (priority tier, fast speed, a region other than US,
batch and US together, a model older than 4.6 with a US label) is NOT modelled: the run is priced at the list
rate and marked PARTLY_PRICED so it is counted apart and never presented as exact.
"""

from __future__ import annotations

import re
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime
from decimal import Decimal
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from .costing import Price, compute_cost
from .models import PriceVersion, Run
from .versions import normalize

PRICED = "PRICED"
PARTLY_PRICED = "PARTLY_PRICED"
UNPRICED_UNKNOWN_MODEL = "UNPRICED_UNKNOWN_MODEL"
UNPRICED_NOT_YET_EFFECTIVE = "UNPRICED_NOT_YET_EFFECTIVE"
UNPRICED_EXPIRED = "UNPRICED_EXPIRED"

BATCH_FACTOR = Decimal("0.5")
US_REGION_FACTOR = Decimal("1.1")
# Claude Haiku 5.5 only: a prompt over 100,000 tokens pays higher rates on EVERY price (input, output, both cache writes, cache reads),
# 5 times the standard ones (Anthropic's pricing and prompt-caching pages, read 20 November 2026). The length counts input, cache reads and
# cache writes together. It stacks with batch (0.5) and the US region (1.1), which are applied to the higher prices. Other 4.6+ models bill
# their whole 1M window at the standard rates. Verified for Anthropic's own API; the same model name on another cloud may be priced differently.
LONG_PROMPT_TOKENS = 100_000
LONG_PROMPT_FACTOR = Decimal(5)
_LONG_PROMPT_MODELS = re.compile(r"(?<![a-z0-9])haiku-5-5(?![0-9])")
# "For Claude 4.6 and later models, using inference_geo "us" applies a 1.1x pricing multiplier."
_US_REGION_MODELS = re.compile(
    r"(?<![a-z0-9])(fable-5|mythos-5|opus-5|sonnet-5|haiku-5|opus-4-[6-9]|sonnet-4-[6-9]|haiku-4-[6-9])")


@dataclass(frozen=True)
class Resolution:
    price: Price | None
    version_id: uuid.UUID | None
    status: str
    version: PriceVersion | None = None


def version_to_price(version: PriceVersion, name: str) -> Price:
    """The Price a stored version stands for. Cache prices come from the verified family factors unless the
    version carries an exact figure (cache_basis EXPLICIT)."""
    price = Price.from_input_output(version.input_per_mtok, version.output_per_mtok, model=name)
    if version.cache_basis != "EXPLICIT":
        return price
    return Price(
        input_per_mtok=price.input_per_mtok, output_per_mtok=price.output_per_mtok,
        cache_read_per_mtok=version.cache_read_per_mtok if version.cache_read_per_mtok is not None
        else price.cache_read_per_mtok,
        cache_write_per_mtok=version.cache_write_5m_per_mtok if version.cache_write_5m_per_mtok is not None
        else price.cache_write_per_mtok,
        cache_write_1h_per_mtok=version.cache_write_1h_per_mtok,
    )


def _in_force(v: PriceVersion, at: datetime) -> bool:
    return v.effective_from <= at and (v.effective_to is None or v.effective_to > at)


async def resolve_price(
    session: AsyncSession, model: str, model_version: str, provider: str | None = None, *, at: datetime | None = None,
) -> Resolution:
    """The price version in force at `at` (default: now) for this call, or why there is none.

    A hand-entered (MANUAL) catalog price always wins. Otherwise, when the run names its provider, that
    provider's own price is used, because the same model can cost several times more on one provider."""
    candidates = [normalize(model_version), normalize(model)]
    provider = provider.strip().lower() if provider else None
    # "Now" is read from the database's own clock, in the same query: the triggers stamp a price change with that
    # clock, and the application's clock (about 15 ms coarse on Windows) must never see a change as "not yet".
    found = (await session.execute(
        select(PriceVersion, func.clock_timestamp()).where(PriceVersion.model.in_(candidates)))).all()
    rows = [row[0] for row in found]
    at = at or (found[0][1] if found else datetime.now(UTC))

    def order(v: PriceVersion) -> tuple[int, float]:
        return candidates.index(v.model), -v.effective_from.timestamp()

    catalog = [v for v in rows if v.scope == "catalog" and _in_force(v, at)]
    sold = [v for v in rows if v.scope == "provider" and provider and v.provider == provider and _in_force(v, at)]
    best = min(catalog, key=order) if catalog else None
    chosen: PriceVersion | None = None
    if sold and not (best and best.source_kind == "MANUAL"):
        chosen = min(sold, key=order)
    elif best is not None:
        chosen = best
    if chosen is not None:
        return Resolution(version_to_price(chosen, model_version or model), chosen.version_id, PRICED, chosen)

    relevant = [v for v in rows if v.scope == "catalog" or (provider and v.provider == provider)]
    if any(v.effective_from > at for v in relevant):
        return Resolution(None, None, UNPRICED_NOT_YET_EFFECTIVE)
    if relevant:
        return Resolution(None, None, UNPRICED_EXPIRED)
    return Resolution(None, None, UNPRICED_UNKNOWN_MODEL)


def modifier_factor(usage_shape: str | None, model: str, usage_raw: dict[str, Any] | None,
                    prompt_tokens: int | None = None) -> tuple[Decimal | None, list[str]]:
    """(factor, unmodelled): the verified multiplier to apply (None = 1), and what the response reported that
    this code cannot price. Only an Anthropic-shaped usage block is read for modifiers. `prompt_tokens` is the call's
    input plus cache reads plus cache writes, which decides the long-prompt rate on Claude Haiku 5.5."""
    if usage_shape != "anthropic_messages":
        return None, []
    usage_raw = usage_raw or {}
    tier, geo, speed = usage_raw.get("service_tier"), usage_raw.get("inference_geo"), usage_raw.get("speed")
    name = normalize(model).replace(".", "-")
    factor = Decimal(1)
    unmodelled: list[str] = []
    if prompt_tokens is not None and prompt_tokens > LONG_PROMPT_TOKENS and _LONG_PROMPT_MODELS.search(name):
        factor *= LONG_PROMPT_FACTOR
    batch = tier == "batch"
    us = geo == "us"
    if batch and us:
        unmodelled.append("batch together with US region: stacking is not verified")
    elif batch:
        factor *= BATCH_FACTOR
    elif us:
        if _US_REGION_MODELS.search(name):
            factor *= US_REGION_FACTOR
        else:
            unmodelled.append("US region on a model the 1.1x multiplier is not verified for")
    if tier not in (None, "standard", "batch"):
        unmodelled.append(f"service tier {tier!r} is not priced")
    if geo not in (None, "global", "us"):
        unmodelled.append(f"region {geo!r} is not priced")
    if speed not in (None, "standard"):
        unmodelled.append(f"speed {speed!r} is not priced")
    return (factor if factor != 1 else None), unmodelled


async def reprice_run(session: AsyncSession, run: Run) -> Decimal | None:
    """The cost this run would have, from the price version it was priced with, never the current catalog.

    None when the run was not priced from a version (recorded before versions, caller-supplied cost, unpriced).
    For a PRICED run this equals run.cost_usd exactly: that is the reproducibility guarantee."""
    if run.price_version_id is None:
        return None
    version = await session.get(PriceVersion, run.price_version_id)
    if version is None:
        return None
    price = version_to_price(version, run.model_version or run.model)
    one_hour = run.cache_write_1h_tokens or 0  # stored with the run, so the 5m/1h split is reproducible
    return compute_cost(price, run.tokens_in, run.tokens_out, run.cache_read_tokens, run.cache_write_tokens,
                        one_hour, run.price_factor or Decimal(1))
