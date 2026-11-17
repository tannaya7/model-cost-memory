"""Plain-language labels for how an app uses AI, worked out from the calls it already sent. Pure functions.

Nothing here asks the user anything. Every label states how sure it is:

- uses tools: certain (tool definitions were sent, or the answer asked for a tool).
- works like an agent: "yes" when several calls share a trace id and tool use repeats across them;
  "probably" when there is no trace id but one agent label made tool calls in several separate calls.
- tool servers (MCP): only when tool names look like `mcp__server__tool`. Otherwise it is a "tool list".
- several agents: only when more than one distinct agent label shares one trace.
- possible loop: the same step repeated (see `detect_loop`).
"""

from __future__ import annotations

import hashlib
import json
import re
from collections import Counter
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any

MCP_NAME = re.compile(r"^mcp__([A-Za-z0-9_.-]+?)__(.+)$")
MIN_AGENT_CALLS = 3  # calls in one trace (or one label) before "works like an agent" is considered
MIN_TOOL_CALLS_OFFERED = 2  # of those, calls that used a tool
LOOP_WINDOW = 7
LOOP_REPEATS = 5


@dataclass
class Step:
    """One recorded call, reduced to what the labels need."""

    agent: str | None
    trace_id: str | None
    model: str
    prompt_hash: str
    tool_names: list[str] = field(default_factory=list)
    arguments_hash: str | None = None  # only when the project chose to store arguments
    output_hash: str | None = None
    tools_tokens: int = 0
    tool_call_count: int = 0
    cost_usd: float = 0.0
    tokens: int = 0
    created_at: datetime | None = None

    @property
    def used_tools(self) -> bool:
        return bool(self.tool_names) or self.tool_call_count > 0

    @property
    def offered_tools(self) -> bool:
        return self.tools_tokens > 0


def _hash(value: Any) -> str:
    return hashlib.sha256(json.dumps(value, sort_keys=True, default=str).encode()).hexdigest()[:16]


def make_step(
    *, agent: str | None, trace_id: str | None, model: str, prompt_hash: str, tool_calls: Any,
    tools_tokens: int | None, tool_call_count: int | None, output: str | None, cost_usd: Any, tokens: int,
    created_at: datetime | None,
) -> Step:
    """Build a Step from one stored run. Tool arguments exist only if the project stored them."""
    names: list[str] = []
    args: list[Any] = []
    if isinstance(tool_calls, list):
        for c in tool_calls:
            if isinstance(c, dict) and c.get("name"):
                names.append(str(c["name"]))
                if c.get("arguments") is not None:
                    args.append([c["name"], c["arguments"]])
    return Step(
        agent=agent, trace_id=trace_id, model=model, prompt_hash=prompt_hash, tool_names=names,
        arguments_hash=_hash(args) if args else None, output_hash=_hash(output) if output else None,
        tools_tokens=tools_tokens or 0, tool_call_count=tool_call_count or 0,
        cost_usd=float(cost_usd or 0), tokens=tokens, created_at=created_at,
    )


def is_mcp_name(name: str) -> bool:
    return MCP_NAME.match(name) is not None


def mcp_servers(names: list[str]) -> list[str]:
    """Server names found in `mcp__server__tool` names, most used first."""
    c = Counter(m.group(1) for n in names if (m := MCP_NAME.match(n)))
    return [s for s, _ in c.most_common()]


def tool_source(names: list[str], offered: bool) -> str | None:
    """"mcp" only when a tool name matches mcp__server__tool; "tool_list" for any other tools."""
    if any(is_mcp_name(n) for n in names):
        return "mcp"
    return "tool_list" if names or offered else None


def top_tools(names: list[str], limit: int = 5) -> list[tuple[str, int]]:
    return sorted(Counter(names).items(), key=lambda kv: (-kv[1], kv[0]))[:limit]


def uses_tools(steps: list[Step]) -> bool:
    return any(s.used_tools or s.offered_tools for s in steps)


def works_like_agent(steps: list[Step]) -> str | None:
    """"yes", "probably" or None for one agent's (or one app's) calls."""
    by_trace: dict[str, list[Step]] = {}
    for s in steps:
        if s.trace_id:
            by_trace.setdefault(s.trace_id, []).append(s)
    for group in by_trace.values():
        if len(group) >= MIN_AGENT_CALLS and sum(1 for s in group if s.used_tools) >= MIN_TOOL_CALLS_OFFERED:
            return "yes"
    loose = [s for s in steps if not s.trace_id]
    if len(loose) >= MIN_AGENT_CALLS and sum(1 for s in loose if s.used_tools) >= MIN_TOOL_CALLS_OFFERED:
        return "probably"
    return None


def is_multi_agent(steps: list[Step]) -> bool:
    """True when more than one distinct, named agent label shares a single trace."""
    labels: dict[str, set[str]] = {}
    for s in steps:
        if s.trace_id and s.agent:
            labels.setdefault(s.trace_id, set()).add(s.agent)
    return any(len(v) > 1 for v in labels.values())


@dataclass
class Loop:
    step: str  # what repeated, in words
    repeats: int
    cost_usd: float
    uses_arguments: bool  # False: matched on tool name + identical prompt only


def _signature(s: Step) -> tuple[str, str]:
    tools = ",".join(sorted(s.tool_names))
    return (tools, s.arguments_hash or f"prompt:{s.prompt_hash}")


def detect_loop(steps: list[Step]) -> Loop | None:
    """Possible loop inside one trace (steps oldest first): the same signature at least 5 times in some
    window of 7 steps, with no sign of progress.

    Signature = tool name(s) + a hash of the arguments when they were stored; otherwise tool name(s) + the
    identical prompt. Progress guard: when the repeated steps have stored answers and most are different from
    each other, the agent is probably moving forward, so nothing is flagged. Beta: thresholds are rules of
    thumb, not measured."""
    if len(steps) < LOOP_REPEATS:
        return None
    best: tuple[int, list[Step]] | None = None
    size = min(LOOP_WINDOW, len(steps))
    for i in range(len(steps) - size + 1):
        window = steps[i : i + size]
        for sig, n in Counter(_signature(s) for s in window).items():
            if n < LOOP_REPEATS:
                continue
            repeated = [s for s in window if _signature(s) == sig]
            outs = [s.output_hash for s in repeated]
            if all(outs) and len(set(outs)) > len(outs) / 2:
                continue  # results keep changing: progress, not a loop
            if best is None or n > best[0]:
                best = (n, repeated)
    if best is None:
        return None
    n, repeated = best
    first = repeated[0]
    what = "the " + (" and ".join(sorted(set(first.tool_names))) + " tool") if first.tool_names else "the same question"
    return Loop(
        step=what, repeats=n, cost_usd=sum(s.cost_usd for s in repeated),
        uses_arguments=first.arguments_hash is not None,
    )
