"""Price versions: which price priced a run, what is unpriced and why, and that history never moves.

Public list prices only: nothing here treats a list price as anyone's negotiated or invoice price."""

import uuid
from datetime import UTC, datetime, timedelta
from decimal import Decimal

import pytest
from sqlalchemy import select, text
from sqlalchemy.exc import IntegrityError

from agent_memory.catalog.sync import set_override, sync_catalog
from agent_memory.costing import Price, compute_cost
from agent_memory.models import CatalogEntry, PriceVersion, ProviderPrice, Run
from agent_memory.pricing import (
    PARTLY_PRICED,
    PRICED,
    UNPRICED_EXPIRED,
    UNPRICED_NOT_YET_EFFECTIVE,
    UNPRICED_UNKNOWN_MODEL,
    modifier_factor,
    reprice_run,
    resolve_price,
)
from agent_memory.projects import create_project

NOW = datetime.now(UTC)
JOB = {"name": "j", "check_kind": "LATE_LABEL", "check_config": {}}


# --- modifiers: only what is verified is applied; anything else is labelled, not guessed -----------------------

def test_batch_is_half_price_on_an_anthropic_response():
    factor, unmodelled = modifier_factor("anthropic_messages", "claude-sonnet-5-5", {"service_tier": "batch"})
    assert factor == Decimal("0.5") and unmodelled == []


def test_us_region_is_1_1x_only_for_models_it_is_verified_for():
    assert modifier_factor("anthropic_messages", "claude-sonnet-5-5", {"inference_geo": "us"}) == (Decimal("1.1"), [])
    assert modifier_factor("anthropic_messages", "claude-opus-4-6", {"inference_geo": "us"})[0] == Decimal("1.1")
    factor, unmodelled = modifier_factor("anthropic_messages", "claude-3-haiku", {"inference_geo": "us"})
    assert factor is None and unmodelled  # an older model: not verified, so not applied and not hidden


def test_stacked_priority_fast_and_other_regions_are_labelled_not_priced():
    assert modifier_factor("anthropic_messages", "claude-sonnet-5-5", {"service_tier": "batch", "inference_geo": "us"}) == (
        None, ["batch together with US region: stacking is not verified"])
    assert modifier_factor("anthropic_messages", "m", {"service_tier": "priority"})[1]
    assert modifier_factor("anthropic_messages", "m", {"speed": "fast"})[1]
    assert modifier_factor("anthropic_messages", "m", {"inference_geo": "eu"})[1]


@pytest.mark.parametrize("shape", [None, "openai_chat", "gemini", "none"])
def test_other_providers_and_missing_blocks_get_no_modifier(shape):
    assert modifier_factor(shape, "gpt-x", {"service_tier": "batch", "inference_geo": "us"}) == (None, [])


def test_standard_and_global_are_not_modifiers():
    assert modifier_factor("anthropic_messages", "m", {"service_tier": "standard", "inference_geo": "global",
                                                       "speed": "standard"}) == (None, [])


# --- cache tiers and rounding ------------------------------------------------------------------------------------

def test_five_minute_and_one_hour_cache_writes_are_priced_apart():
    price = Price.from_input_output(Decimal("3"), Decimal("15"), model="claude-sonnet-5-5")
    five = compute_cost(price, 0, 0, 0, 1_000_000)
    one = compute_cost(price, 0, 0, 0, 1_000_000, 1_000_000)
    assert five == Decimal("3.750000") and one == Decimal("6.000000")  # 1.25x vs 2x of $3
    mixed = compute_cost(price, 0, 0, 0, 1_000_000, 400_000)
    assert mixed == Decimal("4.650000")  # 600k at 3.75 + 400k at 6.00


def test_an_exact_one_hour_price_beats_the_family_factor():
    price = Price(Decimal(3), Decimal(15), Decimal("0.3"), Decimal("3.75"), cache_write_1h_per_mtok=Decimal("5"))
    assert compute_cost(price, 0, 0, 0, 1_000_000, 1_000_000) == Decimal("5.000000")


def test_cache_read_factor_follows_the_verified_family():
    sonnet = Price.from_input_output(Decimal("3"), Decimal("15"), model="claude-sonnet-5-5")
    older = Price.from_input_output(Decimal("3"), Decimal("15"), model="claude-3-5-sonnet")
    assert sonnet.cache_read_per_mtok == Decimal("0.15") and older.cache_read_per_mtok == Decimal("0.3")


def test_cost_is_rounded_half_up_to_six_places_once():
    price = Price(Decimal("0.5"), Decimal(0), Decimal(0), Decimal(0))
    assert compute_cost(price, 1, 0) == Decimal("0.000001")   # 0.0000005 rounds half up
    assert compute_cost(price, 3, 0) == Decimal("0.000002")   # 0.0000015
    # the factor is applied before the one rounding: 5 tokens at $0.5 per million = 0.0000025, halved = 0.00000125
    assert compute_cost(price, 5, 0, factor=Decimal("0.5")) == Decimal("0.000001")


# --- the trigger writes the history -----------------------------------------------------------------------------

async def versions(session, model):
    return (await session.execute(
        select(PriceVersion).where(PriceVersion.model == model).order_by(PriceVersion.effective_from))).scalars().all()


async def test_inserting_and_changing_a_catalog_price_writes_and_closes_versions(session):
    session.add(CatalogEntry(model="acme-s", model_version="acme-s", provider="acme",
                             price_in_per_mtok=Decimal("1"), price_out_per_mtok=Decimal("2")))
    await session.commit()
    first = (await versions(session, "acme-s"))[0]
    assert first.effective_to is None and first.source_kind == "SYNC" and first.checked_at is not None
    assert "not a negotiated" in first.applicability and first.source_url.startswith("https://")
    row = (await session.execute(select(CatalogEntry))).scalar_one()
    row.price_in_per_mtok = Decimal("1.5")
    await session.commit()
    session.expire_all()  # re-read: the trigger closed the first version in the database
    vs = await versions(session, "acme-s")
    assert [v.input_per_mtok for v in vs] == [Decimal("1"), Decimal("1.5")]
    assert vs[0].effective_to is not None and vs[1].effective_to is None  # exactly one open version


async def test_deleting_a_catalog_row_or_removing_its_price_ends_the_version_in_force(session):
    session.add(CatalogEntry(model="acme-s", model_version="acme-s", provider="acme",
                             price_in_per_mtok=Decimal("1"), price_out_per_mtok=Decimal("2")))
    session.add(CatalogEntry(model="acme-t", model_version="acme-t", provider="acme",
                             price_in_per_mtok=Decimal("1"), price_out_per_mtok=Decimal("2")))
    await session.commit()
    assert (await resolve_price(session, "acme-s", "acme-s")).status == PRICED
    await session.delete(await session.get(CatalogEntry, ("acme-s", "acme-s")))
    (await session.get(CatalogEntry, ("acme-t", "acme-t"))).price_in_per_mtok = None
    await session.commit()
    session.expire_all()
    assert (await resolve_price(session, "acme-s", "acme-s")).status == UNPRICED_EXPIRED
    assert (await resolve_price(session, "acme-t", "acme-t")).status == UNPRICED_EXPIRED
    assert all(v.effective_to is not None for v in await versions(session, "acme-s"))  # history kept, not erased


async def test_an_update_that_changes_no_price_writes_no_version(session):
    session.add(CatalogEntry(model="acme-s", model_version="acme-s", provider="acme",
                             price_in_per_mtok=Decimal("1"), price_out_per_mtok=Decimal("2")))
    await session.commit()
    row = (await session.execute(select(CatalogEntry))).scalar_one()
    row.status = "DEPRECATED"
    await session.commit()
    assert len(await versions(session, "acme-s")) == 1


async def test_a_hand_override_is_its_own_version_with_no_provider_url(session):
    await set_override(session, "local-llm", provider="ollama", price_in_per_mtok=0, price_out_per_mtok=0)
    v = (await versions(session, "local-llm"))[0]
    assert v.source_kind == "MANUAL" and v.source_url is None and "by hand" in v.applicability


async def test_a_provider_price_is_versioned_separately(session):
    session.add(ProviderPrice(model="open-m", provider="groq", price_in_per_mtok=Decimal("0.1"),
                              price_out_per_mtok=Decimal("0.2")))
    await session.commit()
    v = (await versions(session, "open-m"))[0]
    assert v.scope == "provider" and v.provider == "groq"


async def test_a_sync_stamps_checked_at_even_when_no_price_moved(session):
    data = {"acme-s": {"litellm_provider": "acme", "mode": "chat", "input_cost_per_token": 1e-06,
                       "output_cost_per_token": 2e-06}}
    await sync_catalog(session, data)
    first = [v for v in await versions(session, "acme-s") if v.scope == "catalog"][0]
    stamp = first.checked_at
    await sync_catalog(session, data)
    session.expire_all()
    vs = [v for v in await versions(session, "acme-s") if v.scope == "catalog"]
    assert len(vs) == 1 and vs[0].checked_at > stamp  # looked at again, price unchanged, still one version


# --- resolving: exact names, aliases, unknown, future, expired --------------------------------------------------

async def add_version(session, model, *, scope="catalog", provider="acme", frm=None, to=None, price=("1", "2"),
                      kind="SYNC"):
    session.add(PriceVersion(scope=scope, model=model, model_version=model if scope == "catalog" else "",
                             provider=provider, input_per_mtok=Decimal(price[0]), output_per_mtok=Decimal(price[1]),
                             effective_from=frm or NOW - timedelta(days=30), effective_to=to, source_kind=kind))
    await session.commit()


async def test_names_match_exactly_never_by_prefix(session):
    await add_version(session, "gpt-5")
    miss = await resolve_price(session, "gpt-5-mini", "gpt-5-mini")
    assert miss.price is None and miss.status == UNPRICED_UNKNOWN_MODEL and miss.version_id is None
    assert (await resolve_price(session, "gpt-5", "gpt-5")).status == PRICED


async def test_an_alias_resolves_through_either_name_and_the_resolved_name_wins(session):
    await add_version(session, "acme-large", price=("1", "2"))
    await add_version(session, "acme-large-2026-06-01", price=("3", "6"))
    both = await resolve_price(session, "acme-large", "acme-large-2026-06-01")
    assert both.price.input_per_mtok == Decimal("3")          # the dated, resolved name first
    alias_only = await resolve_price(session, "acme-large", "something-not-in-catalog")
    assert alias_only.price.input_per_mtok == Decimal("1")    # falls back to the name that was asked for


async def test_case_and_whitespace_in_a_name_do_not_matter(session):
    await add_version(session, "acme-s")
    assert (await resolve_price(session, " ACME-S ", " Acme-S ")).status == PRICED


async def test_a_future_price_is_not_used_until_it_is_in_force(session):
    await add_version(session, "acme-s", frm=NOW + timedelta(days=10))
    early = await resolve_price(session, "acme-s", "acme-s")
    assert early.price is None and early.status == UNPRICED_NOT_YET_EFFECTIVE
    later = await resolve_price(session, "acme-s", "acme-s", at=NOW + timedelta(days=11))
    assert later.status == PRICED


async def test_a_scheduled_change_does_not_hide_the_price_in_force_today(session):
    await add_version(session, "acme-s", frm=NOW - timedelta(days=60), to=NOW + timedelta(days=10), price=("1", "2"))
    await add_version(session, "acme-s", frm=NOW + timedelta(days=10), price=("2", "4"))
    assert (await resolve_price(session, "acme-s", "acme-s")).price.input_per_mtok == Decimal("1")
    assert (await resolve_price(session, "acme-s", "acme-s", at=NOW + timedelta(days=11))).price.input_per_mtok == Decimal("2")


async def test_an_expired_price_is_unpriced_not_silently_reused(session):
    await add_version(session, "acme-s", frm=NOW - timedelta(days=60), to=NOW - timedelta(days=1))
    r = await resolve_price(session, "acme-s", "acme-s")
    assert r.price is None and r.status == UNPRICED_EXPIRED
    assert (await resolve_price(session, "acme-s", "acme-s", at=NOW - timedelta(days=30))).status == PRICED


async def test_the_end_of_a_period_is_exclusive_and_the_start_inclusive(session):
    edge = NOW - timedelta(hours=1)
    await add_version(session, "acme-s", frm=NOW - timedelta(days=5), to=edge, price=("1", "2"))
    await add_version(session, "acme-s", frm=edge, price=("5", "6"))
    assert (await resolve_price(session, "acme-s", "acme-s", at=edge)).price.input_per_mtok == Decimal("5")
    assert (await resolve_price(session, "acme-s", "acme-s", at=edge - timedelta(seconds=1))).price.input_per_mtok == Decimal("1")


async def test_a_providers_own_price_beats_the_default_and_a_hand_price_beats_both(session):
    await add_version(session, "open-m", price=("1", "2"), frm=NOW - timedelta(days=30))
    await add_version(session, "open-m", scope="provider", provider="groq", price=("0.1", "0.2"))
    assert (await resolve_price(session, "open-m", "open-m", "groq")).price.input_per_mtok == Decimal("0.1")
    assert (await resolve_price(session, "open-m", "open-m", "together_ai")).price.input_per_mtok == Decimal("1")
    await add_version(session, "open-m", provider="me", price=("9", "9"), kind="MANUAL", frm=NOW - timedelta(days=1))
    assert (await resolve_price(session, "open-m", "open-m", "groq")).price.input_per_mtok == Decimal("9")


# --- a run keeps its price version; history never moves -------------------------------------------------------

async def post_run(client, headers, **over):
    body = {"run_id": str(uuid.uuid4()), "job": "j", "prompt": "p", "model": "acme-s", "model_version": "acme-s",
            "tokens_in": 1_000_000, "tokens_out": 1_000_000}
    body.update(over)
    assert (await client.post("/v1/runs", json=body, headers=headers)).status_code == 202
    return body["run_id"]


@pytest.fixture
async def keyed(client, session):
    _, key = await create_project(session, "proj1")
    headers = {"X-API-Key": key}
    await client.post("/v1/jobs", json=JOB, headers=headers)
    return headers


async def test_a_run_records_the_version_that_priced_it_and_a_later_price_change_does_not_touch_it(client, session, keyed):
    session.add(CatalogEntry(model="acme-s", model_version="acme-s", provider="acme",
                             price_in_per_mtok=Decimal("1"), price_out_per_mtok=Decimal("2")))
    await session.commit()
    old_id = await post_run(client, keyed)
    row = (await session.execute(select(CatalogEntry))).scalar_one()
    row.price_in_per_mtok, row.price_out_per_mtok = Decimal("10"), Decimal("20")
    await session.commit()
    new_id = await post_run(client, keyed)
    session.expire_all()
    old = (await session.execute(select(Run).where(Run.run_id == uuid.UUID(old_id)))).scalar_one()
    new = (await session.execute(select(Run).where(Run.run_id == uuid.UUID(new_id)))).scalar_one()
    assert old.cost_usd == Decimal("3.000000") and new.cost_usd == Decimal("30.000000")
    assert old.price_version_id != new.price_version_id and old.price_status == PRICED
    # the old run can be recomputed exactly from its own version, long after the catalog moved on
    assert await reprice_run(session, old) == old.cost_usd and await reprice_run(session, new) == new.cost_usd


async def test_an_unknown_model_is_unpriced_with_a_reason_and_no_cost(client, session, keyed):
    await post_run(client, keyed, model="nobody-knows", model_version="nobody-knows")
    r = (await session.execute(select(Run))).scalar_one()
    assert r.cost_usd is None and r.price_status == "UNPRICED_UNKNOWN_MODEL" and r.price_version_id is None
    assert await reprice_run(session, r) is None


async def test_a_future_only_price_leaves_the_run_unpriced_for_now(client, session, keyed):
    await add_version(session, "acme-s", frm=NOW + timedelta(days=3))
    await post_run(client, keyed)
    r = (await session.execute(select(Run))).scalar_one()
    assert r.cost_usd is None and r.price_status == "UNPRICED_NOT_YET_EFFECTIVE"


async def test_a_caller_supplied_cost_is_labelled_as_theirs(client, session, keyed):
    await post_run(client, keyed, model="nobody-knows", model_version="nobody-knows", cost_usd=0.25)
    r = (await session.execute(select(Run))).scalar_one()
    assert r.cost_usd == Decimal("0.250000") and r.price_status == "CALLER_COST" and r.price_version_id is None


async def test_no_usage_is_counted_apart_from_an_unknown_model(client, session, keyed):
    await add_version(session, "acme-s")
    await post_run(client, keyed, tokens_in=0, tokens_out=0, usage_shape="none")
    r = (await session.execute(select(Run))).scalar_one()
    assert r.cost_usd is None and r.price_status == "NO_USAGE"


async def test_an_anthropic_batch_run_is_priced_at_half_and_remembers_the_factor(client, session, keyed):
    await add_version(session, "acme-s")
    rid = await post_run(client, keyed, usage_shape="anthropic_messages", usage_raw={"service_tier": "batch"})
    r = (await session.execute(select(Run).where(Run.run_id == uuid.UUID(rid)))).scalar_one()
    assert r.cost_usd == Decimal("1.500000") and r.price_factor == Decimal("0.5000") and r.price_status == PRICED
    assert await reprice_run(session, r) == r.cost_usd


async def test_a_modifier_that_is_not_modelled_marks_the_run_partly_priced(client, session, keyed):
    await add_version(session, "acme-s")
    rid = await post_run(client, keyed, usage_shape="anthropic_messages", usage_raw={"service_tier": "priority"})
    r = (await session.execute(select(Run).where(Run.run_id == uuid.UUID(rid)))).scalar_one()
    assert r.cost_usd == Decimal("3.000000") and r.price_status == PARTLY_PRICED and r.price_factor is None


async def test_a_one_hour_write_is_reproducible_from_the_stored_run(client, session, keyed):
    await add_version(session, "acme-s")
    rid = await post_run(client, keyed, tokens_in=0, tokens_out=0, cache_write_tokens=1_000_000,
                         cache_write_1h_tokens=400_000)
    r = (await session.execute(select(Run).where(Run.run_id == uuid.UUID(rid)))).scalar_one()
    assert r.cache_write_1h_tokens == 400_000 and await reprice_run(session, r) == r.cost_usd


async def test_runs_expose_their_price_status(client, session, keyed):
    await add_version(session, "acme-s")
    await post_run(client, keyed)
    page = (await client.get("/v1/runs", headers=keyed)).json()
    assert page["items"][0]["price_status"] == "PRICED"


async def test_the_database_refuses_a_backwards_period_and_a_made_up_price_status(session):
    session.add(PriceVersion(scope="catalog", model="x", model_version="x", provider="p", input_per_mtok=Decimal(1),
                             output_per_mtok=Decimal(1), effective_from=NOW, effective_to=NOW - timedelta(days=1),
                             source_kind="SYNC"))
    with pytest.raises(IntegrityError):
        await session.commit()
    await session.rollback()
    found = (await session.execute(text(
        "SELECT count(*) FROM pg_constraint WHERE conname IN ('runs_price_status_check','price_versions_scope_check',"
        "'price_versions_source_kind_check')"))).scalar_one()
    assert found >= 3


# --- Claude Haiku 5.5: a prompt over 100,000 tokens pays 5x on every rate (Anthropic pricing page, read 20 November 2026) ---------

LONG = "claude-haiku-5-5"


def test_a_haiku_5_5_prompt_over_100k_tokens_pays_five_times_on_everything():
    assert modifier_factor("anthropic_messages", LONG, {}, prompt_tokens=100_001) == (Decimal(5), [])
    assert modifier_factor("anthropic_messages", "claude-haiku-5-5-20260401", None, prompt_tokens=250_000) == (Decimal(5), [])


def test_exactly_100k_is_still_the_standard_rate_and_so_is_a_short_prompt():
    assert modifier_factor("anthropic_messages", LONG, {}, prompt_tokens=100_000) == (None, [])
    assert modifier_factor("anthropic_messages", LONG, {}, prompt_tokens=1_000) == (None, [])
    assert modifier_factor("anthropic_messages", LONG, {}) == (None, [])  # no token count given: nothing is guessed


def test_other_models_bill_their_whole_window_at_the_standard_rate():
    for model in ("claude-sonnet-5-5", "claude-opus-5-5", "claude-haiku-4-5", "claude-haiku-5-50", "gpt-5"):
        assert modifier_factor("anthropic_messages", model, {}, prompt_tokens=900_000) == (None, []), model


def test_it_only_applies_to_an_anthropic_shaped_response():
    assert modifier_factor("openai_chat", LONG, {}, prompt_tokens=500_000) == (None, [])
    assert modifier_factor(None, LONG, None, prompt_tokens=500_000) == (None, [])


def test_it_stacks_with_batch_and_with_the_us_region_as_the_pricing_page_states():
    assert modifier_factor("anthropic_messages", LONG, {"service_tier": "batch"}, prompt_tokens=200_000) == (Decimal("2.5"), [])  # 0.25 / 1.25 against 0.05 / 0.25
    assert modifier_factor("anthropic_messages", LONG, {"inference_geo": "us"}, prompt_tokens=200_000) == (Decimal("5.5"), [])
    factor, unmodelled = modifier_factor("anthropic_messages", LONG, {"service_tier": "batch", "inference_geo": "us"}, prompt_tokens=200_000)
    assert factor == Decimal(5) and unmodelled  # batch together with the US region is still not verified: said, not guessed


async def test_cache_reads_and_writes_count_toward_the_100k_and_the_cost_is_reproducible(client, session, keyed):
    await add_version(session, LONG, price=("0.1", "0.5"))
    short = await post_run(client, keyed, model=LONG, model_version=LONG, usage_shape="anthropic_messages", tokens_in=60_000, tokens_out=1_000_000)
    long = await post_run(client, keyed, model=LONG, model_version=LONG, usage_shape="anthropic_messages", tokens_in=60_000,
                          cache_read_tokens=50_000, tokens_out=1_000_000)  # 60,000 + 50,000 = 110,000: over
    a = (await session.execute(select(Run).where(Run.run_id == uuid.UUID(short)))).scalar_one()
    b = (await session.execute(select(Run).where(Run.run_id == uuid.UUID(long)))).scalar_one()
    assert a.price_factor is None and b.price_factor == Decimal("5.0000")
    # 60,000 in at $0.10 and 1M out at $0.50 = $0.506; the long one costs five times its own standard price, cache read included
    assert a.cost_usd == Decimal("0.506000")
    assert b.cost_usd == (Decimal("0.506000") + Decimal("50000") / Decimal(1_000_000) * Decimal("0.1") * Decimal("0.1")) * 5
    assert await reprice_run(session, b) == b.cost_usd  # recomputed from its own price version and stored factor: the same amount
