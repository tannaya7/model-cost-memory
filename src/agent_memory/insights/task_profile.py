"""What we can prove about one task from its recorded calls. Counts and medians; no AI, no text.

Production runs only, over the last `days` days. Tool and agent labels reuse agent_kinds (the single
place those rules live). Token sizes are what the provider billed, so they are measured, not estimated.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from ..models import Job, Run
from .agent_kinds import is_multi_agent, make_step, mcp_servers, tool_source, uses_tools, works_like_agent
from .agents import MAX_STEP_ROWS

MIN_CALLS = 25  # below this the picture is too thin to describe


@dataclass
class TaskProfile:
    calls: int
    models: list[str] = field(default_factory=list)
    uses_tools: bool = False
    works_like_agent: str | None = None
    tool_source: str | None = None
    tool_servers: list[str] = field(default_factory=list)
    multi_agent: bool = False
    typical_tokens_in: int | None = None
    typical_tokens_out: int | None = None


async def task_profile(session: AsyncSession, job: Job, *, days: int = 30,
                       now: datetime | None = None) -> TaskProfile:
    since = (now or datetime.now(UTC)) - timedelta(days=days)
    scope = (Run.job_id == job.job_id, Run.project_id == job.project_id, Run.run_kind == "PRODUCTION",
             Run.created_at >= since)
    calls, med_in, med_out = (await session.execute(
        select(func.count(), func.percentile_cont(0.5).within_group(Run.tokens_in),
               func.percentile_cont(0.5).within_group(Run.tokens_out)).where(*scope))).one()
    if not calls:
        return TaskProfile(calls=0)
    cols = (Run.agent, Run.trace_id, Run.model, Run.prompt_hash, Run.tool_calls, Run.tools_tokens,
            Run.tool_call_count, Run.output, Run.cost_usd, Run.created_at)
    rows = (await session.execute(
        select(*cols).where(*scope).order_by(Run.created_at.desc()).limit(MAX_STEP_ROWS))).all()
    steps = [make_step(agent=r[0], trace_id=r[1], model=r[2], prompt_hash=r[3], tool_calls=r[4],
                       tools_tokens=r[5], tool_call_count=r[6], output=r[7], cost_usd=r[8], tokens=0,
                       created_at=r[9]) for r in reversed(rows)]
    names = [n for s in steps for n in s.tool_names]
    models = (await session.execute(
        select(Run.model).where(*scope).group_by(Run.model).order_by(func.count().desc(), Run.model))).scalars().all()
    return TaskProfile(
        calls=int(calls), models=list(models), uses_tools=uses_tools(steps), works_like_agent=works_like_agent(steps),
        tool_source=tool_source(names, any(s.offered_tools for s in steps)), tool_servers=mcp_servers(names),
        multi_agent=is_multi_agent(steps),
        typical_tokens_in=round(float(med_in)), typical_tokens_out=round(float(med_out)),
    )
