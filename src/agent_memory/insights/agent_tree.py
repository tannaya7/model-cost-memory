"""A task's calls as a tree of parents and children, possible repeated calls with their evidence, and measured cohorts.

Analysis of the project's own recorded calls only. Nothing here stops, cancels or reconfigures an agent, and it cannot reach the
customer's app.

STRUCTURE comes only from ids the app sent (`span_id`, `parent_span_id`), never from guesses:
    root             a call with its own span id and no parent
    child            a call whose parent id matches a recorded call in the same task
    unlinked child   a call whose parent id matches no recorded call ("parent not recorded"), whose parent is itself, or whose
                     parent ids form a cycle. It is shown apart, with its missing parent id, never attached to a guess
    no structure     a call that sent neither id (an app that does not send them)

TOTALS count each recorded call once. A call's subtree total is its own usage plus its children's. The task total is the sum of
every call exactly once, and equals the roots' subtrees plus the unlinked subtrees plus the calls with no structure. If an app
reports a parent's usage as already including its children's, this cannot tell, and the figures would count those twice: the
method note says so.

REPEATED CALLS are a possible repeated call, never a verdict. The same tool (and the same arguments, when the project stores them;
otherwise the same prompt) repeating at least `repeats` times within any `window` consecutive calls of one task. Polling and
retries repeat legitimately, so the evidence is returned with the flag: each call, its time, the gap since the one before, whether
results changed, whether earlier calls failed. When stored results keep changing the task is treated as making progress and
nothing is flagged. The same rule and defaults (5 within 7) as the older loop check in agent_kinds; the numbers are the viewer's
choice, not a measured limit.

COHORTS compare only tasks that are equivalent: the same AI task and the same set of models, single-agent against multi-agent,
with at least MIN_COHORT tasks on each side. The answer gives the measured medians and counts in this project. It states no
multiplier and does not say multi-agent causes a difference.
"""

from __future__ import annotations

import hashlib
import json
import statistics
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from typing import Any

from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from ..models import Job, Run
from .agent_kinds import LOOP_REPEATS, LOOP_WINDOW

DEFAULT_REPEATS, DEFAULT_WINDOW = LOOP_REPEATS, LOOP_WINDOW
REPEAT_CHOICES = (3, 4, 5, 6, 8, 10)
WINDOW_CHOICES = (5, 7, 10, 15)
DAYS = (7, 14, 30, 90)
MIN_COHORT = 10
MAX_CALLS_PER_TASK = 1000
TOP_TASKS = 20
MAX_COHORT_TASKS = 20_000
POLLING_GAP_SECONDS = 10.0  # calls this far apart, on average, are described as spaced like polling (a hint, not a rule)

METHOD = [
    "Structure comes only from the span ids your app sends. A call whose parent was never recorded is shown as 'parent not recorded', never attached to a guess.",
    "Each recorded call is counted once. A call's subtree total is its own usage plus its children's; the task total is every call once, so it never counts a call twice.",
    "If your app reports a parent's usage as already including its children's, this cannot tell, and those would be counted twice.",
    "A possible repeated call is the same tool and arguments (or the same prompt, when arguments are not stored) at least N times within M consecutive calls. N and M are your choice here, not a measured limit.",
    "Polling and retries repeat on purpose. The flag shows the calls, their spacing and whether results changed, so you can judge. When stored results keep changing it is not flagged.",
    "Cohorts compare only tasks that are equivalent: the same AI task and the same models, single-agent against multi-agent. They show measured medians in this project. They state no multiplier and do not say multi-agent causes a difference.",
]


# ---------------------------------------------------------------------------------------------------- calls and trees

@dataclass
class Call:
    run_id: str
    job: str
    agent: str | None
    model: str
    span_id: str | None
    parent_span_id: str | None
    created_at: datetime
    latency_ms: int | None
    tokens: int
    cost: float | None
    tool_names: list[str] = field(default_factory=list)
    arguments_hash: str | None = None
    prompt_hash: str = ""
    output_hash: str | None = None
    failed: bool | None = None  # True when a tool call of this request is recorded as failed; None when not recorded


@dataclass
class Totals:
    calls: int = 0
    tokens: int = 0
    cost_usd: float | None = None
    unpriced_calls: int = 0

    def add(self, other: Totals) -> None:
        self.calls += other.calls
        self.tokens += other.tokens
        self.unpriced_calls += other.unpriced_calls
        if other.cost_usd is not None:
            self.cost_usd = (self.cost_usd or 0.0) + other.cost_usd


def _own(c: Call, money: bool) -> Totals:
    return Totals(calls=1, tokens=c.tokens, cost_usd=c.cost if money and c.cost is not None else None,
                  unpriced_calls=1 if money and c.cost is None else 0)


@dataclass
class Node:
    call: Call
    link: str  # root | child | unlinked | no_structure
    reason: str | None = None  # why it is unlinked
    missing_parent: str | None = None
    duplicate_span: bool = False  # another call in this task has the same span id
    children: list[Node] = field(default_factory=list)
    own: Totals = field(default_factory=Totals)
    subtree: Totals = field(default_factory=Totals)


@dataclass
class TaskTree:
    roots: list[Node]
    unlinked: list[Node]
    unstructured: list[Node]
    totals: Totals
    duplicate_spans: int
    notes: list[str]


def build_tree(calls: list[Call], *, money: bool = True) -> TaskTree:
    """Pure. Oldest call first within every list. Each call lands in exactly one place."""
    once: dict[str, Call] = {}
    for c in calls:  # a record of the same call sent twice (a retried send) is one call
        once.setdefault(c.run_id, c)
    repeats_ignored = len(calls) - len(once)
    calls = sorted(once.values(), key=lambda c: (c.created_at, c.run_id))
    nodes = [Node(call=c, link="no_structure", own=_own(c, money)) for c in calls]
    by_span: dict[str, Node] = {}
    dups: set[str] = set()
    for n in nodes:
        sid = n.call.span_id
        if not sid:
            continue
        if sid in by_span:
            dups.add(sid)
            n.duplicate_span = True
            by_span[sid].duplicate_span = True
        else:
            by_span[sid] = n

    parent_of: dict[int, Node | None] = {}
    for n in nodes:
        c = n.call
        if not c.span_id and not c.parent_span_id:
            n.link = "no_structure"
        elif not c.parent_span_id:
            n.link = "root"
        elif c.parent_span_id == c.span_id:
            n.link, n.reason, n.missing_parent = "unlinked", "its parent id is its own id", c.parent_span_id
        elif c.parent_span_id not in by_span:
            n.link, n.reason, n.missing_parent = "unlinked", "parent not recorded", c.parent_span_id
        else:
            n.link = "child"
            parent_of[id(n)] = by_span[c.parent_span_id]

    # A cycle in the parent ids (A under B under A) has no root: its members are shown as unlinked, not looped over.
    for n in nodes:
        seen: set[int] = set()
        cur: Node | None = n
        while cur is not None and id(cur) in parent_of:
            if id(cur) in seen:
                for m in (x for x in nodes if id(x) in seen):
                    m.link, m.reason, m.missing_parent = "unlinked", "its parent ids form a cycle", m.call.parent_span_id
                    parent_of.pop(id(m), None)
                break
            seen.add(id(cur))
            cur = parent_of.get(id(cur))
    for n in nodes:
        p = parent_of.get(id(n))
        if p is not None and n.link == "child":
            p.children.append(n)

    # Subtree totals, children first, each call once.
    def total(n: Node) -> Totals:
        acc = Totals()
        stack = [n]
        order: list[Node] = []
        while stack:
            cur = stack.pop()
            order.append(cur)
            stack.extend(cur.children)
        for m in order:
            acc.add(m.own)
        return acc

    for n in nodes:
        n.subtree = total(n)

    roots = [n for n in nodes if n.link == "root"]
    unlinked = [n for n in nodes if n.link == "unlinked"]
    flat = [n for n in nodes if n.link == "no_structure"]
    grand = Totals()
    for n in nodes:
        grand.add(n.own)
    notes: list[str] = []
    if repeats_ignored:
        notes.append(f"{repeats_ignored:,} duplicate {'record' if repeats_ignored == 1 else 'records'} of the same call {'was' if repeats_ignored == 1 else 'were'} counted once.")
    if flat and (roots or unlinked or any(n.link == "child" for n in nodes)):
        notes.append(f"{len(flat):,} {'call' if len(flat) == 1 else 'calls'} in this task sent no span ids, so {'its' if len(flat) == 1 else 'their'} place in the tree is unknown.")
    if unlinked:
        notes.append(f"{len(unlinked):,} {'call names' if len(unlinked) == 1 else 'calls name'} a parent that was not recorded (or {'points' if len(unlinked) == 1 else 'point'} at "
                     f"{'itself' if len(unlinked) == 1 else 'themselves'}, or {'forms' if len(unlinked) == 1 else 'form'} a cycle), so {'it is' if len(unlinked) == 1 else 'they are'} shown apart.")
    if dups:
        notes.append(f"{len(dups):,} span {'id is' if len(dups) == 1 else 'ids are'} used by more than one call; each call is still counted once.")
    return TaskTree(roots=roots, unlinked=unlinked, unstructured=flat, totals=grand, duplicate_spans=len(dups), notes=notes)


# ------------------------------------------------------------------------------------------------- repeated calls

@dataclass
class RepeatedCall:
    step: str  # what repeated, in words
    basis: str  # arguments | prompt
    repeats: int  # in the whole task
    in_window: int  # in the densest window
    calls: list[dict[str, Any]]
    median_gap_seconds: float | None
    results_stored: bool
    distinct_results: int | None
    failed_calls: int
    cost_usd: float | None
    hints: list[str]
    repeats_threshold: int
    window: int


def _signature(c: Call) -> tuple[str, str]:
    return (",".join(sorted(c.tool_names)), c.arguments_hash or f"prompt:{c.prompt_hash}")


def find_repeats(calls: list[Call], *, repeats: int = DEFAULT_REPEATS, window: int = DEFAULT_WINDOW, money: bool = True) -> RepeatedCall | None:
    """The most repeated call in a task, if it reaches the chosen threshold. A possible repeated call, never a verdict."""
    if repeats < 2 or window < repeats:
        raise ValueError("the window must be at least as large as the number of repeats")
    calls = sorted(calls, key=lambda c: (c.created_at, c.run_id))
    if len(calls) < repeats:
        return None
    size = min(window, len(calls))
    best: tuple[int, tuple[str, str]] | None = None
    for i in range(len(calls) - size + 1):
        win = calls[i:i + size]
        for sig, n in Counter(_signature(c) for c in win).items():
            if n < repeats:
                continue
            reps = [c for c in win if _signature(c) == sig]
            outs = [c.output_hash for c in reps]
            if all(outs) and len(set(outs)) > len(outs) / 2:
                continue  # results keep changing: progress, not a repeat
            if best is None or n > best[0]:
                best = (n, sig)
    if best is None:
        return None
    in_window, sig = best
    every = [c for c in calls if _signature(c) == sig]
    gaps = [(b.created_at - a.created_at).total_seconds() for a, b in zip(every, every[1:], strict=False)]
    stored = all(c.output_hash for c in every)
    failed = sum(1 for c in every if c.failed is True)
    median_gap = statistics.median(gaps) if gaps else None
    hints: list[str] = ["This can be valid: polling and retries repeat on purpose. Check the calls before deciding anything."]
    if every[0].arguments_hash is None:
        hints.append("Arguments were not stored, so 'the same' means the same tool and the same prompt. Turn on keeping tool inputs in Settings to compare arguments.")
    if median_gap is not None and median_gap >= POLLING_GAP_SECONDS:
        hints.append(f"The calls are about {median_gap:,.0f} seconds apart, which is how polling often looks.")
    if failed:
        hints.append(f"{failed} of these calls are recorded as failed, which is how retries often look.")
    if stored:
        hints.append("Stored results were mostly the same each time.")
    cost = [c.cost for c in every if c.cost is not None]
    first = every[0]
    window_ids = {c.run_id for c in _densest_window(calls, sig, size)}
    return RepeatedCall(
        step=("the " + " and ".join(sorted(set(first.tool_names))) + " tool") if first.tool_names else "the same question",
        basis="arguments" if first.arguments_hash else "prompt", repeats=len(every), in_window=in_window,
        calls=[{"run_id": c.run_id, "at": c.created_at, "gap_seconds": (c.created_at - every[i - 1].created_at).total_seconds() if i else None,
                "cost_usd": c.cost if money else None, "tokens": c.tokens, "agent": c.agent, "model": c.model,
                "failed": c.failed, "in_window": c.run_id in window_ids} for i, c in enumerate(every)],
        median_gap_seconds=median_gap, results_stored=stored, distinct_results=len({c.output_hash for c in every}) if stored else None,
        failed_calls=failed, cost_usd=sum(cost) if money and cost else None, hints=hints, repeats_threshold=repeats, window=window)


def _densest_window(calls: list[Call], sig: tuple[str, str], size: int) -> list[Call]:
    best: list[Call] = []
    for i in range(len(calls) - size + 1):
        hits = [c for c in calls[i:i + size] if _signature(c) == sig]
        if len(hits) > len(best):
            best = hits
    return best


# ---------------------------------------------------------------------------------------------------------- cohorts

@dataclass
class Cohort:
    job: str
    models: list[str]
    single_agent: dict[str, Any]
    multi_agent: dict[str, Any]


def _spread(values: list[float]) -> dict[str, Any]:
    v = sorted(values)
    q = statistics.quantiles(v, n=4) if len(v) >= 2 else [v[0]] * 3
    return {"tasks": len(v), "median": statistics.median(v), "p25": q[0], "p75": q[2]}


def cohorts(traces: list[dict[str, Any]], *, money: bool) -> tuple[list[Cohort], list[str]]:
    """Compare only equivalent tasks. `traces` rows: job, jobs (distinct jobs in the task), models, agents (distinct labels),
    tokens, cost (None when unpriced). Returns the cohorts with both sides large enough, and why others were left out."""
    groups: dict[tuple[str, tuple[str, ...]], dict[str, list[dict[str, Any]]]] = defaultdict(lambda: {"single": [], "multi": []})
    mixed = 0
    for t in traces:
        if t["jobs"] != 1:
            mixed += 1
            continue
        groups[(t["job"], tuple(sorted(t["models"])))]["multi" if t["agents"] >= 2 else "single"].append(t)
    out: list[Cohort] = []
    left = 0
    for (job, models), sides in sorted(groups.items()):
        if len(sides["single"]) < MIN_COHORT or len(sides["multi"]) < MIN_COHORT:
            left += 1
            continue

        def side(rows: list[dict[str, Any]]) -> dict[str, Any]:
            d = {"tokens": _spread([float(r["tokens"]) for r in rows]), "cost_usd": None}
            priced = [float(r["cost"]) for r in rows if r["cost"] is not None]
            if money and len(priced) >= 2:
                d["cost_usd"] = _spread(priced)
            return d

        out.append(Cohort(job=job, models=list(models), single_agent=side(sides["single"]), multi_agent=side(sides["multi"])))
    notes: list[str] = []
    if left:
        notes.append(f"{left:,} groups of equivalent tasks have fewer than {MIN_COHORT} single-agent or {MIN_COHORT} multi-agent tasks, so they are not compared.")
    if mixed:
        notes.append(f"{mixed:,} tasks span more than one AI task and are not comparable, so they are left out.")
    return out, notes


# --------------------------------------------------------------------------------------------------------- database

def _hash(value: Any) -> str:
    return hashlib.sha256(json.dumps(value, sort_keys=True, default=str).encode()).hexdigest()[:16]


def _calls(rows: list[Any]) -> list[Call]:
    out: list[Call] = []
    for r in rows:
        names: list[str] = []
        args: list[Any] = []
        failed: bool | None = None
        if isinstance(r.tool_calls, list):
            for t in r.tool_calls:
                if isinstance(t, dict) and isinstance(t.get("name"), str):
                    names.append(t["name"])
                    if t.get("arguments") is not None:
                        args.append([t["name"], t["arguments"]])
                    if t.get("failed") is True:
                        failed = True
                    elif t.get("failed") is False and failed is None:
                        failed = False
        out.append(Call(
            run_id=str(r.run_id), job=r.job, agent=r.agent, model=r.model, span_id=r.span_id, parent_span_id=r.parent_span_id,
            created_at=r.created_at, latency_ms=r.latency_ms, tokens=int(r.tokens or 0),
            cost=float(r.cost_usd) if r.cost_usd is not None else None, tool_names=names, arguments_hash=_hash(args) if args else None,
            prompt_hash=r.prompt_hash, output_hash=_hash(r.output) if r.output else None, failed=failed))
    return out


_TOKENS = Run.tokens_in + Run.tokens_out + Run.cache_read_tokens + Run.cache_write_tokens


async def trace_calls(session: AsyncSession, project_id: str, trace_id: str) -> tuple[list[Call], bool]:
    rows = (await session.execute(
        select(Run.run_id, Job.name.label("job"), Run.agent, Run.model, Run.span_id, Run.parent_span_id, Run.created_at, Run.latency_ms,
               _TOKENS.label("tokens"), Run.cost_usd, Run.tool_calls, Run.prompt_hash, Run.output)
        .join(Job, Job.job_id == Run.job_id)
        .where(Run.project_id == project_id, Run.trace_id == trace_id, Run.run_kind == "PRODUCTION", Run.state != "INGESTION_FAILED")
        .order_by(Run.created_at, Run.run_id).limit(MAX_CALLS_PER_TASK + 1))).all()
    return _calls(rows[:MAX_CALLS_PER_TASK]), len(rows) > MAX_CALLS_PER_TASK


@dataclass
class TaskView:
    trace_id: str
    tree: TaskTree
    repeated: RepeatedCall | None
    agents: list[str]
    models: list[str]
    jobs: list[str]
    first_at: datetime
    last_at: datetime
    truncated: bool


def view_of(trace_id: str, calls: list[Call], truncated: bool, *, repeats: int, window: int, money: bool) -> TaskView:
    return TaskView(
        trace_id=trace_id, tree=build_tree(calls, money=money), repeated=find_repeats(calls, repeats=repeats, window=window, money=money),
        agents=sorted({c.agent for c in calls if c.agent}), models=sorted({c.model for c in calls}), jobs=sorted({c.job for c in calls}),
        first_at=min(c.created_at for c in calls), last_at=max(c.created_at for c in calls), truncated=truncated)


async def agent_task(session: AsyncSession, project_id: str, trace_id: str, *, repeats: int = DEFAULT_REPEATS,
                     window: int = DEFAULT_WINDOW, mode: str = "per_use") -> TaskView | None:
    calls, truncated = await trace_calls(session, project_id, trace_id)
    if not calls:
        return None
    return view_of(trace_id, calls, truncated, repeats=repeats, window=window, money=mode != "subscription")


@dataclass
class AgentTasks:
    days: int
    repeats: int
    window: int
    tasks: list[TaskView]
    cohorts: list[Cohort]
    notes: list[str]
    method: list[str]


_TRACES = """
SELECT r.trace_id, min(j.name) AS job, count(DISTINCT j.name) AS jobs, count(*) AS calls,
       coalesce(sum(r.tokens_in + r.tokens_out + r.cache_read_tokens + r.cache_write_tokens), 0) AS tokens,
       CASE WHEN count(*) FILTER (WHERE r.cost_usd IS NOT NULL) = 0 THEN NULL ELSE sum(r.cost_usd)::float8 END AS cost,
       count(DISTINCT r.agent) AS agents, array_agg(DISTINCT r.model) AS models
FROM runs r JOIN jobs j ON j.job_id = r.job_id
WHERE r.project_id = :project AND r.run_kind = 'PRODUCTION' AND r.state <> 'INGESTION_FAILED'
  AND r.created_at >= :since AND r.created_at < :until AND r.trace_id IS NOT NULL {job}
GROUP BY r.trace_id
ORDER BY {order}, r.trace_id
LIMIT :limit
"""


async def agent_tasks(session: AsyncSession, project_id: str, *, days: int = 30, job: str | None = None, repeats: int = DEFAULT_REPEATS,
                      window: int = DEFAULT_WINDOW, mode: str = "per_use", now: datetime | None = None) -> AgentTasks:
    if days not in DAYS:
        raise ValueError(f"days must be one of {DAYS}")
    if repeats not in REPEAT_CHOICES or window not in WINDOW_CHOICES or window < repeats:
        raise ValueError("choose repeats from 3, 4, 5, 6, 8 or 10 and a window from 5, 7, 10 or 15, at least as large as repeats")
    money = mode != "subscription"
    until = (now or datetime.now(UTC)).replace(microsecond=0)
    params: dict[str, Any] = {"project": project_id, "since": until - timedelta(days=days), "until": until}
    clause = ""
    if job:
        clause, params["job"] = "AND j.name = :job", job
    order = "cost DESC NULLS LAST" if money else "tokens DESC"
    top = (await session.execute(text(_TRACES.format(job=clause, order=order)), {**params, "limit": TOP_TASKS})).all()
    every = [dict(r._mapping) for r in (await session.execute(text(_TRACES.format(job=clause, order="tokens DESC")), {**params, "limit": MAX_COHORT_TASKS})).all()]
    tasks: list[TaskView] = []
    for t in top:
        calls, truncated = await trace_calls(session, project_id, t.trace_id)
        if calls:
            tasks.append(view_of(t.trace_id, calls, truncated, repeats=repeats, window=window, money=money))
    groups, cohort_notes = cohorts(every, money=money)
    notes = list(cohort_notes)
    if not tasks:
        notes.insert(0, "No task with a trace id was recorded in this period. Send a trace_id with each call to see a task as a whole.")
    if len(every) >= MAX_COHORT_TASKS:
        notes.append(f"Only the {MAX_COHORT_TASKS:,} largest tasks were used for cohorts.")
    return AgentTasks(days=days, repeats=repeats, window=window, tasks=tasks, cohorts=groups, notes=notes, method=METHOD)


__all__ = ["METHOD", "AgentTasks", "TaskTree", "TaskView", "agent_task", "agent_tasks", "build_tree", "cohorts", "find_repeats"]
