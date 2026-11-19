"""Read a provider's own pricing page (as markdown) into the standard price of each model it lists.

The standard price is the headline list price per million tokens: input and output, text, no batch discount, no cache rate,
no long-context tier. A page that states a price in a way this cannot read with certainty gives NO price for that model and a
note saying why (for example a price that changes on a date, or one that differs by kind of input). Unknown is shown as
unknown: a guess would be worse than nothing. Each parser is checked against saved snapshots of the real pages
(tests/fixtures/prices/); when a provider redesigns its page the parser finds nothing and the source is shown as unreadable.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from decimal import Decimal, InvalidOperation

_MONEY = re.compile(r"\$\s*([0-9][0-9,]*(?:\.[0-9]+)?)")
_LINK = re.compile(r"\[([^\]]*)\]\([^)]*\)")
_TAG = re.compile(r"<[^>]+>")


@dataclass(frozen=True)
class OfficialPrice:
    model: str  # the id the provider's page gives (OpenAI, Google) or the id its display name maps to (Anthropic)
    input_per_mtok: Decimal | None
    output_per_mtok: Decimal | None
    note: str | None = None  # why a price is missing or how to read it


def _dec(text: str) -> Decimal | None:
    try:
        return Decimal(text.replace(",", ""))
    except InvalidOperation:
        return None


def _only_price(cell: str) -> Decimal | None:
    """The one dollar amount in a cell, or None when there is none or more than one (so which applies is not clear)."""
    found = _MONEY.findall(_TAG.sub("", cell))
    return _dec(found[0]) if len(found) == 1 else None


def _cells(line: str) -> list[str]:
    return [c.strip() for c in line.strip().strip("|").split("|")]


def _tables(text: str) -> list[list[list[str]]]:
    """Every pipe table in the markdown: a list of rows, each a list of cells, the header first, the rule line dropped."""
    out: list[list[list[str]]] = []
    current: list[list[str]] = []
    for raw in text.splitlines():
        line = raw.strip()
        if line.startswith("|") and line.endswith("|"):
            cells = _cells(line)
            if all(re.fullmatch(r":?-{2,}:?", c) for c in cells):
                continue
            current.append(cells)
        elif current:
            out.append(current)
            current = []
    if current:
        out.append(current)
    return out


def _one_price_each(rows: list[OfficialPrice]) -> list[OfficialPrice]:
    """A model listed more than once with different prices (for example by prompt length) has no single standard price:
    it is given none and a reason, never the first or the last of them."""
    out: dict[str, OfficialPrice] = {}
    for r in rows:
        seen = out.get(r.model)
        if seen is None:
            out[r.model] = r
        elif (seen.input_per_mtok, seen.output_per_mtok) != (r.input_per_mtok, r.output_per_mtok) or seen.note:
            out[r.model] = OfficialPrice(r.model, None, None, "the page lists more than one price for this model (for example by prompt length), so no single price is read")
    return list(out.values())


def _col(header: list[str], *needles: str) -> int | None:
    for i, h in enumerate(header):
        if all(n in h.lower() for n in needles):
            return i
    return None


# ------------------------------------------------------------------------------------------------------------ OpenAI

def parse_openai(text: str) -> list[OfficialPrice]:
    """The first table with a model column and short-context input and output columns (Standard pricing)."""
    for table in _tables(text):
        header = table[0]
        m, i, o = _col(header, "model"), _col(header, "short", "input"), _col(header, "short", "output")
        if m is None or i is None or o is None or _col(header, "cached") is not None and i == o:
            continue
        # The input column must be the plain one, not the cached or write column that also says "short context input".
        i = next((k for k, h in enumerate(header) if h.lower().strip() == "short context input"), i)
        o = next((k for k, h in enumerate(header) if h.lower().strip() == "short context output"), o)
        rows = []
        for r in table[1:]:
            if len(r) <= max(m, i, o):
                continue
            model = _LINK.sub(r"\1", _TAG.sub("", r[m])).strip().strip("`")
            if not re.fullmatch(r"[a-z0-9][a-z0-9._-]*", model):
                continue
            rows.append(OfficialPrice(model, _only_price(r[i]), _only_price(r[o])))
        if rows:
            return _one_price_each(rows)
    return []


# ---------------------------------------------------------------------------------------------------------- Anthropic

_NAME = re.compile(r"^(claude|fable|mythos)?\s*(opus|sonnet|haiku|fable|mythos)\s+([0-9]+(?:\.[0-9]+)*)\s*$", re.I)


def anthropic_id(display: str) -> str | None:
    """'Claude Opus 5.5' -> 'claude-opus-5-5'; 'Claude Haiku 4.5 (deprecated)' -> 'claude-haiku-4-5'. None when the name
    is not a plain family and version, so nothing is guessed."""
    name = _LINK.sub(r"\1", _TAG.sub("", display))
    name = re.sub(r"\(.*?\)", "", name).strip()
    m = _NAME.match(name)
    if not m:
        return None
    family, version = m.group(2).lower(), m.group(3).replace(".", "-")
    return f"claude-{family}-{version}"


def parse_anthropic(text: str) -> list[OfficialPrice]:
    """The first table with a model column, base input tokens and output tokens."""
    for table in _tables(text):
        header = table[0]
        m, i, o = _col(header, "model"), _col(header, "base input"), _col(header, "output")
        if m is None or i is None or o is None:
            continue
        rows = []
        for r in table[1:]:
            if len(r) <= max(m, i, o):
                continue
            model = anthropic_id(r[m])
            if model:
                rows.append(OfficialPrice(model, _only_price(r[i]), _only_price(r[o])))
        if rows:
            return _one_price_each(rows)
    return []


# ------------------------------------------------------------------------------------------------------------ Google

_SECTION = re.compile(r'^##\s+.*?\{%\s*id="([a-z0-9][a-z0-9._-]*)"\s*%\}', re.M)
_STANDARD = re.compile(r'\{%\s*tab\s+title="Standard"\s*%\}(.*?)\{%\s*/tab\s*%\}', re.S)
_DATE_WORDS = re.compile(r"\b(through|starting|until|from)\b.*\b(20\d\d)\b", re.I | re.S)


def _google_cell(block: str, label: str) -> tuple[Decimal | None, str | None]:
    """The paid-tier price on the row whose first cell starts with `label`. Rows are `* label`, `* free tier`, `* paid
    tier`, separated by `---`. More than one dollar figure, or a price that changes on a date, is not a single price."""
    for row in re.split(r"\n\s*---\s*\n", block):
        cells = [c.strip() for c in re.split(r"\n\s*\*\s+", "\n" + row.strip()) if c.strip()]
        if len(cells) >= 3 and cells[0].lower().startswith(label.lower()):
            paid = cells[2]
            if _DATE_WORDS.search(paid):
                return None, "the price changes on a date, so no single price is read"
            figures = _MONEY.findall(paid)
            if len(figures) == 1:
                return _dec(figures[0]), None
            if len(figures) > 1:
                return None, "more than one price (for example by kind of input), so no single price is read"
            return None, "no price stated for the paid tier"
    return None, "not stated"


def parse_google(text: str) -> list[OfficialPrice]:
    """One entry per model section, read from its Standard tab."""
    marks = list(_SECTION.finditer(text))
    rows: list[OfficialPrice] = []
    for n, mark in enumerate(marks):
        body = text[mark.end(): marks[n + 1].start() if n + 1 < len(marks) else len(text)]
        tab = _STANDARD.search(body)
        if not tab:
            continue
        price_in, why_in = _google_cell(tab.group(1), "Input price")
        price_out, why_out = _google_cell(tab.group(1), "Output price")
        if price_in is None and price_out is None and why_in == "not stated" and why_out == "not stated":
            continue
        note = None if price_in is not None and price_out is not None else (why_in if price_in is None else why_out)
        rows.append(OfficialPrice(mark.group(1), price_in, price_out, note))
    return rows
