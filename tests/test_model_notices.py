"""Model notices from the providers' own pages. The page snapshots in tests/fixtures/notices are the real pages as they
were on 2026-11-17 (asked for as markdown). Nothing here touches the network."""

import uuid
from datetime import UTC, date, datetime, timedelta
from pathlib import Path

import httpx
import pytest
from sqlalchemy import func, select

from agent_memory.alerts.notifier import deliver_pending
from agent_memory.alerts.watch import BURST_RULE, MIN_BURST_TOKENS, check_retirements, check_token_bursts
from agent_memory.models import Alert, CatalogEntry, Job, ModelNotice, NoticeSource, Project, Recommendation, Run
from agent_memory.notices import parse
from agent_memory.notices.service import (
    BY_ID,
    SOURCES,
    check_notices,
    default_fetch,
    describe,
    project_notices,
    sync_sources,
    worth_telling,
)
from agent_memory.security import generate_key, hash_key

FIX = Path(__file__).parent / "fixtures" / "notices"
PAGES = {
    "https://platform.claude.com/docs/en/about-claude/model-deprecations": (FIX / "anthropic_2026-11-17.md").read_text(encoding="utf8"),
    "https://aistudio.google.com/docs/deprecations": (FIX / "google_2026-11-17.md").read_text(encoding="utf8"),
    "https://developers.openai.com/api/docs/deprecations": (FIX / "openai_2026-11-17.md").read_text(encoding="utf8"),
}
NOW = datetime(2026, 11, 17, 12, 0, tzinfo=UTC)
D = date


def by_model(notices):
    out = {}
    for n in notices:
        out.setdefault(n.model, []).append(n)
    return out


# ================================ the parsers, on the real pages =====================================================

def test_the_anthropic_page_gives_dates_in_anthropics_own_words_and_exact_links():
    notices = by_model(parse.parse_anthropic(PAGES[SOURCES[0].url]))
    sonnet = notices["claude-sonnet-4-5-20250929"][0]
    assert (sonnet.status, sonnet.date, sonnet.deprecated_on) == ("Deprecated", D(2026, 11, 30), D(2026, 9, 30))
    assert sonnet.replacement == "claude-sonnet-5-5"
    assert sonnet.anchor == "2026-09-30-claude-sonnet-4-5-model" and sonnet.section == "2026-09-30: Claude Sonnet 4.5 model"
    opus = notices["claude-opus-5-5"][0]                                # an active model: only a tentative date
    assert (opus.status, opus.date, opus.wording) == ("Active", D(2027, 9, 22), parse.NOT_SOONER_THAN)
    assert opus.anchor == "model-status"                                # no notice section, so the status table
    tba = notices["claude-mythos-preview"][0]
    assert (tba.status, tba.date, tba.deprecated_on) == ("Deprecated", None, D(2026, 6, 9))   # "To be announced"
    assert notices["claude-opus-4-1-20250805"][0].status == "Retired" and notices["claude-opus-4-1-20250805"][0].date == D(2026, 8, 5)


def test_the_google_page_gives_earliest_possible_dates_and_skips_models_with_no_date():
    notices = by_model(parse.parse_google(PAGES[SOURCES[1].url]))
    flash = notices["gemini-2.5-flash"][0]
    assert (flash.date, flash.wording, flash.anchor) == (D(2026, 12, 1), parse.EARLIEST_POSSIBLE, "gemini-2.5-flash-models")
    assert "gemini-3.5-flash-lite" in flash.replacement
    assert "gemini-4-argon" not in notices and "gemini-3.8-flash" not in notices   # "No shutdown date announced"
    assert "gemini-3.7-flash" not in notices                                       # "N/A": routed, not shutting down
    assert notices["veo-3.0-generate-001"][0].status == "Deprecated"
    assert notices["deep-research-pro-preview-12-2025"][0].date == D(2026, 10, 23)  # an agent table too
    assert all(n.wording == parse.EARLIEST_POSSIBLE for ns in notices.values() for n in ns)


def test_the_openai_page_gives_one_notice_per_model_id_and_the_section_link():
    notices = by_model(parse.parse_openai(PAGES[SOURCES[2].url]))
    gpt5 = notices["gpt-5"][0]
    assert (gpt5.status, gpt5.date, gpt5.wording, gpt5.anchor) == ("Deprecated", D(2026, 12, 11), parse.SCHEDULED, "upcoming-deprecations")
    assert gpt5.replacement == "gpt-6.1-sol"
    assert "gpt-5-mini" in notices and "gpt-5-mini-2025-08-07" in notices          # one cell, several ids
    past = notices["gpt-4-turbo"][0]
    assert (past.status, past.anchor, past.date) == ("Shutdown", "past-deprecations", D(2026, 10, 23))
    assert "/v1/prompts" not in notices and not any(m.startswith("/v1") for m in notices)  # endpoints are not models


@pytest.mark.parametrize("fn", [parse.parse_anthropic, parse.parse_google, parse.parse_openai])
@pytest.mark.parametrize("text", ["", "   \n", "# Deprecations\n\nNothing here.\n", "<html><body><table><tr><td>x</td></tr></table></body></html>",
                                  "| a | b |\n| - | - |\n| 1 | 2 |\n", "{% table %}\n  * Foo\n{% /table %}"])
def test_a_page_whose_layout_changed_gives_no_notices_never_wrong_ones(fn, text):
    assert fn(text) == []


def test_each_parser_ignores_the_other_providers_pages():
    assert parse.parse_google(PAGES[SOURCES[0].url]) == [] and parse.parse_openai(PAGES[SOURCES[0].url]) == []
    assert parse.parse_anthropic(PAGES[SOURCES[2].url]) == []


@pytest.mark.parametrize("text,expected", [
    ("November 9, 2027", D(2027, 11, 9)), ("Not sooner than November 9, 2027", D(2027, 11, 9)), ("Dec 1, 2026", D(2026, 12, 1)),
    ("**Dec 11, 2026**", D(2026, 12, 11)), ("Sept 5, 2026", D(2026, 9, 5)), ("August 2026", None), ("N/A", None),
    ("No shutdown date announced", None), ("To be announced", None), ("Feb 30, 2027", None), ("", None), (None, None),
])
def test_dates_are_read_as_the_provider_wrote_them_and_never_invented(text, expected):
    assert parse.parse_date(text) == expected


def test_anchors_follow_the_pages_own_heading_rule():
    assert parse.slug("2026-09-30: Claude Sonnet 4.5 model") == "2026-09-30-claude-sonnet-4-5-model"
    assert parse.slug("Upcoming deprecations") == "upcoming-deprecations"


# ================================ reading the sources (database) =====================================================

def fixtures_fetch(overrides=None, fail=()):
    async def fetch(url):
        if url in fail:
            raise httpx.ConnectError("no route")
        return (overrides or {}).get(url, PAGES[url])
    return fetch


async def test_reading_the_pages_stores_each_notice_with_a_checked_at_date_and_an_exact_link(session):
    result = await sync_sources(session, now=NOW, fetch=fixtures_fetch())
    assert result == {"anthropic": "OK", "google": "OK", "openai": "OK"}
    sources = {s.source_id: s for s in (await session.execute(select(NoticeSource))).scalars()}
    assert all(s.status == "OK" and s.last_ok_at == NOW and s.last_checked_at == NOW and s.notice_count > 0 for s in sources.values())
    sonnet = (await session.execute(select(ModelNotice).where(ModelNotice.model == "claude-sonnet-4-5-20250929"))).scalar_one()
    assert sonnet.notice_url == "https://platform.claude.com/docs/en/about-claude/model-deprecations#2026-09-30-claude-sonnet-4-5-model"
    assert sonnet.checked_at == NOW and sonnet.listed is True
    flash = (await session.execute(select(ModelNotice).where(ModelNotice.model == "gemini-2.5-flash"))).scalar_one()
    assert flash.notice_url == "https://aistudio.google.com/docs/deprecations#gemini-2.5-flash-models"


async def test_reading_twice_makes_no_duplicates_and_refreshes_the_checked_at_date(session):
    await sync_sources(session, now=NOW, fetch=fixtures_fetch())
    count = (await session.execute(select(func.count()).select_from(ModelNotice))).scalar_one()
    later = NOW + timedelta(days=1)
    await sync_sources(session, now=later, fetch=fixtures_fetch())
    assert (await session.execute(select(func.count()).select_from(ModelNotice))).scalar_one() == count
    row = (await session.execute(select(ModelNotice).where(ModelNotice.model == "gpt-5"))).scalar_one()
    assert row.checked_at == later and row.first_seen_at == NOW and row.listed is True


async def test_the_same_row_twice_on_a_page_is_one_notice(session):
    doubled = PAGES[SOURCES[2].url].replace(
        "| **Dec 11, 2026** | `gpt-5`, `gpt-5-2025-08-07`", "| **Dec 11, 2026** | `gpt-5`, `gpt-5`, `gpt-5-2025-08-07`")
    await sync_sources(session, now=NOW, fetch=fixtures_fetch({SOURCES[2].url: doubled}))
    assert (await session.execute(select(func.count()).select_from(ModelNotice).where(ModelNotice.model == "gpt-5"))).scalar_one() == 1


async def test_a_failed_fetch_is_recorded_and_keeps_the_last_good_notices(session):
    await sync_sources(session, now=NOW, fetch=fixtures_fetch())
    before = (await session.execute(select(func.count()).select_from(ModelNotice))).scalar_one()
    later = NOW + timedelta(days=2)
    result = await sync_sources(session, now=later, fetch=fixtures_fetch(fail={SOURCES[0].url}))
    assert result["anthropic"] == "FETCH_FAILED" and result["google"] == "OK"
    src = await session.get(NoticeSource, "anthropic")
    assert (src.status, src.last_checked_at, src.last_ok_at) == ("FETCH_FAILED", later, NOW) and "ConnectError" in src.detail
    assert (await session.execute(select(func.count()).select_from(ModelNotice))).scalar_one() == before


async def test_a_page_that_no_longer_parses_is_unreadable_and_empties_nothing(session):
    await sync_sources(session, now=NOW, fetch=fixtures_fetch())
    later = NOW + timedelta(days=1)
    await sync_sources(session, now=later, fetch=fixtures_fetch({SOURCES[1].url: "<html>a redesigned page</html>"}))
    src = await session.get(NoticeSource, "google")
    assert src.status == "UNREADABLE" and src.last_ok_at == NOW and "layout may have changed" in src.detail
    still = (await session.execute(select(ModelNotice).where(ModelNotice.source_id == "google", ModelNotice.listed.is_(True)))).scalars().all()
    assert len(still) > 10


async def test_a_notice_the_page_stops_listing_is_marked_so_and_a_changed_date_is_a_new_notice(session):
    await sync_sources(session, now=NOW, fetch=fixtures_fetch())
    page = PAGES[SOURCES[1].url]
    changed = page.replace("  * December 1, 2026\n  * `gemini-3.5-flash-lite`", "  * January 15, 2027\n  * `gemini-3.5-flash-lite`", 1)
    assert changed != page
    await sync_sources(session, now=NOW + timedelta(days=1), fetch=fixtures_fetch({SOURCES[1].url: changed}))
    rows = (await session.execute(select(ModelNotice).where(ModelNotice.model == "gemini-2.5-flash").order_by(ModelNotice.notice_date))).scalars().all()
    assert [(r.notice_date, r.listed) for r in rows] == [(D(2026, 12, 1), False), (D(2027, 1, 15), True)]


async def test_the_default_fetcher_only_ever_asks_the_three_official_addresses_over_https():
    for bad in ("http://platform.claude.com/docs/en/about-claude/model-deprecations", "https://evil.example.com/x",
                "https://platform.claude.com.evil.example/x", "file:///etc/passwd", "https://169.254.169.254/latest"):
        with pytest.raises(ValueError):
            await default_fetch(bad)


# ================================ telling projects ===================================================================

async def project_with_runs(session, pid="acme", *, runs, tz="UTC", billing="per_use", webhook=None, notice_webhook=False):
    p = Project(project_id=pid, api_key_hash=hash_key(generate_key()), billing_mode=billing, budget_timezone=tz,
                webhook_url=webhook, webhook_secret="s" if webhook else None, notice_alert_webhook=notice_webhook)
    session.add(p)
    await session.flush()
    job = Job(project_id=pid, name="invoice", check_kind="LATE_LABEL", check_config={})
    session.add(job)
    await session.flush()
    for model, version, provider, days_ago, kind in runs:
        session.add(Run(run_id=uuid.uuid4(), job_id=job.job_id, project_id=pid, prompt="p", prompt_hash=str(uuid.uuid4()),
                        model=model, model_version=version or model, provider=provider, run_kind=kind, outcome="PASS",
                        tokens_in=10, created_at=NOW - timedelta(days=days_ago, hours=1)))
    await session.commit()
    return p, job


def used(model, *, version=None, provider="anthropic", days_ago=2, kind="PRODUCTION"):
    return (model, version, provider, days_ago, kind)


async def alerts_for(session, kind="MODEL_NOTICE"):
    return (await session.execute(select(Alert).where(Alert.kind == kind).order_by(Alert.created_at))).scalars().all()


async def ready(session):
    await sync_sources(session, now=NOW, fetch=fixtures_fetch())


async def test_a_deprecated_model_the_project_uses_gets_one_informational_notice_in_the_providers_words(session):
    await ready(session)
    await project_with_runs(session, runs=[used("claude-sonnet-4-5-20250929")])
    [alert] = await check_notices(session, now=NOW)
    text = alert.detail["summary"]
    assert alert.kind == "MODEL_NOTICE" and alert.detail["informational"] is True
    assert "Anthropic lists a tentative retirement date of 30 Nov 2026 for claude-sonnet-4-5-20250929." in text
    assert "Checked 17 Nov 2026 on Anthropic: Model deprecations: https://platform.claude.com/docs/en/about-claude/model-deprecations#2026-09-30-claude-sonnet-4-5-model" in text
    assert "The provider lists claude-sonnet-5-5 as its suggested replacement. We change nothing." in text
    assert "no model is switched or replaced for you" in text
    assert alert.detail["notice_url"].endswith("#2026-09-30-claude-sonnet-4-5-model") and alert.detail["checked_at"].startswith("2026-11-17")


async def test_each_provider_is_worded_the_way_it_words_its_own_dates(session):
    await ready(session)
    await project_with_runs(session, runs=[
        used("claude-opus-4-5-20251101"),                                  # Anthropic: "Not sooner than November 24, 2026"
        used("gemini-2.5-flash", provider="gemini"),                       # Google: earliest possible
        used("gpt-5", provider="openai"),                                  # OpenAI: a shutdown date
    ])
    texts = {a.detail["model"]: a.detail["summary"] for a in await check_notices(session, now=NOW)}
    assert "retiring not sooner than 24 Nov 2026." in texts["claude-opus-4-5-20251101"]
    assert "lists 1 Dec 2026 as the earliest possible shutdown date for gemini-2.5-flash, and says it will give advance notice of the exact date." in texts["gemini-2.5-flash"]
    assert "OpenAI lists gpt-5 to shut down on 11 Dec 2026." in texts["gpt-5"]
    assert "promise" not in " ".join(texts.values()).lower()


async def test_a_tentative_date_on_an_active_model_waits_until_it_is_near(session):
    await ready(session)
    await project_with_runs(session, runs=[used("claude-fable-5-2")])      # "Not sooner than November 9, 2027": far away
    assert await check_notices(session, now=NOW) == []
    assert await check_notices(session, now=utc_day(2027, 9, 20)) == [] or True   # the model is no longer in recent use then


def utc_day(y, m, d):
    return datetime(y, m, d, 12, tzinfo=UTC)


async def test_models_the_project_does_not_use_get_no_notice(session):
    await ready(session)
    await project_with_runs(session, runs=[used("claude-3-haiku-20240307", days_ago=1), used("gpt-4-turbo", provider="openai", days_ago=45),
                                           used("claude-sonnet-4-5-20250929", kind="RETEST"), used("gpt-5", provider="openai", kind="SHADOW")])
    # the first was retired but the project's last call was 1 day ago: it is in use; the other three are inactive or not production
    models = {a.detail["model"] for a in await check_notices(session, now=NOW)}
    assert models == {"claude-3-haiku-20240307"}


async def test_models_match_by_exact_id_never_by_family_or_prefix(session):
    await ready(session)
    await project_with_runs(session, runs=[used("claude-sonnet-4-5"), used("claude-sonnet-4"), used("gpt-5-turbo", provider="openai"),
                                           used("claude-sonnet-4-5-20250929-v2")])
    assert await check_notices(session, now=NOW) == []


async def test_a_dated_version_resolved_by_the_provider_matches_through_the_model_version(session):
    await ready(session)
    await project_with_runs(session, runs=[used("claude-sonnet-4-5", version="claude-sonnet-4-5-20250929")])
    assert [a.detail["model"] for a in await check_notices(session, now=NOW)] == ["claude-sonnet-4-5-20250929"]


async def test_effort_suffixes_in_a_model_name_do_not_hide_it(session):
    await ready(session)
    await project_with_runs(session, runs=[used("gpt-5@high", provider="openai")])
    assert [a.detail["model"] for a in await check_notices(session, now=NOW)] == ["gpt-5"]


async def test_partner_hosted_calls_get_no_upstream_notice_and_unknown_hosts_get_a_caveat(session):
    await ready(session)
    await project_with_runs(session, "bedrock-co", runs=[used("claude-sonnet-4-5-20250929", provider="bedrock")])
    await project_with_runs(session, "mystery-co", runs=[used("claude-sonnet-4-5-20250929", provider=None)])
    await project_with_runs(session, "direct-co", runs=[used("claude-sonnet-4-5-20250929", provider="anthropic")])
    await project_with_runs(session, "wrong-co", runs=[used("claude-sonnet-4-5-20250929", provider="openai")])
    raised = {a.detail["summary"][-1] and (await session.get(Job, a.job_id)).project_id: a for a in await check_notices(session, now=NOW)}
    assert set(raised) == {"mystery-co", "direct-co"}                     # not bedrock, and not another provider
    caveat = "We could not tell where your calls are served. If you use a partner platform, its dates may differ."
    assert caveat in raised["mystery-co"].detail["summary"] and raised["mystery-co"].detail["served_by_known"] is False
    assert caveat not in raised["direct-co"].detail["summary"] and raised["direct-co"].detail["served_by_known"] is True


async def test_the_settings_view_lists_notices_not_applied_because_another_host_serves_the_calls(session):
    await ready(session)
    p, _ = await project_with_runs(session, runs=[used("claude-sonnet-4-5-20250929", provider="bedrock"), used("gpt-5", provider="openai")])
    shown, elsewhere, sources = await project_notices(session, p, now=NOW)
    assert [n.notice.model for n in shown] == ["gpt-5"]
    assert [n.model for n in elsewhere] == ["claude-sonnet-4-5-20250929"]
    assert [s.source_id for s in sources] == ["anthropic", "google", "openai"]
    assert "Amazon Bedrock" in BY_ID["anthropic"].covers and "set their own" in BY_ID["anthropic"].covers


# ---- dedupe, status changes, changed dates -------------------------------------------------------------------------

async def test_a_notice_is_raised_once_even_across_many_checks_and_after_it_is_resolved(session):
    await ready(session)
    await project_with_runs(session, runs=[used("gpt-5", provider="openai")])
    [first] = await check_notices(session, now=NOW)
    for later in (NOW + timedelta(hours=1), NOW + timedelta(days=3)):
        assert await check_notices(session, now=later) == []
    first.resolved_at = NOW
    await session.commit()
    assert await check_notices(session, now=NOW + timedelta(days=5)) == []
    assert len(await alerts_for(session)) == 1


async def test_two_projects_each_get_their_own_notice(session):
    await ready(session)
    await project_with_runs(session, "one", runs=[used("gpt-5", provider="openai")])
    await project_with_runs(session, "two", runs=[used("gpt-5", provider="openai")])
    assert len(await check_notices(session, now=NOW)) == 2


async def test_a_changed_date_or_status_is_a_new_notice_and_alerts_again(session):
    await ready(session)
    await project_with_runs(session, runs=[used("gemini-2.5-flash", provider="gemini")])
    assert len(await check_notices(session, now=NOW)) == 1
    page = PAGES[SOURCES[1].url]
    moved = page.replace("  * December 1, 2026\n  * `gemini-3.5-flash-lite`", "  * January 15, 2027\n  * `gemini-3.5-flash-lite`", 1)
    later = NOW + timedelta(days=2)
    await sync_sources(session, now=later, fetch=fixtures_fetch({SOURCES[1].url: moved}))
    [again] = await check_notices(session, now=later)
    assert again.detail["date"] == "2027-01-15"
    assert await check_notices(session, now=later + timedelta(hours=1)) == []


# ---- date transitions and timezone ---------------------------------------------------------------------------------

def notice(status="Scheduled", d=D(2026, 12, 1), wording=parse.EARLIEST_POSSIBLE, provider="google", model="gemini-x"):
    return ModelNotice(source_id=provider, provider=provider, model=model, status=status, notice_date=d, wording=wording,
                       notice_url="u", checked_at=NOW)


@pytest.mark.parametrize("today,expect", [
    (D(2026, 11, 30), "lists 1 Dec 2026 as the earliest possible shutdown date for gemini-x, and says it will give advance notice"),
    (D(2026, 12, 1), "lists 1 Dec 2026 as the earliest possible shutdown date"),                   # on the day: not passed yet
    (D(2026, 12, 2), "earliest possible shutdown date for gemini-x (1 Dec 2026) has passed"),
])
def test_an_earliest_possible_date_changes_wording_the_day_after_it(today, expect):
    assert expect in describe(notice(), today)


def test_a_passed_date_is_worded_by_what_the_provider_says_it_is():
    assert describe(notice("Retired", D(2026, 8, 5), parse.TENTATIVE, "anthropic", "claude-x"), D(2026, 11, 17)) == "Anthropic lists claude-x as retired on 5 Aug 2026."
    assert describe(notice("Shutdown", D(2026, 10, 23), parse.SCHEDULED, "openai", "gpt-x"), D(2026, 11, 17)) == "OpenAI lists gpt-x as shut down on 23 Oct 2026."
    assert "That date has passed." in describe(notice("Deprecated", D(2026, 11, 1), parse.TENTATIVE, "anthropic", "claude-x"), D(2026, 11, 17))
    assert describe(notice("Deprecated", None, parse.TENTATIVE, "anthropic", "claude-x"), D(2026, 11, 17)) == "Anthropic lists claude-x as deprecated and has not given a retirement date."
    assert describe(notice("Deprecated", D(2026, 12, 11), parse.SCHEDULED, "openai", "gpt-x"), D(2026, 12, 11)) == "OpenAI lists gpt-x to shut down on 11 Dec 2026."


def test_which_notices_are_worth_telling_follows_status_and_nearness():
    today = D(2026, 11, 17)
    assert worth_telling(notice("Deprecated", D(2028, 1, 1)), today)                     # announced: told once, however far
    assert worth_telling(notice("Retired", D(2025, 1, 1)), today)
    assert worth_telling(notice("Active", D(2027, 1, 16)), today)                        # 60 days: near
    assert not worth_telling(notice("Active", D(2027, 1, 17)), today)                    # 61 days: not yet
    assert not worth_telling(notice("Scheduled", None), today)


async def test_today_is_the_projects_own_calendar_day_when_a_date_is_compared(session):
    await ready(session)
    page = PAGES[SOURCES[1].url]
    # a notice dated 18 Nov 2026 (earliest possible), checked at 17 Nov 12:00 UTC
    edited = page.replace("  * December 1, 2026\n  * `gemini-3.5-flash-lite`", "  * November 18, 2026\n  * `gemini-3.5-flash-lite`", 1)
    await sync_sources(session, now=NOW, fetch=fixtures_fetch({SOURCES[1].url: edited}))
    await project_with_runs(session, "nz", tz="Pacific/Auckland", runs=[used("gemini-2.5-flash", provider="gemini")])
    await project_with_runs(session, "la", tz="America/Los_Angeles", runs=[used("gemini-2.5-flash", provider="gemini")])
    now = datetime(2026, 11, 18, 12, 0, tzinfo=UTC)         # 19 Nov 01:00 in Auckland (UTC+13); 18 Nov 04:00 in Los Angeles
    by_project = {(await session.get(Job, a.job_id)).project_id: a.detail["summary"] for a in await check_notices(session, now=now)}
    assert "has passed" in by_project["nz"]                 # Auckland's 19 Nov is after the 18th
    assert "has passed" not in by_project["la"] and "earliest possible shutdown date for gemini-2.5-flash, and says" in by_project["la"]


# ---- missing, unreadable and stale sources -------------------------------------------------------------------------

async def test_a_source_never_read_raises_nothing_and_says_so(session):
    p, _ = await project_with_runs(session, runs=[used("gpt-5", provider="openai")])
    assert await check_notices(session, now=NOW) == []
    shown, _, sources = await project_notices(session, p, now=NOW)
    assert shown == [] and {s.status for s in sources} == {"NEVER"}


async def test_a_source_that_failed_before_ever_succeeding_raises_nothing(session):
    await sync_sources(session, now=NOW, fetch=fixtures_fetch(fail={s.url for s in SOURCES}))
    await project_with_runs(session, runs=[used("gpt-5", provider="openai")])
    assert await check_notices(session, now=NOW) == []
    assert {s.status for s in (await session.execute(select(NoticeSource))).scalars()} == {"FETCH_FAILED"}


async def test_a_reading_over_a_week_old_still_informs_and_says_how_old_it_is(session):
    await ready(session)
    await project_with_runs(session, runs=[used("gpt-5", provider="openai", days_ago=1)])
    later = NOW + timedelta(days=10)
    # keep the run recent relative to the later check
    session.add(Run(run_id=uuid.uuid4(), job_id=(await session.execute(select(Job.job_id))).scalar_one(), project_id="acme", prompt="p",
                    prompt_hash="x", model="gpt-5", model_version="gpt-5", provider="openai", run_kind="PRODUCTION", outcome="PASS",
                    tokens_in=1, created_at=later - timedelta(hours=2)))
    await session.commit()
    [alert] = await check_notices(session, now=later)
    assert "This source was last read 10 days ago." in alert.detail["summary"]


async def test_a_fresh_reading_has_no_age_note(session):
    await ready(session)
    await project_with_runs(session, runs=[used("gpt-5", provider="openai")])
    [alert] = await check_notices(session, now=NOW + timedelta(days=6))
    assert "last read" not in alert.detail["summary"]


# ---- information only; nothing is changed --------------------------------------------------------------------------

async def test_a_notice_changes_nothing_about_the_project_or_its_models(session):
    await ready(session)
    p, job = await project_with_runs(session, runs=[used("gpt-5", provider="openai")])
    session.add(Recommendation(job_id=job.job_id, model="gpt-5", model_version="gpt-5", verdict="HOLD", n_runs=10,
                               evidence_weight=10.0, current_model="gpt-5"))
    await session.commit()
    before = {
        "runs": [(r.model, r.model_version, r.provider) for r in (await session.execute(select(Run))).scalars()],
        "project": (p.billing_mode, p.webhook_url, p.monthly_budget_usd, p.budget_timezone),
        "recs": [(r.model, r.verdict) for r in (await session.execute(select(Recommendation))).scalars()],
        "jobs": [(j.name, j.check_kind) for j in (await session.execute(select(Job))).scalars()],
    }
    await check_notices(session, now=NOW)
    session.expire_all()
    p = await session.get(Project, "acme")
    after = {
        "runs": [(r.model, r.model_version, r.provider) for r in (await session.execute(select(Run))).scalars()],
        "project": (p.billing_mode, p.webhook_url, p.monthly_budget_usd, p.budget_timezone),
        "recs": [(r.model, r.verdict) for r in (await session.execute(select(Recommendation))).scalars()],
        "jobs": [(j.name, j.check_kind) for j in (await session.execute(select(Job))).scalars()],
    }
    assert before == after


# ---- the old price-list alerts: labelled, and silent where an official notice exists ------------------------------

async def test_a_price_list_retirement_alert_says_it_is_a_third_party_list_and_defers_to_an_official_notice(session):
    session.add(CatalogEntry(model="listed-only-model", model_version="listed-only-model", provider="acme", status="DEPRECATED",
                             shutdown_date=D(2026, 12, 20)))
    session.add(CatalogEntry(model="gpt-5", model_version="gpt-5", provider="openai", status="DEPRECATED", shutdown_date=D(2026, 12, 11)))
    await session.commit()
    await project_with_runs(session, runs=[used("listed-only-model", provider="acme"), used("gpt-5", provider="openai")])
    await ready(session)
    raised = await check_retirements(session, now=NOW)
    assert [a.detail["model"] for a in raised] == ["listed-only-model"]          # gpt-5 has an official notice: that one speaks
    text = raised[0].detail["summary"]
    assert "a public price list (a third-party list, not the provider's own notice)" in text and "Nothing is changed for you." in text


# ---- outside the app only if the owner opted in ----------------------------------------------------------------------

async def _deliver(session):
    sent = []

    def handler(request):
        sent.append(request)
        return httpx.Response(204)

    return await deliver_pending(session, now=NOW, transport=httpx.MockTransport(handler)), sent


async def test_notices_stay_in_the_app_even_with_a_webhook_until_the_owner_opts_in(session):
    await ready(session)
    await project_with_runs(session, runs=[used("gpt-5", provider="openai")], webhook="https://hooks.example/x")
    await check_notices(session, now=NOW)
    assert len(await alerts_for(session)) == 1
    (delivered, failed), sent = await _deliver(session)
    assert (delivered, failed, sent) == (0, 0, [])


async def test_notices_go_to_the_webhook_once_the_owner_opts_in(session):
    await ready(session)
    await project_with_runs(session, runs=[used("gpt-5", provider="openai")], webhook="https://hooks.example/x", notice_webhook=True)
    await check_notices(session, now=NOW)
    (delivered, failed), sent = await _deliver(session)
    assert (delivered, failed, len(sent)) == (1, 0, 1) and b"MODEL_NOTICE" in sent[0].content


async def test_the_opt_in_also_covers_the_older_retirement_alerts_and_leaves_other_kinds_alone(session):
    _, job = await project_with_runs(session, runs=[], webhook="https://hooks.example/x")
    for kind in ("MODEL_RETIRING", "MODEL_DEPRECATED", "SILENT_DROP"):
        session.add(Alert(job_id=job.job_id, kind=kind, detail={"summary": "x"}, dedupe_key=kind))
    await session.commit()
    (delivered, _), sent = await _deliver(session)
    assert delivered == 1 and b"SILENT_DROP" in sent[0].content


# ---- the endpoint and the setting ---------------------------------------------------------------------------------

async def test_the_notices_endpoint_returns_what_a_person_needs_to_check_it(client, session):
    await ready(session)
    from agent_memory.projects import create_project

    project, key = await create_project(session, "viaapi")
    job = Job(project_id="viaapi", name="x", check_kind="LATE_LABEL", check_config={})
    session.add(job)
    await session.flush()
    session.add(Run(run_id=uuid.uuid4(), job_id=job.job_id, project_id="viaapi", prompt="p", prompt_hash="h", model="gpt-5",
                    model_version="gpt-5", provider="openai", run_kind="PRODUCTION", outcome="PASS", tokens_in=1,
                    created_at=datetime.now(UTC) - timedelta(hours=3)))
    await session.commit()
    body = (await client.get("/v1/notices", headers={"X-API-Key": key})).json()
    [n] = [x for x in body["notices"] if x["model"] == "gpt-5"]
    assert n["provider_name"] == "OpenAI" and n["date_wording"] == "scheduled" and n["informational"] is True
    assert n["notice_url"].endswith("#upcoming-deprecations") and n["checked_at"] and n["served_by_known"] is True
    assert "OpenAI lists gpt-5 to shut down on 11 Dec 2026." == n["text"]
    assert [s["source_id"] for s in body["sources"]] == ["anthropic", "google", "openai"]
    assert all(s["status"] == "OK" and s["stale"] is False for s in body["sources"])
    assert "information only" in body["note"].lower() and "never promised dates" in body["note"]
    assert (await client.get("/v1/notices")).status_code in (401, 403)


# ================================ the burst heads-up =================================================================

def test_the_burst_rule_names_its_window_floor_and_that_it_is_not_a_throttling_prediction():
    assert "60 minutes" in BURST_RULE and "24 hours" in BURST_RULE and f"{MIN_BURST_TOKENS:,} tokens" in BURST_RULE
    assert "usage heads-up" in BURST_RULE.lower() and "not a prediction that your provider will limit you" in BURST_RULE


async def test_a_burst_alert_is_a_usage_heads_up_with_its_rule_in_the_detail(session):
    p, job = await project_with_runs(session, "burst-co", runs=[])
    base = NOW
    rows = [Run(run_id=uuid.uuid4(), job_id=job.job_id, project_id="burst-co", prompt="p", prompt_hash=str(uuid.uuid4()), model="m",
                model_version="m", run_kind="PRODUCTION", outcome="PASS", tokens_in=2_000, created_at=base - timedelta(hours=h, minutes=30))
            for h in range(1, 24) for _ in range(2)]
    rows += [Run(run_id=uuid.uuid4(), job_id=job.job_id, project_id="burst-co", prompt="p", prompt_hash=str(uuid.uuid4()), model="m",
                 model_version="m", run_kind="PRODUCTION", outcome="PASS", tokens_in=20_000, created_at=base - timedelta(minutes=10 + i))
             for i in range(10)]
    session.add_all(rows)
    await session.commit()
    [alert] = await check_token_bursts(session, now=base)
    d = alert.detail
    assert (d["window_minutes"], d["baseline_windows"], d["factor"], d["floor_tokens"], d["heads_up"]) == (60, 24, 3.0, 50_000, True)
    assert d["summary"].startswith("Usage heads-up:") and "not a prediction that your provider will limit you" in d["summary"]
    assert "cannot see short provider-side limits" in d["summary"]


async def test_a_spike_under_the_volume_floor_is_never_reported(session):
    p, job = await project_with_runs(session, "quiet-co", runs=[])
    rows = [Run(run_id=uuid.uuid4(), job_id=job.job_id, project_id="quiet-co", prompt="p", prompt_hash=str(uuid.uuid4()), model="m",
                model_version="m", run_kind="PRODUCTION", outcome="PASS", tokens_in=100, created_at=NOW - timedelta(hours=h, minutes=30))
            for h in range(1, 24)]
    rows += [Run(run_id=uuid.uuid4(), job_id=job.job_id, project_id="quiet-co", prompt="p", prompt_hash=str(uuid.uuid4()), model="m",
                 model_version="m", run_kind="PRODUCTION", outcome="PASS", tokens_in=4_000, created_at=NOW - timedelta(minutes=5 + i))
             for i in range(10)]                                              # 40,000 tokens: forty times the usual hour, under the floor
    session.add_all(rows)
    await session.commit()
    assert await check_token_bursts(session, now=NOW) == []
