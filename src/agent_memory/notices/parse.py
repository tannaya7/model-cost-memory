"""Read the three providers' own deprecation pages into plain notices. Pure: text in, notices out.

Formats were checked against the live pages on 2026-11-17 by asking each for markdown
(`Accept: text/markdown`, which they answer directly):
  Anthropic  markdown pipe tables. "## Model status" lists every model with its state and a "Tentative retirement
             date" ("Not sooner than <date>", a plain date, or "To be announced"); "### <date>: <title>" sections under
             "## Deprecation history" give the notice, the retirement date and the recommended replacement.
  Google     "{% table %}" blocks under headings that carry an explicit id; "Shutdown date" is the earliest possible
             date ("No shutdown date announced" when there is none).
  OpenAI     markdown pipe tables under "## Upcoming deprecations" and "## Past deprecations" with a "Shutdown date".

A page that no longer parses gives NO notices, never wrong ones: the caller marks the source unreadable.
Dates are calendar dates as the provider wrote them; no time or timezone is invented.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import date, datetime

# How a provider words its date. These words are shown to the user, so they follow what the page itself says.
NOT_SOONER_THAN = "not_sooner_than"  # Anthropic: "Not sooner than November 9, 2027"
TENTATIVE = "tentative"  # Anthropic: a plain date under the heading "Tentative retirement date"
EARLIEST_POSSIBLE = "earliest_possible"  # Google: "the earliest possible dates on which a model might be retired"
SCHEDULED = "scheduled"  # OpenAI: "Shutdown date"


@dataclass(frozen=True)
class ParsedNotice:
    model: str  # the provider's own model id, lower-case
    status: str  # the provider's own word: Active, Deprecated, Retired, Scheduled, Shutdown ...
    date: date | None  # the date the provider lists, or None when it lists none
    wording: str
    deprecated_on: date | None = None
    replacement: str | None = None  # informational: what the provider lists, never acted on
    anchor: str | None = None  # the page section that holds this notice
    section: str | None = None  # its heading, for the person to recognise


_MONTHS = {m.lower(): i for i, m in enumerate(
    ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"], 1)}
_DATE = re.compile(r"\b([A-Za-z]{3,9})\.? (\d{1,2}),? (\d{4})\b")


def parse_date(text: str | None) -> date | None:
    """"November 9, 2027" or "Dec 1, 2026" -> a date. A month and year alone ("August 2026") is not a date: None."""
    if not text:
        return None
    m = _DATE.search(text)
    if not m:
        return None
    month = _MONTHS.get(m.group(1).lower()) or _MONTHS.get(next((k for k in _MONTHS if k.startswith(m.group(1).lower()[:3])), ""))
    if not month:
        return None
    try:
        return datetime(int(m.group(3)), month, int(m.group(2))).date()
    except ValueError:
        return None


def slug(heading: str) -> str:
    """The page's anchor for a heading: lower-case, every run of other characters becomes one hyphen
    ("2026-09-30: Claude Sonnet 4.5 model" -> "2026-09-30-claude-sonnet-4-5-model")."""
    return re.sub(r"[^a-z0-9]+", "-", heading.lower()).strip("-")


def _clean(cell: str) -> str:
    """A table cell as plain text: links keep their words, code ticks and bold marks go."""
    cell = re.sub(r"\[([^\]]*)\]\([^)]*\)", r"\1", cell)
    return re.sub(r"[`*]", "", cell).strip()


def _models(cell: str) -> list[str]:
    """Every model id in a cell: backticked ids first (OpenAI lists several), else the plain text."""
    ids = re.findall(r"`([^`]+)`", cell)
    if not ids:
        ids = [_clean(cell)] if _clean(cell) else []
    return [i.strip().lower() for i in ids if i.strip()]


def pipe_tables(text: str) -> list[tuple[str, list[str], list[list[str]]]]:
    """Every markdown pipe table: (the nearest heading above it, header cells, row cells)."""
    out: list[tuple[str, list[str], list[list[str]]]] = []
    heading = ""
    lines = text.splitlines()
    i = 0
    while i < len(lines):
        line = lines[i].strip()
        if line.startswith("#"):
            heading = line.lstrip("#").strip()
        if line.startswith("|") and i + 1 < len(lines) and re.match(r"^\|[\s:\-|]+\|?\s*$", lines[i + 1].strip()):
            header = [c.strip() for c in line.strip("|").split("|")]
            rows: list[list[str]] = []
            i += 2
            while i < len(lines) and lines[i].strip().startswith("|"):
                rows.append([c.strip() for c in lines[i].strip().strip("|").split("|")])
                i += 1
            out.append((heading, header, rows))
            continue
        i += 1
    return out


# ---------------------------------------------------------------- Anthropic

def parse_anthropic(text: str) -> list[ParsedNotice]:
    history: dict[str, tuple[str, str, str | None]] = {}  # model -> (anchor, heading, replacement)
    status_rows: list[list[str]] = []
    for heading, header, rows in pipe_tables(text):
        names = [h.lower() for h in header]
        if names[:1] == ["api model name"]:
            status_rows = rows
        elif names[:2] == ["retirement date", "deprecated model"]:
            for row in rows:
                for model in _models(row[1]):
                    history[model] = (slug(heading), heading, _clean(row[2]) if len(row) > 2 else None)
    out: list[ParsedNotice] = []
    for row in status_rows:
        if len(row) < 4:
            continue
        model, state = _clean(row[0]).lower(), _clean(row[1])
        deprecated_on, tentative = parse_date(row[2]), _clean(row[3])
        when = parse_date(tentative)
        if state == "Active" and when is None:
            continue  # nothing announced
        wording = NOT_SOONER_THAN if tentative.lower().startswith("not sooner than") else TENTATIVE
        anchor, section, replacement = history.get(model, ("model-status", "Model status", None))
        out.append(ParsedNotice(model=model, status=state, date=when, wording=wording, deprecated_on=deprecated_on,
                                replacement=replacement, anchor=anchor, section=section))
    return out


# ---------------------------------------------------------------- Google

_HEADING = re.compile(r"^(#{2,4})\s+(.*?)\s*(?:\{%\s*id=\"([^\"]+)\"\s*%\})?\s*$")


def _google_tables(text: str):
    """(heading, anchor, header cells, rows) for each {% table %} block. Cells are the "* " lines; "---" splits rows."""
    heading, anchor = "", None
    lines = text.splitlines()
    i = 0
    while i < len(lines):
        m = _HEADING.match(lines[i].strip())
        if m:
            heading, anchor = m.group(2).strip(), m.group(3)
        if lines[i].strip() == "{% table %}":
            rows: list[list[str]] = [[]]
            i += 1
            while i < len(lines) and lines[i].strip() != "{% /table %}":
                s = lines[i].strip()
                if s == "---":
                    rows.append([])
                elif s.startswith("*"):
                    rows[-1].append(s[1:].strip())
                i += 1
            rows = [r for r in rows if r]
            if rows:
                yield heading, anchor, rows[0], rows[1:]
        i += 1


def parse_google(text: str) -> list[ParsedNotice]:
    out: list[ParsedNotice] = []
    for heading, anchor, header, rows in _google_tables(text):
        names = [h.lower() for h in header]
        if len(names) < 3 or names[0] not in ("model", "agent") or names[2] != "shutdown date":
            continue
        shut_down_section = "deprecated" in heading.lower()
        for row in rows:
            if len(row) < 3:
                continue
            when = parse_date(row[2])
            if when is None:
                continue  # "No shutdown date announced" or "N/A": nothing to tell
            replacement = _clean(row[3]) if len(row) > 3 and _clean(row[3]) else None
            for model in _models(row[0]):
                out.append(ParsedNotice(model=model, status="Deprecated" if shut_down_section else "Scheduled",
                                        date=when, wording=EARLIEST_POSSIBLE, replacement=replacement, anchor=anchor,
                                        section=heading))
    return out


# ---------------------------------------------------------------- OpenAI

def parse_openai(text: str) -> list[ParsedNotice]:
    out: list[ParsedNotice] = []
    for heading, header, rows in pipe_tables(text):
        names = [h.lower() for h in header]
        if not names or names[0] != "shutdown date" or "affected model" not in " ".join(names[1:2]):
            continue
        upcoming = "upcoming" in heading.lower()
        for row in rows:
            if len(row) < 2:
                continue
            when = parse_date(row[0])
            if when is None:
                continue
            status = _clean(row[2]) if upcoming and len(row) > 2 else "Shutdown"
            replacement = _clean(row[3]) if upcoming and len(row) > 3 else (_clean(row[2]) if len(row) > 2 else None)
            for model in _models(row[1]):
                out.append(ParsedNotice(model=model, status=status or "Deprecated", date=when, wording=SCHEDULED,
                                        replacement=replacement or None, anchor=slug(heading), section=heading))
    return out
