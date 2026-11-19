"""What the makers' own pages say next to the catalog's number: reading each pricing page, comparing, failing safely, linking only
to the makers' own pages, and never ranking or scoring anything. Parsers are checked against saved snapshots of the real pages;
no test touches the network."""

import re
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from pathlib import Path
from urllib.parse import urlsplit

import pytest
from sqlalchemy import select, update

from agent_memory.catalog import official as off
from agent_memory.catalog import official_parse as parse
from agent_memory.models import CatalogEntry, OfficialPrice, PriceSource, PriceVersion
from agent_memory.projects import create_project

FIX = Path(__file__).parent / "fixtures" / "prices"
NOW = datetime(2026, 11, 18, 12, 0, tzinfo=UTC)
D = Decimal


def page(name):
    return (FIX / f"{name}.md").read_text(encoding="utf8")


# --- reading each maker's page --------------------------------------------------------------------------------------

def test_openai_prices_are_read_with_exact_ids_and_the_standard_short_context_columns():
    rows = {r.model: r for r in parse.parse_openai(page("openai"))}
    assert len(rows) == 10
    assert (rows["gpt-6-luna"].input_per_mtok, rows["gpt-6-luna"].output_per_mtok) == (D("0.10"), D("0.50"))
    assert (rows["gpt-6-astra"].input_per_mtok, rows["gpt-6-astra"].output_per_mtok) == (D("10.00"), D("50.00"))  # not cached, not long context
    assert all(r.note is None for r in rows.values())


def test_anthropic_prices_are_read_from_display_names_mapped_to_ids():
    rows = {r.model: r for r in parse.parse_anthropic(page("anthropic"))}
    assert len(rows) == 18
    assert (rows["claude-opus-5-5"].input_per_mtok, rows["claude-opus-5-5"].output_per_mtok) == (D(4), D(20))
    assert (rows["claude-fable-5-2"].input_per_mtok, rows["claude-fable-5-2"].output_per_mtok) == (D(8), D(40))
    assert "claude-mythos-5-2" in rows  # a "(limited availability)" annotation does not hide the model
    haiku = rows["claude-haiku-5-5"]  # the page prices it by prompt length: two prices, so neither is picked
    assert haiku.input_per_mtok is None and haiku.output_per_mtok is None and "more than one price" in haiku.note


@pytest.mark.parametrize(("display", "expected"), [
    ("Claude Opus 5.5", "claude-opus-5-5"), ("Claude Haiku 4.5", "claude-haiku-4-5"),
    ("Claude Sonnet 4 ([deprecated](https://x))", "claude-sonnet-4"), ("Claude Fable 5.2", "claude-fable-5-2"),
    ("Claude pricing", None), ("Claude", None), ("Opus", None), ("", None),
])
def test_an_anthropic_display_name_maps_to_an_id_or_to_nothing(display, expected):
    assert parse.anthropic_id(display) == expected


def test_google_reads_one_price_and_refuses_ambiguous_ones_with_a_reason():
    rows = {r.model: r for r in parse.parse_google(page("google"))}
    assert set(rows) == {"gemini-4-hydrogen", "gemini-3.8-flash", "gemini-3.5-transcribe"}  # a section with no Standard tab is skipped
    assert (rows["gemini-4-hydrogen"].input_per_mtok, rows["gemini-4-hydrogen"].output_per_mtok) == (D("1.50"), D("7.50"))
    dated = rows["gemini-3.8-flash"]
    assert dated.input_per_mtok is None and dated.output_per_mtok is None and "changes on a date" in dated.note  # never the cheaper date
    by_input = rows["gemini-3.5-transcribe"]
    assert by_input.input_per_mtok is None and "more than one price" in by_input.note


@pytest.mark.parametrize("fn", [parse.parse_openai, parse.parse_anthropic, parse.parse_google])
def test_a_page_that_is_not_a_pricing_page_gives_nothing_not_a_guess(fn):
    assert fn("") == []
    assert fn("# Pricing\n\nWe have redesigned this page. Visit our new site.\n") == []
    assert fn("| Model | Notes |\n| --- | --- |\n| gpt-6-luna | cheap |\n") == []


def test_the_same_model_is_matched_by_id_or_by_a_dated_id_and_nothing_looser():
    assert off.matches_id("claude-haiku-4-5", "claude-haiku-4-5")
    assert off.matches_id("claude-haiku-4-5-20251001", "claude-haiku-4-5")
    assert not off.matches_id("claude-haiku-4-5-latest", "claude-haiku-4-5")
    assert not off.matches_id("claude-haiku-4-50", "claude-haiku-4-5")
    assert not off.matches_id("gpt-6-luna-mini", "gpt-6-luna")
    assert not off.matches_id("gpt-6", "gpt-6-luna")


# --- the comparison: one answer per model, never a guess ---------------------------------------------------------------

def src(provider="openai", *, ok=NOW - timedelta(hours=3), status="OK"):
    s = off.BY_PROVIDER[provider]
    return PriceSource(source_id=s.source_id, name=s.name, provider=s.provider, url=s.pricing_url, status=status,
                       last_checked_at=ok, last_ok_at=ok, detail=None, model_count=10)


def price(model, i, o, note=None, provider="openai"):
    return OfficialPrice(provider=provider, model=model, input_per_mtok=i, output_per_mtok=o, note=note, read_at=NOW)


def ref(model="gpt-6-luna", provider="openai", cin=D("0.1"), cout=D("0.5"), *, manual=False, sources=None, rows=None, now=NOW):
    sources = {"openai": src()} if sources is None else sources
    rows = {"openai": [price("gpt-6-luna", D("0.10"), D("0.50"))]} if rows is None else rows
    return off.reference_for(model, provider, cin, cout, manual=manual, sources=sources, official=rows, now=now)


def test_the_same_price_is_confirmed_with_the_date_the_page_was_read_and_its_links():
    r = ref()
    assert r.price_check == "confirmed" and r.checked_at == NOW - timedelta(hours=3) and not r.stale
    assert r.pricing_url == "https://developers.openai.com/api/docs/pricing" and r.provider_name == "OpenAI"
    assert r.docs_url.startswith("https://developers.openai.com/") and r.deprecations_url.endswith("/deprecations")
    assert r.catalog_source == off.CATALOG_SOURCE and "(not the provider)" in r.catalog_source


def test_a_different_price_is_shown_as_different_and_the_makers_number_is_given():
    r = ref(cin=D("0.20"))
    assert r.price_check == "differs" and (r.official_input, r.official_output) == (D("0.10"), D("0.50"))
    assert "authority" in r.price_check_note


def test_either_side_off_by_more_than_rounding_is_a_difference_and_less_is_not():
    assert ref(cin=D("0.10004")).price_check == "confirmed"  # four decimal places
    assert ref(cout=D("0.5002")).price_check == "differs"


def test_a_price_the_maker_does_not_give_as_one_number_is_unknown_never_guessed():
    r = ref(model="gemini-3.8-flash", provider="gemini", cin=D("0.75"), cout=D("3.75"),
            sources={"google": src("google")}, rows={"google": [price("gemini-3.8-flash", None, None, "the price changes on a date, so no single price is read", "google")]})
    assert r.price_check == "not_readable" and r.official_input is None and "Shown as unknown" in r.price_check_note
    assert "changes on a date" in r.price_check_note


def test_a_model_the_page_does_not_list_says_so():
    assert ref(model="gpt-9-imaginary").price_check == "not_listed"


def test_a_page_never_read_or_failing_confirms_nothing():
    never = ref(sources={})
    assert never.price_check == "not_checked" and never.checked_at is None and "not been read yet" in never.price_check_note
    broke = PriceSource(source_id="openai", name="x", provider="openai", url="u", status="FETCH_FAILED", last_checked_at=NOW, last_ok_at=None, detail="boom", model_count=0)
    r = ref(sources={"openai": broke})
    assert r.price_check == "not_checked" and "could not be read" in r.price_check_note


def test_an_old_reading_still_informs_and_is_marked_old():
    r = ref(sources={"openai": src(ok=NOW - timedelta(days=9))})
    assert r.price_check == "confirmed" and r.stale


def test_a_cloud_partners_price_is_not_confirmed_against_the_makers_page():
    r = ref(provider="bedrock")
    assert r.price_check == "other_host" and r.docs_url is None and r.pricing_url is None
    assert "sets its own price" in r.price_check_note


def test_an_unknown_provider_is_not_checked_and_has_no_links():
    r = ref(provider="someone-else")
    assert r.price_check == "not_checked" and r.docs_url is None and "do not read this provider's own pages" in r.price_check_note


def test_a_hand_entered_price_says_so():
    assert ref(manual=True).catalog_source == "Entered by hand"


# --- reading and keeping, failing safely ----------------------------------------------------------------------------------

async def test_a_good_reading_is_stored_with_its_time_and_status(session):
    async def fetch(url):
        return page("openai") if "openai" in url else (page("anthropic") if "claude" in url else page("google"))

    result = await off.sync_official_prices(session, now=NOW, fetch=fetch)
    assert result == {"anthropic": "OK", "google": "OK", "openai": "OK"}
    sources = {s.source_id: s for s in (await session.execute(select(PriceSource))).scalars()}
    assert sources["openai"].last_ok_at == NOW and sources["openai"].model_count == 10 and sources["google"].model_count == 3
    rows = (await session.execute(select(OfficialPrice).where(OfficialPrice.provider == "openai"))).scalars().all()
    assert len(rows) == 10 and all(r.read_at == NOW for r in rows)


async def test_an_unreachable_or_redesigned_page_keeps_the_last_good_prices_and_says_why(session):
    async def good(url):
        return page("openai")

    await off.sync_official_prices(session, now=NOW, fetch=good, sources=(off.BY_PROVIDER["openai"],))
    later = NOW + timedelta(days=2)

    async def down(url):
        raise TimeoutError("slow")

    assert await off.sync_official_prices(session, now=later, fetch=down, sources=(off.BY_PROVIDER["openai"],)) == {"openai": "FETCH_FAILED"}

    async def redesigned(url):
        return "# Pricing\n\nA new page with no table we know."

    assert await off.sync_official_prices(session, now=later, fetch=redesigned, sources=(off.BY_PROVIDER["openai"],)) == {"openai": "UNREADABLE"}
    s = await session.get(PriceSource, "openai")
    assert s.status == "UNREADABLE" and s.last_ok_at == NOW and s.last_checked_at == later  # the last good reading is not forgotten
    assert len((await session.execute(select(OfficialPrice))).scalars().all()) == 10  # prices kept, not emptied or invented


async def test_one_source_failing_does_not_stop_the_others(session):
    async def mixed(url):
        if "claude" in url:
            raise OSError("down")
        return page("openai") if "openai" in url else page("google")

    assert await off.sync_official_prices(session, now=NOW, fetch=mixed) == {"anthropic": "FETCH_FAILED", "google": "OK", "openai": "OK"}


async def test_a_model_the_page_no_longer_lists_is_removed_on_the_next_good_reading(session):
    async def first(url):
        return page("openai")

    only_one = "| Model | Short context input | Short context output |\n| --- | --- | --- |\n| gpt-6-luna | $0.10 | $0.50 |\n"

    async def second(url):
        return only_one

    await off.sync_official_prices(session, now=NOW, fetch=first, sources=(off.BY_PROVIDER["openai"],))
    await off.sync_official_prices(session, now=NOW + timedelta(days=1), fetch=second, sources=(off.BY_PROVIDER["openai"],))
    assert [r.model for r in (await session.execute(select(OfficialPrice))).scalars()] == ["gpt-6-luna"]


# --- links and what is never there ---------------------------------------------------------------------------------------

def test_every_official_link_is_https_on_a_makers_own_host_with_no_tracking_or_affiliate_tail():
    hosts = {"platform.claude.com", "aistudio.google.com", "developers.openai.com"}
    links = off.official_links()
    assert len(links) == 9 and len(set(links)) == 9
    for u in links:
        parts = urlsplit(u)
        assert parts.scheme == "https" and parts.hostname in hosts
        assert not parts.query and not parts.fragment and not re.search(r"ref|affiliate|utm|partner|sponsor", u, re.I)


def test_each_maker_points_at_its_own_models_pricing_and_deprecation_pages():
    for s in off.PRICE_SOURCES:
        hosts = {urlsplit(u).hostname for u in (s.docs_url, s.pricing_url, s.deprecations_url)}
        assert len(hosts) == 1  # all three on the same maker's host
        assert "pricing" in s.pricing_url and "deprecat" in s.deprecations_url


def test_the_price_basis_says_what_the_number_is_and_is_not():
    assert "standard rate for text" in off.BASIS and "can differ" in off.BASIS
    assert "per million tokens" in off.BASIS


# --- the API ----------------------------------------------------------------------------------------------------------------

async def seed_catalog(session):
    for model, provider, i, o, source in [
        ("gpt-6-luna", "openai", D("0.1"), D("0.5"), "SYNC"), ("gpt-6-astra", "openai", D("9.0"), D("50.0"), "SYNC"),
        ("gemini-3.8-flash", "gemini", D("0.75"), D("3.75"), "SYNC"), ("claude-opus-5-5", "bedrock", D("4"), D("20"), "SYNC"),
        ("llama-3.1-70b", "groq", D("0.6"), D("0.8"), "SYNC"), ("my-local-model", "ollama", D(0), D(0), "MANUAL"),
    ]:
        session.add(CatalogEntry(model=model, model_version=model, provider=provider, status="ACTIVE", price_in_per_mtok=i,
                                 price_out_per_mtok=o, source=source))
    await session.flush()  # inserting a catalog row writes its price version (a trigger); stamp when the sync last confirmed it
    await session.execute(update(PriceVersion).values(checked_at=NOW - timedelta(hours=5)))
    await session.commit()


async def test_the_catalog_api_carries_links_checked_dates_and_the_comparison(client, session):
    _, key = await create_project(session, "proj1")
    headers = {"X-API-Key": key}
    await seed_catalog(session)

    async def fetch(url):
        return page("openai") if "openai" in url else (page("anthropic") if "claude" in url else page("google"))

    await off.sync_official_prices(session, fetch=fetch)
    body = (await client.get("/v1/models", headers=headers)).json()
    by = {m["model"]: m["reference"] for m in body["items"]}

    assert by["gpt-6-luna"]["price_check"] == "confirmed" and by["gpt-6-luna"]["price_checked_at"] is not None
    assert by["gpt-6-luna"]["pricing_url"] == "https://developers.openai.com/api/docs/pricing" and by["gpt-6-luna"]["maker"] == "OpenAI"
    assert by["gpt-6-astra"]["price_check"] == "differs" and by["gpt-6-astra"]["official_input_per_mtok"] == 10.0
    assert by["gemini-3.8-flash"]["price_check"] == "not_readable" and by["gemini-3.8-flash"]["official_input_per_mtok"] is None
    assert by["claude-opus-5-5"]["price_check"] == "other_host" and by["claude-opus-5-5"]["pricing_url"] is None
    assert by["llama-3.1-70b"]["price_check"] == "other_host"
    assert by["my-local-model"]["price_check"] == "not_checked" and by["my-local-model"]["catalog_source"] == "Entered by hand"
    assert all(r["kind"] == "api_model" for r in by.values())
    assert all(r["catalog_synced_at"] is not None for r in by.values())  # when the catalog last confirmed each price

    assert body["catalog"]["source"] == off.CATALOG_SOURCE and body["catalog"]["last_synced_at"] is not None
    assert {s["source_id"]: s["status"] for s in body["official_sources"]} == {"anthropic": "OK", "google": "OK", "openai": "OK"}
    assert "Cursor or Copilot" in body["kind_note"] and "not API endpoints" in body["kind_note"]


async def test_before_any_page_has_been_read_nothing_is_called_confirmed(client, session):
    _, key = await create_project(session, "proj1")
    await seed_catalog(session)
    body = (await client.get("/v1/models", headers={"X-API-Key": key})).json()
    assert body["official_sources"] == []
    assert {m["reference"]["price_check"] for m in body["items"]} <= {"not_checked", "other_host"}
    luna = next(m for m in body["items"] if m["model"] == "gpt-6-luna")["reference"]
    assert luna["price_checked_at"] is None and luna["official_input_per_mtok"] is None and "not been read yet" in luna["price_check_note"]


async def test_an_old_reading_is_flagged_in_the_api(client, session):
    _, key = await create_project(session, "proj1")
    await seed_catalog(session)

    async def fetch(url):
        return page("openai")

    await off.sync_official_prices(session, now=datetime.now(UTC) - timedelta(days=10), fetch=fetch, sources=(off.BY_PROVIDER["openai"],))
    body = (await client.get("/v1/models", headers={"X-API-Key": key})).json()
    luna = next(m for m in body["items"] if m["model"] == "gpt-6-luna")["reference"]
    assert luna["price_check"] == "confirmed" and luna["price_check_stale"] is True
    assert body["official_sources"][0]["stale"] is True


async def test_no_benchmark_score_rank_or_sponsorship_appears_anywhere_in_the_catalog_answer(client, session):
    _, key = await create_project(session, "proj1")
    await seed_catalog(session)
    raw = (await client.get("/v1/models", headers={"X-API-Key": key})).text.lower()
    assert not re.search(r"benchmark|leaderboard|\belo\b|\"rank|\"score|affiliate|sponsor|recommended|best model", raw)


async def test_the_catalog_needs_a_key(client):
    assert (await client.get("/v1/models")).status_code in (401, 403)
