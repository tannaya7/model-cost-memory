"""Who spends the tokens in a multi-agent or tool-heavy app: per agent, per trace, and tool definitions.

Production runs only, over the last `days` days. Counts and sums; nothing is estimated here except
`tools_tokens`, which the SDK estimated (recorder.estimate_tools_tokens).

Total tokens of a run = tokens_in + tokens_out + cache_read_tokens + cache_write_tokens.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from ..models import Job, Run

UNLABELLED = "unlabelled"
TOP_TRACES = 10
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


@dataclass
class TraceUsage:
    trace_id: str
    calls: int
    tokens: int
    spend_usd: float
    agents: int  # distinct agents (unlabelled counts as one)
    repeated_prompts: bool


@dataclass
class ToolsUsage:
    job: str
    runs: int  # runs that sent tool definitions
    avg_tools_tokens: int
    share_of_tokens_in: float  # of those runs' input tokens, 0..1


@dataclass
class AgentInsights:
    agents: list[AgentUsage]
    traces: list[TraceUsage]
    tools: list[ToolsUsage]


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
    return AgentInsights(agents=agents, traces=traces, tools=tools)
