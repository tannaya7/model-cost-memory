"""Where your tokens went: which tasks, agents or prompt versions use the most tokens, and how much of a prompt is
identical in every call.

Production runs only, over the exact period [now - days, now] in UTC. Token sums are exact over every call in the
period (billed fields, nothing sampled). What each sum is made of (cached input, cache writes, reasoning, tool-use
input) is shown only where the provider's usage layout can report it (usage_ledger.py); a part that no provider
layout in the group reports is "not reported", and one that older calls could not record is "unknown", never 0.

Grouping is chosen by the caller: task and prompt version (default), task, agent, or prompt version across tasks.
Agent names and prompt versions are whatever the developer's code sent, so they are labelled as such.

The repeated-start and repeated-end shares are an ESTIMATE from the stored prompt text of the newest calls (at most
MAX_SAMPLES) of a task and version, and only when MIN_SAMPLES or more exist; they are not computed for the other
groupings, where prompts of different tasks would be mixed. Prompt text never leaves this module by default: only
shares do. A short preview of the repeated start is returned only when the caller asks for it, and has its emails,
links, keys and long numbers masked first.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta

from sqlalchemy import func, literal_column, select
from sqlalchemy.ext.asyncio import AsyncSession

from ..models import Job, Run
from ..recommend.task_summary import sanitize

MAX_SAMPLES = 50  # most recent calls with stored text used per group
MIN_SAMPLES = 5  # fewer than this and we say nothing about repeated text
PREVIEW_MIN_SHARE = 0.10
PREVIEW_CHARS = 120

_TOTAL = Run.tokens_in + Run.tokens_out + Run.cache_read_tokens + Run.cache_write_tokens


@dataclass
class Repeated:
    start_chars: int
    end_chars: int
    start_share: float
    end_share: float
    start_text: str


def _prefix_ok(prompts: list[str], n: int) -> bool:
    return all(n == len(p) or p[n].isspace() or p[n - 1].isspace() for p in prompts)


def _suffix_ok(prompts: list[str], n: int) -> bool:
    return all(n == len(p) or p[len(p) - n - 1].isspace() or p[len(p) - n].isspace() for p in prompts)


def common_prefix_len(prompts: list[str]) -> int:
    """Length of the longest common start, cut back so no word is split."""
    if not prompts:
        return 0
    n = 0
    shortest = min(len(p) for p in prompts)
    first = prompts[0]
    while n < shortest and all(p[n] == first[n] for p in prompts):
        n += 1
    while n > 0 and not _prefix_ok(prompts, n):
        n -= 1
    return n


def common_suffix_len(prompts: list[str], cap: int | None = None) -> int:
    """Length of the longest common end (at most `cap`), cut back so no word is split."""
    if not prompts:
        return 0
    shortest = min(len(p) for p in prompts)
    limit = shortest if cap is None else max(0, min(cap, shortest))
    first = prompts[0]
    n = 0
    while n < limit and all(p[len(p) - 1 - n] == first[len(first) - 1 - n] for p in prompts):
        n += 1
    while n > 0 and not _suffix_ok(prompts, n):
        n -= 1
    return n


def _preview(text: str) -> str:
    flat = " ".join(text.split())
    return flat if len(flat) <= PREVIEW_CHARS else flat[: PREVIEW_CHARS - 1].rstrip() + "…"


def repeated_parts(prompts: list[str]) -> Repeated | None:
    """What every prompt starts and ends with. None when there are too few prompts to say."""
    if len(prompts) < MIN_SAMPLES:
        return None
    mean = sum(len(p) for p in prompts) / len(prompts)
    if mean == 0:
        return Repeated(0, 0, 0.0, 0.0, "")
    start = common_prefix_len(prompts)
    # the end must not overlap the start in any single prompt
    end = common_suffix_len(prompts, cap=min(len(p) for p in prompts) - start)
    return Repeated(
        start, end,
        round(min(1.0, max(0.0, start / mean)), 3), round(min(1.0, max(0.0, end / mean)), 3),
        prompts[0][:start],
    )


GROUPINGS = ("task_version", "task", "agent", "prompt_version", "template")
NO_AGENT = "(no agent named)"
NO_VERSION = "(no version tagged)"

# Which usage layouts can report each part separately (see usage_ledger.INCLUSION; verified 2026-11-17).
REPORTS = {
    "cache_read": ("anthropic_messages", "openai_responses", "openai_chat", "deepseek_chat", "gemini"),
    "cache_write": ("anthropic_messages", "openai_responses", "openai_chat"),
    "reasoning": ("openai_responses", "openai_chat", "deepseek_chat", "gemini"),
    "tool_use_input": ("gemini",),
}


@dataclass
class TokenPart:
    key: str
    label: str
    tokens: int | None  # None = not known
    state: str  # "measured" | "not_reported" (no layout in the group reports it) | "unknown" (older or incomplete calls)
    calls: int | None  # calls that reported it, where that is known
    note: str | None = None


@dataclass
class PromptGroup:
    job: str  # "" when the grouping spans tasks
    prompt_version: str | None
    calls: int
    tokens_in: int
    tokens_out: int
    cache_read_tokens: int
    cache_write_tokens: int
    total_tokens: int
    share: float
    avg_tokens_in: float
    avg_tokens_out: float
    cache_read_share: float | None
    text_samples: int
    repeated_start_share: float | None
    repeated_end_share: float | None
    repeated_start_preview: str | None
    label: str = ""
    group_by: str = "task_version"
    agent: str | None = None
    breakdown: list[TokenPart] = field(default_factory=list)
    ledger_calls: int = 0  # calls whose usage layout was recorded
    no_usage_calls: int = 0  # calls whose response carried no usage block
    legacy_calls: int = 0  # calls recorded before the ledger existed
    text_calls: int = 0  # calls in the period whose prompt text is still stored
    text_note: str | None = None
    spend_usd: float | None = None  # list-price cost of the PRICED calls in the group; None when none is priced
    priced_calls: int = 0
    unpriced_calls: int = 0  # calls with no known cost: in no sum, never counted as free
    cost_share: float | None = None  # of the project's priced cost in the period; None when that is 0
    grouping_basis: str = "named_by_your_code"  # or "untagged": no version/agent label, so the grouping is estimated


@dataclass
class PromptInsights:
    days: int
    total_tokens: int
    groups: list[PromptGroup]
    period_start: datetime | None = None
    period_end: datetime | None = None
    timezone: str = "UTC"
    total_calls: int = 0
    group_by: str = "task_version"
    grouping_note: str = ""


GROUPING_NOTES = {
    "task_version": "Grouped by AI task and the prompt version your code tagged.",
    "task": "Grouped by AI task, all prompt versions together.",
    "agent": "Grouped by the agent name your code sent. Calls with no agent name are grouped together.",
    "prompt_version": "Grouped by the prompt version your code tagged, across all tasks.",
    "template": "Grouped by the agent, the AI task and the prompt version your code sent. Only those labels are used: "
                "prompt text is never read to decide a group, and no fingerprint of it is stored. Calls with no "
                "version are grouped by agent and task only (an estimated grouping).",
}


def _parts(*, calls, t_in, t_out, c_read, c_write, r_sum, r_calls, u_sum, u_calls, ledger, no_usage, caps) -> list[TokenPart]:
    """What the total is made of. A part is measured, "not reported" by every layout seen, or unknown; never a silent 0."""
    unreported = no_usage == calls

    def cached(key, label, tokens, cap):
        if tokens > 0 or cap > 0:
            return TokenPart(key, label, tokens, "measured", cap or None)
        return TokenPart(key, label, None, "unknown" if (unreported or ledger == 0) else "not_reported", None)

    out = [
        TokenPart("input", "Input (not cached)", None if unreported else t_in, "unknown" if unreported else "measured", None),
        cached("cached_input", "Cached input read", c_read, caps["cache_read"]),
        cached("cache_write", "Cache writes", c_write, caps["cache_write"]),
        TokenPart("output", "Output", None if unreported else t_out, "unknown" if unreported else "measured", None,
                  note="includes reasoning where the provider counts it as output"),
    ]
    if r_calls > 0:
        out.append(TokenPart("reasoning", "of which reasoning", int(r_sum or 0), "measured", r_calls))
    else:
        out.append(TokenPart("reasoning", "of which reasoning", None,
                             "not_reported" if ledger > 0 and caps["reasoning"] == 0 else "unknown", None))
    if u_calls > 0:
        out.append(TokenPart("tool_use_input", "Tool-use input", int(u_sum or 0), "measured", u_calls,
                             note="Gemini only; not in the total above because its billing is not documented"))
    else:
        out.append(TokenPart("tool_use_input", "Tool-use input", None,
                             "not_reported" if ledger > 0 and caps["tool_use_input"] == 0 else "unknown", None))
    return out


async def prompt_insights(
    session: AsyncSession, project_id: str, *, days: int = 30, job: str | None = None, limit: int = 3,
    group_by: str = "task_version", show_text: bool = False, now: datetime | None = None,
) -> PromptInsights:
    if group_by not in GROUPINGS:
        raise ValueError(f"group_by must be one of {GROUPINGS}")
    end = now or datetime.now(UTC)
    since = end - timedelta(days=days)
    scope = (Run.project_id == project_id, Run.run_kind == "PRODUCTION", Run.created_at >= since, Run.created_at <= end)

    grand = int((await session.execute(select(func.coalesce(func.sum(_TOTAL), 0)).where(*scope))).scalar_one())
    total_calls = int((await session.execute(select(func.count()).where(*scope))).scalar_one())
    grand_cost = float((await session.execute(select(func.coalesce(func.sum(Run.cost_usd), 0)).where(*scope))).scalar_one())

    total = func.coalesce(func.sum(_TOTAL), 0).label("total")
    shaped = Run.usage_shape.is_not(None) & (Run.usage_shape != "none")
    by_task = group_by in ("task_version", "task", "template")
    name_col = Job.name if by_task else literal_column("''")
    id_col = Run.job_id if by_task else literal_column("NULL")
    ver_col = Run.prompt_version if group_by in ("task_version", "prompt_version", "template") else literal_column("NULL")
    agent_col = Run.agent if group_by in ("agent", "template") else literal_column("NULL")
    keys = [c for c, used in ((Job.name, by_task), (Run.job_id, by_task),
                              (Run.prompt_version, group_by in ("task_version", "prompt_version", "template")),
                              (Run.agent, group_by in ("agent", "template"))) if used]
    query = (
        select(name_col.label("name"), id_col.label("job_id"), ver_col.label("version"), agent_col.label("agent"),
               func.count(),
               func.coalesce(func.sum(Run.tokens_in), 0), func.coalesce(func.sum(Run.tokens_out), 0),
               func.coalesce(func.sum(Run.cache_read_tokens), 0), func.coalesce(func.sum(Run.cache_write_tokens), 0),
               total,
               func.sum(Run.reasoning_tokens), func.count(Run.reasoning_tokens),
               func.sum(Run.tool_use_input_tokens), func.count(Run.tool_use_input_tokens),
               func.count().filter(shaped), func.count().filter(Run.usage_shape == "none"),
               func.count().filter(Run.usage_shape.is_(None)),
               func.count().filter(Run.usage_shape.in_(REPORTS["cache_read"])),
               func.count().filter(Run.usage_shape.in_(REPORTS["cache_write"])),
               func.count().filter(Run.usage_shape.in_(REPORTS["reasoning"])),
               func.count().filter(Run.usage_shape.in_(REPORTS["tool_use_input"])),
               func.count().filter(Run.prompt.is_not(None) & Run.content_removed_at.is_(None)),
               func.sum(Run.cost_usd), func.count(Run.cost_usd))
        .join(Job, Job.job_id == Run.job_id).where(*scope)
        .group_by(*keys)
        .order_by(total.desc(), *keys).limit(limit)  # real columns only: Postgres rejects a constant in ORDER BY
    )
    if job is not None:
        query = query.where(Job.name == job)
    rows = (await session.execute(query)).all()

    groups: list[PromptGroup] = []
    for (name, job_id, version, agent, calls, t_in, t_out, c_read, c_write, tot, r_sum, r_calls, u_sum, u_calls,
         ledger, no_usage, legacy, cap_read, cap_write, cap_reason, cap_tool, text_calls, spend, priced) in rows:
        t_in, t_out, c_read, c_write, tot = int(t_in), int(t_out), int(c_read), int(c_write), int(tot)
        caps = {"cache_read": int(cap_read), "cache_write": int(cap_write), "reasoning": int(cap_reason),
                "tool_use_input": int(cap_tool)}
        texts: list[str] = []
        text_note: str | None = None
        if group_by in ("task_version", "template"):
            same_version = Run.prompt_version.is_(None) if version is None else Run.prompt_version == version
            same_agent = (Run.agent.is_(None) if agent is None else Run.agent == agent) if group_by == "template" else True
            texts = list((
                await session.execute(
                    select(Run.prompt).where(*scope, Run.job_id == job_id, same_version, same_agent,
                                             Run.content_removed_at.is_(None), Run.prompt.is_not(None))
                    .order_by(Run.created_at.desc()).limit(MAX_SAMPLES)
                )
            ).scalars().all())
        else:
            text_note = "The repeated-text split is only worked out for one task and prompt version at a time."
        found = repeated_parts(texts)
        preview = None
        if show_text and found and found.start_share >= PREVIEW_MIN_SHARE and found.start_text.strip():
            preview = _preview(sanitize(found.start_text))  # emails, links, keys and long numbers masked first
        denom = c_read + t_in
        if group_by == "task_version":
            label = name + (f" · version {version}" if version else "")
        elif group_by == "task":
            label = name
        elif group_by == "agent":
            label = agent or NO_AGENT
        elif group_by == "template":
            label = f"{agent or NO_AGENT} · {name} · {('version ' + version) if version else 'untagged'}"
        else:
            label = version or NO_VERSION
        untagged = (group_by in ("task_version", "prompt_version", "template") and version is None) or (
            group_by == "agent" and agent is None)
        groups.append(PromptGroup(
            job=name, prompt_version=version, calls=calls, tokens_in=t_in, tokens_out=t_out,
            cache_read_tokens=c_read, cache_write_tokens=c_write, total_tokens=tot,
            share=tot / grand if grand else 0.0,
            avg_tokens_in=t_in / calls if calls else 0.0, avg_tokens_out=t_out / calls if calls else 0.0,
            cache_read_share=c_read / denom if denom else None,
            text_samples=len(texts),
            repeated_start_share=found.start_share if found else None,
            repeated_end_share=found.end_share if found else None,
            repeated_start_preview=preview,
            label=label, group_by=group_by, agent=agent,
            breakdown=_parts(calls=calls, t_in=t_in, t_out=t_out, c_read=c_read, c_write=c_write,
                             r_sum=r_sum, r_calls=int(r_calls), u_sum=u_sum, u_calls=int(u_calls),
                             ledger=int(ledger), no_usage=int(no_usage), caps=caps),
            ledger_calls=int(ledger), no_usage_calls=int(no_usage), legacy_calls=int(legacy),
            text_calls=int(text_calls), text_note=text_note,
            spend_usd=float(spend) if spend is not None else None, priced_calls=int(priced),
            unpriced_calls=int(calls) - int(priced),
            cost_share=(float(spend) / grand_cost) if spend is not None and grand_cost > 0 else None,
            grouping_basis="untagged" if untagged else "named_by_your_code",
        ))
    return PromptInsights(days=days, total_tokens=grand, groups=groups, period_start=since, period_end=end,
                          total_calls=total_calls, group_by=group_by, grouping_note=GROUPING_NOTES[group_by])
