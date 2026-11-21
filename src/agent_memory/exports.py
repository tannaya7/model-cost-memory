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


# --- cost by feature label -----------------------------------------------------------------------------------------
FEATURE_COLUMNS = (
    "feature", "label_kind", "runs", "passed", "failed", "unchecked_runs", "excluded_runs", "tokens", "no_usage_runs", "spend_usd", "unpriced_runs",
    "share_of_spend", "cost_per_correct_answer_usd", "currency", "cost_basis", "label_note", "period_start", "period_end",
)
FEATURE_TEXT = ("feature", "label_kind", "currency", "cost_basis", "label_note", "period_start", "period_end")
FEATURE_NOTE = "the label is your own app's word: not verified, not an identity, not a chargeback record"


def feature_rows(breakdown: Any, *, cost_column: str, cost_basis: str) -> list[dict[str, Any]]:
    """One row per feature label from a FeatureBreakdownOut: aggregates only. An unknown value stays empty, never 0."""
    rows = []
    for r in breakdown.rows:
        kind = "your label" if r.feature is not None else ("several smaller labels added together" if r.folded_labels else "no label sent")
        rows.append({
            "feature": r.label, "label_kind": kind, "runs": r.runs, "passed": r.passed, "failed": r.failed, "unchecked_runs": r.unchecked,
            "excluded_runs": r.excluded, "tokens": r.tokens, "no_usage_runs": r.no_usage_runs, cost_column: r.spend_usd, "unpriced_runs": r.unpriced_runs,
            "share_of_spend": r.share_of_spend, "cost_per_correct_answer_usd": r.cost_per_success.value_usd, "currency": breakdown.currency,
            "cost_basis": cost_basis, "label_note": FEATURE_NOTE,
            "period_start": breakdown.period_start.date().isoformat(), "period_end": breakdown.period_end.date().isoformat(),
        })
    return rows


# --- cost planner scenarios ----------------------------------------------------------------------------------------
PLANNER_COLUMNS = (
    "ai_task", "model", "provider", "tasks_per_period", "period", "attempts", "estimate_usd", "low_usd", "high_usd", "per_task_usd", "result",
    "calls_observed", "calls_used", "calls_left_out", "mean_call_usd", "price_versions_used", "retry_rate", "input_size_change_pct",
    "output_size_change_pct", "far_out_calls_left_out", "history_start", "history_end", "currency", "estimate_basis", "assumptions_source",
)
PLANNER_TEXT = ("ai_task", "model", "provider", "period", "result", "price_versions_used", "far_out_calls_left_out", "history_start", "history_end",
                "currency", "estimate_basis", "assumptions_source")
PLANNER_BASIS = ("scenario estimate from recorded calls at list prices of the day; not a bill, not a promise and not a forecast; "
                 "a range is shown only with enough comparable calls; calls without a price are left out, never counted as free")


def planner_rows(plan: Any, *, retry_rate: float, input_change_pct: float, output_change_pct: float, far_out: bool) -> list[dict[str, Any]]:
    """One row per model and scenario from a PlannerOut. Unknown figures (no estimate, no range) stay empty, never 0."""
    rows = []
    for m in plan.models:
        versions = "; ".join(f"in force from {v.effective_from.date().isoformat()} ({v.runs} calls)" for v in m.versions_used)
        for s in m.scenarios:
            rows.append({
                "ai_task": plan.job, "model": m.model, "provider": m.provider or "", "tasks_per_period": s.tasks_per_period, "period": plan.period_label,
                "attempts": round(s.attempts, 4), "estimate_usd": s.estimate_usd, "low_usd": s.low_usd, "high_usd": s.high_usd, "per_task_usd": s.per_task_usd,
                "result": m.status_text if s.estimate_usd is None else (s.range_note or m.status_text),
                "calls_observed": m.observed_calls, "calls_used": m.used_calls, "calls_left_out": sum(m.left_out.values()),
                "mean_call_usd": m.mean_call_usd, "price_versions_used": versions, "retry_rate": retry_rate, "input_size_change_pct": input_change_pct,
                "output_size_change_pct": output_change_pct, "far_out_calls_left_out": f"{m.filtered_out} left out" if far_out else "filter off",
                "history_start": plan.period_start.date().isoformat(), "history_end": plan.period_end.date().isoformat(), "currency": plan.currency,
                "estimate_basis": PLANNER_BASIS, "assumptions_source": "retry rate, size changes and tasks per period were typed by the user; calls and prices are measured history",
            })
    return rows
