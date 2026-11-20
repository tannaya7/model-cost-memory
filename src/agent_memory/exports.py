"""CSV files for people to open in a spreadsheet: one safe writer for every export.

Rules, in one place so no export can skip them:
- **Aggregates and labels only.** Counts, token sums, list-price cost, task and model names. Never prompt or answer text, tool calls, keys,
  webhook addresses, e-mail addresses or anything about a person. Callers pass in only what may be exported; this writer cannot add more.
- **Quoted per RFC 4180** (a comma, a quote or a line break in a value puts it in quotes, quotes are doubled; lines end in CRLF).
- **Spreadsheets run formulas.** A text value that starts with = + - @ or a tab or carriage return could be run as one when the file is opened,
  so such a value gets a leading apostrophe. Only TEXT columns are touched: a number is written as a number, so a negative amount stays a
  negative amount. The number of values changed is returned, so the screen can say so.
- **Self-describing.** Every row carries its period, filters, units and cost basis, so a single row cut out of the file still says what it is.
"""

from __future__ import annotations

import csv
import io
from collections.abc import Iterable, Mapping, Sequence
from typing import Any

FORMULA_LEADS = ("=", "+", "-", "@", "\t", "\r")  # OWASP CSV injection


def neutralize(value: str) -> tuple[str, bool]:
    """A text value a spreadsheet cannot run as a formula, and whether it had to be changed."""
    if value and value[0] in FORMULA_LEADS:
        return "'" + value, True
    return value, False


def _cell(value: Any) -> Any:
    if value is None:
        return ""
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, float):
        return repr(round(value, 6))
    return value


BOM = "﻿"


def csv_file(text: str) -> str:
    """The text of a CSV download: a UTF-8 byte-order mark first, so Excel (which otherwise guesses an old code page) shows accented
    names correctly. Other programs ignore it. write_csv itself stays plain text, so the mark is added only where a file is sent."""
    return BOM + text


def write_csv(columns: Sequence[str], rows: Iterable[Mapping[str, Any]], *, text_columns: Iterable[str]) -> tuple[str, int]:
    """The CSV text and how many text values were neutralized. Numbers are never changed."""
    text_cols = set(text_columns)
    out = io.StringIO(newline="")
    writer = csv.writer(out, lineterminator="\r\n", quoting=csv.QUOTE_MINIMAL)
    writer.writerow(columns)
    changed = 0
    for row in rows:
        line = []
        for c in columns:
            v = row.get(c)
            if c in text_cols and isinstance(v, str):
                v, did = neutralize(v)
                changed += did
            line.append(_cell(v))
        writer.writerow(line)
    return out.getvalue(), changed


COST_BASIS = {
    "per_use": "list price x tokens the provider reported; not an invoice. Calls with no known price are counted in unpriced_runs, never as free",
    "both": "list price of all calls, which may include calls on a flat plan; not your bill. Calls with no known price are counted in unpriced_runs",
    "subscription": "what the calls would cost at list prices; you pay a flat fee, so this is not your bill. Calls with no known price are counted in unpriced_runs",
}

PROJECT_COLUMNS = (
    "day", "ai_task", "model", "runs", "passed", "failed", "unchecked_runs", "unpriced_runs", "spend_usd",
    "tokens_in", "tokens_out", "cache_read_tokens", "cache_write_tokens",
    "currency", "cost_basis", "pay_mode", "period_start", "period_end", "filter_ai_task", "filter_model",
)
PROJECT_TEXT = ("day", "ai_task", "model", "currency", "cost_basis", "pay_mode", "period_start", "period_end", "filter_ai_task", "filter_model")

COMPANY_COLUMNS = (
    "section", "name", "project", "pay_mode", "calls", "tokens", "cost_usd", "unpriced_calls", "day",
    "currency", "cost_basis", "period_start", "period_end", "attribution", "chargeback_grade",
)
COMPANY_TEXT = ("section", "name", "project", "pay_mode", "day", "currency", "cost_basis", "period_start", "period_end", "attribution")
