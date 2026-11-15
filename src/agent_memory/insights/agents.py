"""Who spends the tokens in a multi-agent or tool-heavy app: per agent, per trace, and tool definitions.

Production runs only, over the last `days` days. Counts and sums; nothing is estimated here except
`tools_tokens`, which the SDK estimated (recorder.estimate_tools_tokens).

Total tokens of a run = tokens_in + tokens_out + cache_read_tokens + cache_write_tokens.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from ..models import Job, Run
from .agent_kinds import (
    Loop,
    Step,
    detect_loop,
    is_multi_agent,
    make_step,
    mcp_servers,
    tool_source,
    top_tools,
    uses_tools,
    works_like_agent,
)

UNLABELLED = "unlabelled"
TOP_TRACES = 10
MAX_STEP_ROWS = 5000  # most recent calls read to label tool use; bounds the work on a big project
REPEAT_THRESHOLD = 3  # the same prompt this many times inside one trace: likely a retry loop

_TOTAL = Run.tokens_in + Run.tokens_out + Run.cache_read_tokens + Run.cache_write_tokens
_INPUT = Run.tokens_in + Run.cache_read_tokens + Run.cache_write_tokens  # tool definitions are inside these


@dataclass
class AgentUsage:
    agent: str
    runs: int
    tokens_in: int
    tokens_out: int
    cache_read_tokens: int
    spend_usd: float
    share: float  # of the project's total tokens in the window, 0..1
    models: list[str] = field(default_factory=list)
    uses_tools: bool = False
    works_like_agent: str | None = None  # "yes" | "probably" | None
    tool_source: str | None = None  # "mcp" | "tool_list" | None
    tool_servers: list[str] = field(default_factory=list)
    top_tools: list[tuple[str, int]] = field(default_factory=list)
    steps_per_task: float | None = None  # calls per trace id; None when no trace ids were sent


@dataclass
class TraceUsage:
    trace_id: str
    calls: int
    tokens: int
    spend_usd: float
    agents: int  # distinct agents (unlabelled counts as one)
    repeated_prompts: bool
    agent_names: list[str] = field(default_factory=list)
    multi_agent: bool = False
    possible_loop: Loop | None = None


@dataclass
class ToolsUsage:
    job: str
    runs: int  # runs that sent tool definitions
    avg_tools_tokens: int
    share_of_tokens_in: float  # of those runs' input tokens, 0..1


@dataclass
class UsageKinds:
    """How the whole app uses AI, worked out from its calls (agent_kinds.py)."""

    calls: int = 0
    uses_tools: bool = False
    works_like_agent: str | None = None
    tool_source: str | None = None
    tool_servers: list[str] = field(default_factory=list)
    multi_agent: bool = False


@dataclass
class AgentInsights:
    agents: list[AgentUsage]
    traces: list[TraceUsage]
    tools: list[ToolsUsage]
    kinds: UsageKinds = field(default_factory=UsageKinds)


async def agent_insights(
    session: AsyncSession, project_id: str, *, days: int = 30, now: datetime | None = None
) -> AgentInsights:
    since = (now or datetime.now(UTC)) - timedelta(days=days)
    scope = (Run.project_id == project_id, Run.run_kind == "PRODUCTION", Run.created_at >= since)
    label = func.coalesce(Run.agent, UNLABELLED)

    rows = (
        await session.execute(
            select(label, func.count(), func.sum(Run.tokens_in), func.sum(Run.tokens_out),
                   func.sum(Run.cache_read_tokens), func.coalesce(func.sum(Run.cost_usd), 0), func.sum(_TOTAL))
            .where(*scope).group_by(label)
        )
    ).all()
    grand = sum(int(r[6]) for r in rows)
    agents = sorted(
        (AgentUsage(r[0], r[1], int(r[2]), int(r[3]), int(r[4]), float(r[5]), int(r[6]) / grand if grand else 0.0)
         for r in rows),
        key=lambda a: (-a.share, a.agent),
    )

    total = func.sum(_TOTAL).label("total")
    top = (
        await session.execute(
            select(Run.trace_id, func.count(), total, func.coalesce(func.sum(Run.cost_usd), 0),
                   func.count(func.distinct(label)))
            .where(*scope, Run.trace_id.is_not(None)).group_by(Run.trace_id)
            .order_by(total.desc(), Run.trace_id).limit(TOP_TRACES)
        )
    ).all()
    repeated: set[str] = set()
    if top:
        looping = await session.execute(
            select(Run.trace_id).where(*scope, Run.trace_id.in_([t[0] for t in top]))
            .group_by(Run.trace_id, Run.prompt_hash).having(func.count() >= REPEAT_THRESHOLD)
        )
        repeated = {r[0] for r in looping}
    traces = [TraceUsage(t[0], t[1], int(t[2]), float(t[3]), t[4], t[0] in repeated) for t in top]

    tool_rows = (
        await session.execute(
            select(Job.name, func.count(), func.avg(Run.tools_tokens), func.sum(Run.tools_tokens), func.sum(_INPUT))
            .join(Job, Job.job_id == Run.job_id)
            .where(*scope, Run.tools_tokens.is_not(None), Run.tools_tokens > 0).group_by(Job.name)
        )
    ).all()
    tools = sorted(
        (ToolsUsage(name, n, round(float(avg)), int(tool_sum) / int(inp) if inp else 0.0)
         for name, n, avg, tool_sum, inp in tool_rows),
        key=lambda t: (-t.avg_tools_tokens, t.job),
    )
    # Labels: read the most recent calls once, then group in memory with pure functions.
    cols = (Run.agent, Run.trace_id, Run.model, Run.prompt_hash, Run.tool_calls, Run.tools_tokens,
            Run.tool_call_count, Run.output, Run.cost_usd, Run.created_at, _TOTAL)
    recent = (
        await session.execute(select(*cols).where(*scope).order_by(Run.created_at.desc()).limit(MAX_STEP_ROWS))
    ).all()
    steps = [_step(r) for r in reversed(recent)]
    by_agent: dict[str, list[Step]] = {}
    for st in steps:
        by_agent.setdefault(st.agent or UNLABELLED, []).append(st)
    for a in agents:
        mine = by_agent.get(a.agent, [])
        names = [n for st in mine for n in st.tool_names]
        a.models = sorted({st.model for st in mine})
        a.uses_tools = uses_tools(mine)
        a.works_like_agent = works_like_agent(mine)
        a.tool_source = tool_source(names, any(st.offered_tools for st in mine))
        a.tool_servers = mcp_servers(names)
        a.top_tools = top_tools(names)
        task_ids = {st.trace_id for st in mine if st.trace_id}
        if task_ids:
            a.steps_per_task = round(sum(1 for st in mine if st.trace_id) / len(task_ids), 1)
    if traces:
        in_trace = (
            await session.execute(
                select(*cols).where(*scope, Run.trace_id.in_([t.trace_id for t in traces]))
                .order_by(Run.created_at, Run.run_id).limit(MAX_STEP_ROWS)
            )
        ).all()
        grouped: dict[str, list[Step]] = {}
        for r in in_trace:
            grouped.setdefault(r[1], []).append(_step(r))
        for t in traces:
            group = grouped.get(t.trace_id, [])
            t.agent_names = sorted({st.agent for st in group if st.agent})
            t.multi_agent = is_multi_agent(group)
            t.possible_loop = detect_loop(group)
    all_names = [n for st in steps for n in st.tool_names]
    kinds = UsageKinds(
        calls=len(steps), uses_tools=uses_tools(steps), works_like_agent=works_like_agent(steps),
        tool_source=tool_source(all_names, any(st.offered_tools for st in steps)),
        tool_servers=mcp_servers(all_names), multi_agent=is_multi_agent(steps),
    )
    return AgentInsights(agents=agents, traces=traces, tools=tools, kinds=kinds)


def _step(r: Any) -> Step:
    return make_step(agent=r[0], trace_id=r[1], model=r[2], prompt_hash=r[3], tool_calls=r[4], tools_tokens=r[5],
                     tool_call_count=r[6], output=r[7], cost_usd=r[8], tokens=int(r[10] or 0), created_at=r[9])
