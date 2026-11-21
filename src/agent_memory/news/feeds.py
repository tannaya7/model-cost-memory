"""The AI news sources, and reading one feed (RSS 2.0 or Atom) into plain items.

Feeds are fixed here, chosen by the operator, never supplied by a user, so the server only ever fetches
these addresses. A feed is untrusted input all the same:

- XML is parsed with defusedxml, which refuses entity expansion ("billion laughs") and external entities.
- A response over MAX_BYTES is refused, and every request has a timeout.
- Summaries are reduced to plain text (tags stripped, entities decoded, whitespace collapsed, trimmed), so
  the web app never renders a feed's HTML.
- Only http(s) links are kept, so a `javascript:` link can never reach a page.
"""

from __future__ import annotations

import hashlib
import html
import re
from dataclasses import dataclass
from datetime import UTC, datetime
from email.utils import parsedate_to_datetime

import httpx
from defusedxml import ElementTree

MAX_BYTES = 3_000_000
TIMEOUT_SECONDS = 15
MAX_ITEMS_PER_FEED = 30
SUMMARY_CHARS = 400
USER_AGENT = "model-cost-memory-news/1.0 (+https://github.com/tannaya7/model-cost-memory)"


@dataclass(frozen=True)
class Feed:
    source: str  # shown on each card
    url: str
    kind: str  # "lab": a model maker's own announcements; "press": AI reporting; "community"


# Checked reachable on 13 Nov 2026. Anthropic publishes no feed; Simon Willison and Hacker News cover it.
FEEDS: tuple[Feed, ...] = (
    Feed("OpenAI", "https://openai.com/news/rss.xml", "lab"),
    Feed("Google AI", "https://blog.google/technology/ai/rss/", "lab"),
    Feed("Google DeepMind", "https://deepmind.google/blog/rss.xml", "lab"),
    Feed("Hugging Face", "https://huggingface.co/blog/feed.xml", "lab"),
    Feed("Simon Willison", "https://simonwillison.net/atom/everything/", "community"),
    Feed("Hacker News", "https://hnrss.org/newest?q=LLM&points=150", "community"),
    Feed("The Verge", "https://www.theverge.com/rss/ai-artificial-intelligence/index.xml", "press"),
    Feed("TechCrunch", "https://techcrunch.com/category/artificial-intelligence/feed/", "press"),
)


@dataclass(frozen=True)
class Item:
    item_id: str
    source: str
    kind: str
    title: str
    link: str
    summary: str
    published_at: datetime


_TAG = re.compile(r"<[^>]+>")
_SPACE = re.compile(r"\s+")
_BEFORE_PUNCT = re.compile(r"\s+([.,;:!?)])")
_ATOM = "{http://www.w3.org/2005/Atom}"


def plain_text(value: str | None, limit: int = SUMMARY_CHARS) -> str:
    """Feed HTML (often escaped twice) as one line of plain text, cut at a word near `limit`."""
    text = value or ""
    for _ in range(2):  # descriptions are frequently entity-encoded HTML
        text = html.unescape(_TAG.sub(" ", text))
    text = _SPACE.sub(" ", _TAG.sub(" ", text)).strip()
    text = _BEFORE_PUNCT.sub(r"\1", text)  # "on <em>latency</em>." left "on latency ."
    if len(text) > limit:
        text = text[:limit].rsplit(" ", 1)[0].rstrip(",;:.") + "…"
    return text


def safe_link(value: str | None) -> str | None:
    link = (value or "").strip()
    return link if link.lower().startswith(("https://", "http://")) else None


def _date(value: str | None) -> datetime | None:
    if not value:
        return None
    value = value.strip()
    try:
        parsed = parsedate_to_datetime(value)  # RSS: RFC 822
    except (TypeError, ValueError):
        try:
            parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))  # Atom: RFC 3339
        except ValueError:
            return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=UTC)


def _text(node, *names: str) -> str | None:
    for name in names:
        found = node.find(name)
        if found is not None and (found.text or "").strip():
            return found.text
    return None


def parse(feed: Feed, body: bytes, *, now: datetime | None = None) -> list[Item]:
    """The newest items of one feed. Items without a title or a safe link are skipped; an item without a
    date counts as fetched now."""
    now = now or datetime.now(UTC)
    root = ElementTree.fromstring(body)
    entries = root.findall("./channel/item") or root.findall(f"{_ATOM}entry")
    items: list[Item] = []
    for entry in entries[:MAX_ITEMS_PER_FEED]:
        if entry.tag == f"{_ATOM}entry":
            links = entry.findall(f"{_ATOM}link")
            href = next((a.get("href") for a in links if a.get("rel", "alternate") == "alternate"), None)
            link = safe_link(href or (links[0].get("href") if links else None))
            title = _text(entry, f"{_ATOM}title")
            summary = _text(entry, f"{_ATOM}summary", f"{_ATOM}content")
            published = _date(_text(entry, f"{_ATOM}published", f"{_ATOM}updated"))
        else:
            link = safe_link(_text(entry, "link"))
            title = _text(entry, "title")
            summary = _text(entry, "description")
            published = _date(_text(entry, "pubDate", "{http://purl.org/dc/elements/1.1/}date"))
        title = plain_text(title, 300)
        if not title or not link:
            continue
        items.append(Item(
            item_id=hashlib.sha256(link.encode()).hexdigest()[:32], source=feed.source, kind=feed.kind,
            title=title, link=link, summary=plain_text(summary), published_at=min(published or now, now),
        ))
    return items


async def fetch(client: httpx.AsyncClient, feed: Feed, *, now: datetime | None = None) -> list[Item]:
    """Download and parse one feed; raises on a network error, an oversized body or broken XML."""
    async with client.stream("GET", feed.url) as response:
        response.raise_for_status()
        body = bytearray()
        async for chunk in response.aiter_bytes():
            body += chunk
            if len(body) > MAX_BYTES:
                raise ValueError(f"{feed.source}: feed larger than {MAX_BYTES} bytes")
    return parse(feed, bytes(body), now=now)
