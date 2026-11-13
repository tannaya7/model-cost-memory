"""AI news: feeds parsed safely into plain text, refreshed without one bad feed stopping the rest, and
stories that name a project's models marked. No real network calls."""

import uuid
from datetime import UTC, datetime, timedelta

import httpx
import pytest
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import async_sessionmaker

from agent_memory.heartbeat import record
from agent_memory.models import Job, NewsItem, Project, Run
from agent_memory.news import feeds as feeds_module
from agent_memory.news.feeds import Feed, parse, plain_text
from agent_memory.news.service import JOB, mentions, refresh
from agent_memory.security import generate_key, hash_key

NOW = datetime(2026, 11, 13, 12, tzinfo=UTC)
LAB = Feed("Acme Labs", "https://acme.example/rss.xml", "lab")
BLOG = Feed("Some Blog", "https://blog.example/atom.xml", "community")

RSS = b"""<?xml version="1.0"?>
<rss version="2.0"><channel><title>Acme</title>
<item><title>Gemini 3.5 Flash gets cheaper</title><link>https://acme.example/flash</link>
  <description>&lt;p&gt;Prices drop &lt;b&gt;40%&lt;/b&gt; &amp;amp; more.&lt;/p&gt;</description>
  <pubDate>Thu, 12 Nov 2026 09:30:00 GMT</pubDate></item>
<item><title>Sneaky</title><link>javascript:alert(1)</link><description>x</description></item>
<item><title>No date given</title><link>https://acme.example/undated</link></item>
<item><title></title><link>https://acme.example/untitled</link></item>
</channel></rss>"""

ATOM = b"""<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom"><title>Blog</title>
<entry><title>Claude Haiku 5.5 in practice</title>
  <link rel="alternate" href="https://blog.example/haiku"/><link rel="self" href="https://blog.example/haiku.atom"/>
  <published>2026-11-11T08:00:00Z</published><summary type="html">Notes on &lt;em&gt;latency&lt;/em&gt;.</summary></entry>
</feed>"""

BOMB = b"""<?xml version="1.0"?>
<!DOCTYPE lolz [<!ENTITY lol "lol"><!ENTITY lol2 "&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;">]>
<rss><channel><item><title>&lol2;</title><link>https://x.example</link></item></channel></rss>"""


def test_an_rss_feed_becomes_plain_text_items_with_safe_links():
    items = parse(LAB, RSS, now=NOW)
    assert [i.title for i in items] == ["Gemini 3.5 Flash gets cheaper", "No date given"]
    first = items[0]
    assert first.summary == "Prices drop 40% & more."  # tags gone, entities decoded, no HTML left
    assert first.link == "https://acme.example/flash" and first.source == "Acme Labs" and first.kind == "lab"
    assert first.published_at == datetime(2026, 11, 12, 9, 30, tzinfo=UTC)
    assert items[1].published_at == NOW  # an undated item counts as just fetched


def test_an_atom_feed_uses_the_alternate_link():
    [item] = parse(BLOG, ATOM, now=NOW)
    assert item.link == "https://blog.example/haiku" and item.summary == "Notes on latency."
    assert item.published_at == datetime(2026, 11, 11, 8, tzinfo=UTC)


def test_an_xml_bomb_is_refused():
    with pytest.raises(Exception, match="(?i)entit"):
        parse(LAB, BOMB, now=NOW)


def test_long_summaries_are_cut_at_a_word():
    text = plain_text("word " * 200)
    assert len(text) <= 401 and text.endswith("…") and not text.endswith(" …")


@pytest.mark.parametrize(("text", "model", "expected"), [
    ("Gemini 3.5 Flash gets cheaper", "gemini-3.5-flash", True),
    ("Claude Haiku 5.5 in practice", "claude-haiku-5-5", True),
    ("What GPT-5 mini is good at", "gpt-5-mini", True),
    ("Gemini 3.5 Pro arrives", "gemini-3.5-flash", False),
    ("Gemini news roundup", "gemini-3.5-flash", False),
    ("Llama everywhere", "llama", False),  # a one-word name is too broad to mark a story
])
def test_a_story_names_a_model_only_by_its_full_name(text, model, expected):
    assert mentions(text, model) is expected


@pytest.fixture
def sessions(engine):
    return async_sessionmaker(engine, expire_on_commit=False)


def _transport(responses: dict[str, httpx.Response]):
    return httpx.MockTransport(lambda request: responses.get(str(request.url), httpx.Response(404)))


async def test_one_failing_feed_does_not_stop_the_others(sessions, session):
    transport = _transport({LAB.url: httpx.Response(200, content=RSS), BLOG.url: httpx.Response(503)})
    result = await refresh(sessions, feeds=(LAB, BLOG), transport=transport, now=NOW)
    assert result.refreshed and result.added == 2 and result.failed == ["Some Blog"]
    again = await refresh(sessions, feeds=(LAB, BLOG), transport=transport, now=NOW)
    assert again.added == 0  # the same stories are stored once


async def test_old_stories_are_dropped_and_a_dead_refresh_is_not_a_success(sessions, session):
    ok = _transport({LAB.url: httpx.Response(200, content=RSS)})
    await refresh(sessions, feeds=(LAB,), transport=ok, now=NOW)
    await refresh(sessions, feeds=(LAB,), transport=_transport({}), now=NOW + timedelta(days=40))
    assert (await session.execute(select(func.count()).select_from(NewsItem))).scalar_one() == 0
    dead = await refresh(sessions, feeds=(LAB,), transport=_transport({}), now=NOW + timedelta(days=40))
    assert dead.refreshed is False


async def test_an_oversized_feed_is_refused(sessions, monkeypatch):
    monkeypatch.setattr(feeds_module, "MAX_BYTES", 100)
    result = await refresh(sessions, feeds=(LAB,), transport=_transport({LAB.url: httpx.Response(200, content=RSS)}),
                           now=NOW)
    assert result.failed == ["Acme Labs"] and result.added == 0


@pytest.fixture
async def project_key(session, sessions):
    key = generate_key()
    session.add(Project(project_id="acme", api_key_hash=hash_key(key)))
    await session.flush()
    job = Job(project_id="acme", name="invoice", check_kind="LATE_LABEL", check_config={})
    session.add(job)
    await session.flush()
    session.add(Run(run_id=uuid.uuid4(), job_id=job.job_id, project_id="acme", prompt="p", prompt_hash="h",
                    model="gemini-3.5-flash", model_version="gemini-3.5-flash-001"))
    await session.commit()
    transport = _transport({LAB.url: httpx.Response(200, content=RSS), BLOG.url: httpx.Response(200, content=ATOM)})
    await refresh(sessions, feeds=(LAB, BLOG), transport=transport)
    return key


async def test_the_news_marks_stories_that_name_the_projects_models(client, project_key):
    headers = {"X-API-Key": project_key}
    body = (await client.get("/v1/news", headers=headers)).json()
    assert body["your_models"] == ["gemini-3.5-flash"]
    by_title = {i["title"]: i for i in body["items"]}
    assert by_title["Gemini 3.5 Flash gets cheaper"]["affects"] == ["gemini-3.5-flash"]
    assert by_title["Claude Haiku 5.5 in practice"]["affects"] == []
    assert body["updated_at"] and body["next_refresh_at"] and len(body["sources"]) == len(feeds_module.FEEDS)

    mine = (await client.get("/v1/news", headers=headers, params={"mine": "true"})).json()["items"]
    assert [i["title"] for i in mine] == ["Gemini 3.5 Flash gets cheaper"]
    blog = (await client.get("/v1/news", headers=headers, params={"source": "Some Blog"})).json()["items"]
    assert [i["source"] for i in blog] == ["Some Blog"]


async def test_a_refresh_soon_after_the_last_one_fetches_nothing(client, project_key, sessions):
    await record(sessions, JOB, now=datetime.now(UTC))
    answer = (await client.post("/v1/news/refresh", headers={"X-API-Key": project_key})).json()
    assert answer["refreshed"] is False and answer["added"] == 0 and answer["next_refresh_at"]


async def test_the_news_needs_a_project_key(client):
    assert (await client.get("/v1/news")).status_code == 401


async def test_asking_about_one_model_returns_only_its_stories(client, project_key):
    headers = {"X-API-Key": project_key}
    body = (await client.get("/v1/news", headers=headers, params={"model": "claude-haiku-5-5"})).json()
    assert [i["title"] for i in body["items"]] == ["Claude Haiku 5.5 in practice"]
    assert body["your_models"] == ["claude-haiku-5-5"]  # matched against the model asked about, not the project's
    assert body["items"][0]["affects"] == ["claude-haiku-5-5"]


async def test_asking_about_a_job_uses_that_jobs_models(client, project_key):
    headers = {"X-API-Key": project_key}
    body = (await client.get("/v1/news", headers=headers, params={"job": "invoice"})).json()
    assert [i["title"] for i in body["items"]] == ["Gemini 3.5 Flash gets cheaper"]
    assert (await client.get("/v1/news", headers=headers, params={"job": "nope"})).status_code == 404


async def test_a_time_window_keeps_to_stories_from_then(client, project_key):
    headers = {"X-API-Key": project_key}
    window = {"model": "gemini-3.5-flash", "since": "2026-11-12T00:00:00Z", "until": "2026-11-12T23:59:59Z"}
    assert len((await client.get("/v1/news", headers=headers, params=window)).json()["items"]) == 1
    later = {**window, "since": "2026-11-13T00:00:00Z", "until": "2026-11-14T00:00:00Z"}
    assert (await client.get("/v1/news", headers=headers, params=later)).json()["items"] == []
