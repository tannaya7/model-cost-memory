"""The company overview: counts and cost across the projects a person may open. Aggregates only.

What this reads, and what it never reads
- Reads numbers and caller-chosen labels from production runs: counts, token sums, list-price cost, the project, the task
  (job) name and the model. It never selects prompt, output, tool calls, expected answers or any person's identity: no
  such identity is recorded, so nothing here can rank, score or single out a person.
- Only the projects passed in are queried, and every query is limited to those ids (the caller has already been checked
  per project), so one company's overview cannot include another's runs.

Honest labels
- A "counted" figure is a plain count or sum of what was recorded (calls, reported tokens).
- A "calculated" figure is cost = reported tokens x the model's dated list price. It is not an invoice, and it is left
  out (None) for flat-plan projects. Nothing here is a forecast or a guess; calls that report no tokens are shown as a coverage gap,
  never filled in.
- The task and model labels are supplied by the calling app. They are not verified identities and are not chargeback-grade.
- A project in "both" pay mode may mix per-use calls and flat-plan calls that the data cannot tell apart, so its dollars are
  kept apart from the billable total.
No legal-compliance claim is made by any of this.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import UTC, date, datetime, timedelta

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from ..models import Job, Project, Run

DAYS = (7, 14, 30, 90)
MIN_CELL = 5  # a task with fewer calls than this in the period is folded into "Other small groups"
TOP_TASKS = 25
TOP_MODELS = 15
MAX_MODEL_ROWS = 1000  # model names are caller-chosen; read at most this many distinct ones, the rest are not counted in any row
OTHER = "Other small groups"

_TOKENS = Run.tokens_in + Run.tokens_out + Run.cache_read_tokens + Run.cache_write_tokens
_REPORTS_USAGE = func.coalesce(Run.usage_shape, "") != "none"


def mode_of(project: Project) -> str:
    return project.billing_mode if project.billing_mode in ("subscription", "both") else "per_use"


@dataclass
class Totals:
    calls: int = 0
    tokens: int = 0
    usd: float | None = 0.0  # None where dollars are not shown (flat plan)
    unpriced_calls: int = 0
    with_usage: int = 0


@dataclass
class Overview:
    days: int
    since: datetime
    until: datetime
    projects: list[dict] = field(default_factory=list)
    by_mode: dict[str, dict] = field(default_factory=dict)
    totals: dict = field(default_factory=dict)
    coverage: dict = field(default_factory=dict)
    trend: list[dict] = field(default_factory=list)
    tasks: list[dict] = field(default_factory=list)
    models: list[dict] = field(default_factory=list)
    attribution: list[dict] = field(default_factory=list)
    notes: list[str] = field(default_factory=list)


def _share(part: int, whole: int) -> float | None:
    return round(part / whole, 4) if whole else None


async def company_overview(session: AsyncSession, projects: list[Project], *, days: int = 30,
                           now: datetime | None = None) -> Overview:
    until = now or datetime.now(UTC)
    since = until - timedelta(days=days)
    out = Overview(days=days, since=since, until=until)
    modes = {p.project_id: mode_of(p) for p in projects}
    ids = list(modes)
    base = (Run.project_id.in_(ids), Run.run_kind == "PRODUCTION", Run.created_at >= since, Run.created_at < until,
            Run.state != "INGESTION_FAILED")

    per_project = {}
    if ids:
        for pid, calls, tokens, usd, unpriced, usage, traced, agent in (await session.execute(
            select(Run.project_id, func.count(), func.coalesce(func.sum(_TOKENS), 0), func.coalesce(func.sum(Run.cost_usd), 0),
                   func.count().filter(Run.cost_usd.is_(None)), func.count().filter(_REPORTS_USAGE),
                   func.count().filter(Run.trace_id.is_not(None)), func.count().filter(Run.agent.is_not(None)))
            .where(*base).group_by(Run.project_id))).all():
            per_project[pid] = (int(calls), int(tokens), float(usd), int(unpriced), int(usage), int(traced), int(agent))

    rows, by_mode = [], {m: {"projects": 0, "calls": 0, "tokens": 0, "usd": 0.0, "unpriced_calls": 0}
                         for m in ("per_use", "both", "subscription")}
    total_calls = total_tokens = total_unpriced = total_usage = total_traced = total_agent = money_calls = 0
    for p in sorted(projects, key=lambda p: (p.name or p.project_id).lower()):
        calls, tokens, usd, unpriced, usage, traced, agent = per_project.get(p.project_id, (0, 0, 0.0, 0, 0, 0, 0))
        mode = modes[p.project_id]
        shows_money = mode != "subscription"
        rows.append({
            "project_id": p.project_id, "slug": p.slug, "name": p.name or p.project_id, "pay_mode": mode,
            "calls": calls, "tokens": tokens,
            "cost_usd": round(usd, 6) if shows_money else None,
            "cost_kind": {"per_use": "billable_list_price", "both": "list_price_may_include_flat_plan",
                          "subscription": "none_flat_plan"}[mode],
            "unpriced_calls": unpriced if shows_money else 0,
            "calls_reporting_tokens": usage,
        })
        m = by_mode[mode]
        m["projects"] += 1
        m["calls"] += calls
        m["tokens"] += tokens
        if shows_money:
            m["usd"] += usd
            m["unpriced_calls"] += unpriced
        total_calls += calls
        total_tokens += tokens
        total_usage += usage
        total_traced += traced
        total_agent += agent
        total_unpriced += unpriced if shows_money else 0
        money_calls += calls if shows_money else 0
    out.projects = rows
    for mode, m in by_mode.items():
        m["usd"] = None if mode == "subscription" else round(m["usd"], 6)
    out.by_mode = by_mode
    billable = by_mode["per_use"]
    out.totals = {
        "calls": total_calls, "tokens": total_tokens,
        "billable_usd": billable["usd"], "billable_basis": "calculated: reported tokens x dated list price; not an invoice",
        "mixed_mode_usd": by_mode["both"]["usd"], "unpriced_calls": total_unpriced,
        "has_data": total_calls > 0,
    }
    out.coverage = {
        "calls": total_calls, "calls_reporting_tokens": total_usage,
        "calls_without_token_counts": total_calls - total_usage,
        "token_report_share": _share(total_usage, total_calls),
        "calls_in_money_projects": money_calls, "calls_priced": money_calls - total_unpriced,
        "calls_with_task_id": total_traced, "calls_with_agent_label": total_agent,
        "task_id_share": _share(total_traced, total_calls), "agent_label_share": _share(total_agent, total_calls),
    }

    if ids and total_calls:
        day = func.date_trunc("day", func.timezone("UTC", Run.created_at)).label("day")
        by_day: dict[date, dict] = {}
        for d, calls, tokens, usd, mode_proj in (await session.execute(
            select(day, func.count(), func.coalesce(func.sum(_TOKENS), 0),
                   func.coalesce(func.sum(Run.cost_usd), 0), Run.project_id).where(*base)
            .group_by(day, Run.project_id).order_by(day))).all():
            row = by_day.setdefault(d.date(), {"day": d.date(), "calls": 0, "tokens": 0, "billable_usd": 0.0})
            row["calls"] += int(calls)
            row["tokens"] += int(tokens)
            if modes[mode_proj] == "per_use":
                row["billable_usd"] += float(usd)
        out.trend = [{**r, "billable_usd": round(r["billable_usd"], 6)} for _, r in sorted(by_day.items())]

        task_rows = (await session.execute(
            select(Run.project_id, Job.name, func.count(), func.coalesce(func.sum(_TOKENS), 0),
                   func.coalesce(func.sum(Run.cost_usd), 0), func.count().filter(Run.cost_usd.is_(None)))
            .join(Job, Job.job_id == Run.job_id).where(*base).group_by(Run.project_id, Job.name))).all()
        names = {p.project_id: p.name or p.project_id for p in projects}
        shown, folded = [], {"calls": 0, "tokens": 0, "usd": 0.0, "n": 0}
        for pid, task, calls, tokens, usd, unpriced in sorted(task_rows, key=lambda r: (-int(r[2]), r[0], r[1])):
            mode = modes[pid]
            if int(calls) < MIN_CELL:
                folded["calls"] += int(calls)
                folded["tokens"] += int(tokens)
                folded["usd"] += float(usd) if mode != "subscription" else 0.0
                folded["n"] += 1
                continue
            shown.append({"project": names[pid], "project_id": pid, "task": task, "calls": int(calls), "tokens": int(tokens),
                          "cost_usd": round(float(usd), 6) if mode != "subscription" else None,
                          "unpriced_calls": int(unpriced) if mode != "subscription" else 0, "pay_mode": mode,
                          "label_source": "caller_supplied"})
        out.tasks = shown[:TOP_TASKS]
        if len(shown) > TOP_TASKS:
            for r in shown[TOP_TASKS:]:
                folded["calls"] += r["calls"]
                folded["tokens"] += r["tokens"]
                folded["usd"] += r["cost_usd"] or 0.0
                folded["n"] += 1
        if folded["n"]:
            out.tasks.append({"project": None, "project_id": None, "task": OTHER, "calls": folded["calls"],
                              "tokens": folded["tokens"], "cost_usd": round(folded["usd"], 6), "unpriced_calls": 0,
                              "pay_mode": None, "label_source": "caller_supplied", "folded_groups": folded["n"]})

        model_rows = (await session.execute(
            select(Run.model, func.count(), func.coalesce(func.sum(_TOKENS), 0),
                   func.coalesce(func.sum(Run.cost_usd).filter(Run.project_id.in_(
                       [i for i, m in modes.items() if m != "subscription"] or [""])), 0),
                   func.count().filter(Run.cost_usd.is_(None), Run.project_id.in_(
                       [i for i, m in modes.items() if m != "subscription"] or [""])),
                   func.count().filter(Run.project_id.in_([i for i, m in modes.items() if m == "subscription"] or [""])))
            .where(*base).group_by(Run.model).order_by(func.count().desc(), Run.model).limit(MAX_MODEL_ROWS))).all()
        # Model names are chosen by the calling app, so a name used by only a few calls can point at one person's experiments.
        # Like the task rows, a model with fewer than MIN_CELL calls is folded into "Other small groups", and so is everything
        # beyond the top TOP_MODELS, so the folded row also keeps the table adding up to the total.
        folded_models = {"calls": 0, "tokens": 0, "cost_usd": 0.0, "unpriced_calls": 0, "flat_plan_calls": 0, "n": 0}
        shown_models = []
        for model, calls, tokens, usd, unpriced, subs in model_rows:
            row = {"model": model, "calls": int(calls), "tokens": int(tokens), "cost_usd": round(float(usd), 6),
                   "unpriced_calls": int(unpriced), "flat_plan_calls": int(subs), "label_source": "caller_supplied"}
            if int(calls) < MIN_CELL or len(shown_models) >= TOP_MODELS:
                for k in ("calls", "tokens", "cost_usd", "unpriced_calls", "flat_plan_calls"):
                    folded_models[k] += row[k]
                folded_models["n"] += 1
            else:
                shown_models.append(row)
        out.models = shown_models
        if folded_models["n"]:
            out.models.append({"model": OTHER, "calls": folded_models["calls"], "tokens": folded_models["tokens"],
                               "cost_usd": round(folded_models["cost_usd"], 6), "unpriced_calls": folded_models["unpriced_calls"],
                               "flat_plan_calls": folded_models["flat_plan_calls"], "label_source": "caller_supplied",
                               "folded_groups": folded_models["n"]})

    out.attribution = [
        {"dimension": "project", "source": "verified",
         "detail": "Set by the project key the app used, which this product issued and can revoke.", "coverage_share": 1.0 if total_calls else None},
        {"dimension": "task", "source": "caller_supplied",
         "detail": "The AI task name the app chose. It could be wrong or changed by anyone holding the project key.", "coverage_share": 1.0 if total_calls else None},
        {"dimension": "model", "source": "caller_supplied",
         "detail": "The model name the app reported for the call. Cost uses that name's list price.", "coverage_share": 1.0 if total_calls else None},
        {"dimension": "agent", "source": "caller_supplied",
         "detail": "An optional agent label from the app. Not shown here, and not a verified identity.", "coverage_share": out.coverage["agent_label_share"]},
        {"dimension": "task_trace", "source": "caller_supplied",
         "detail": "An optional id grouping the calls of one task. Not a person.", "coverage_share": out.coverage["task_id_share"]},
        {"dimension": "person", "source": "not_recorded",
         "detail": "No individual user identity is collected, so there are no per-person figures and none can be derived.", "coverage_share": None},
    ]
    out.notes = [
        "These are counts and list-price calculations, not invoices. Chargeback or customer billing would need explicit, verified labels, which do not exist yet.",
        "Task and model names come from the calling app and can be spoofed by anyone with a project key.",
        "Model dollars are list prices and include projects in mixed mode; flat-plan projects add calls and tokens only.",
        "Flat-plan projects show calls and tokens only. Projects in mixed mode show list-price dollars separately, because flat-plan calls cannot be told apart.",
        f"Tasks and models with fewer than {MIN_CELL} calls are grouped as '{OTHER}'.",
        "No prompt or answer text is read for this view.",
    ]
    if total_calls and total_usage < total_calls:
        out.notes.append(f"{total_calls - total_usage:,} calls report no token counts, so their tokens are not counted and their cost is unknown.")
    return out
