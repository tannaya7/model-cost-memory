"""MCP and tool-server visibility, from the project's own recorded calls. Analysis only: nothing here calls a tool, blocks a tool,
disables a server or changes any configuration, and it cannot reach the customer's app.

What is counted, and how sure it is:

    calls           exact: each tool call the recorder read from a response (a call seen twice with the same id in one request
                    is counted once; a result, a tool listing or an approval request is never a call)
    certainty       "provider_reported" when the provider's own response named the MCP server (Anthropic `server_name`, OpenAI
                    `server_label`); "likely" when only the tool's NAME looks like `mcp__server__tool` (a hint, never proof);
                    "mixed" when a server has both
    requests        the requests (runs) that made at least one call to the server
    request usage   the recorded usage and cost of those requests, summed over DISTINCT requests. It is the whole request's
                    usage, shared with the prompt, the answer and every other tool in it: no provider reports tokens per tool or
                    per server, so it is never presented as what the tool itself used
    request time    the median time of those requests (a request's own latency). A tool call's own duration is not reported
    tool list size  NOT attributed. Providers load an MCP server's tool list themselves and report one usage total, so the
                    share of a request's input that went on one server's tool definitions is not measurable here. The method
                    for each figure is listed in METHOD and returned with the answer

A request that called two servers appears under both, with its full usage. So server rows never add up to the total: the
total counts each request once, and `requests_with_several_servers` says how many were shared.

Privacy: the query is scoped to one project, and only labels and numbers leave it: server, tool and task names, counts, times and
token totals. Never a tool's arguments or result, and never prompt or answer text.
"""

from __future__ import annotations

import statistics
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from typing import Any

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from .agent_kinds import MCP_NAME
from .mcp_support import CHECKED_ON, SUPPORT, Support, support_for

DAYS = (7, 14, 30, 90)
MAX_CALL_ROWS = 50_000
TOP_TOOLS = 8
TOP_TASKS = 5

METHOD = [
    "Counts are exact: every tool call the recorder read from a response, once each.",
    "A server is 'provider reported' when the provider's own response named it. When only a tool's name looks like "
    "mcp__server__tool it is 'likely MCP': an app can use that spelling for any tool, and a real MCP tool can be named anything.",
    "Request usage is the whole recorded usage of the requests that called the server, shared with everything else in them. "
    "Providers report one usage total per request, never tokens per tool, so this is not the tool's own cost.",
    "A request that called two servers is shown under both with its full usage. The total counts each request once, so the rows "
    "do not add up to it.",
    "Request time is the median time of those requests. A tool call's own duration is not reported.",
    "The size of a server's tool list is not attributed: providers load it themselves and report one total, so it cannot be split "
    "by server here. It is shown as unknown, not estimated.",
]


@dataclass
class ServerRow:
    server: str
    certainty: str  # provider_reported | likely | mixed
    calls: int = 0
    failed_calls: int = 0  # calls the provider said failed
    failure_known_calls: int = 0  # calls whose result told us whether they failed
    requests: int = 0
    task_runs: int = 0  # distinct trace ids
    first_seen: datetime | None = None
    last_seen: datetime | None = None
    request_time_ms: float | None = None
    request_tokens_in: int = 0
    request_tokens_out: int = 0
    request_cache_read_tokens: int = 0
    request_cost_usd: float | None = None
    unpriced_requests: int = 0
    tools: list[tuple[str, int]] = field(default_factory=list)
    tasks: list[tuple[str, int]] = field(default_factory=list)
    providers: list[str] = field(default_factory=list)


@dataclass
class Totals:
    requests: int = 0
    requests_with_several_servers: int = 0
    tokens_in: int = 0
    tokens_out: int = 0
    cache_read_tokens: int = 0
    cost_usd: float | None = None
    unpriced_requests: int = 0


@dataclass
class OwnTools:
    calls: int = 0
    requests: int = 0
    tools: list[tuple[str, int]] = field(default_factory=list)


@dataclass
class SupportRow:
    key: str
    label: str
    native: str
    we_read: tuple[str, ...]
    we_do_not_read: tuple[str, ...]
    not_reported_by_provider: tuple[str, ...]
    limits: tuple[str, ...]
    sources: tuple[str, ...]
    checked_on: str
    seen_as: str  # the provider name recorded on the calls


@dataclass
class ToolServers:
    days: int
    since: datetime
    until: datetime
    servers: list[ServerRow]
    own_tools: OwnTools
    totals: Totals
    support: list[SupportRow]
    unreadable_calls: int
    truncated: bool
    notes: list[str]
    method: list[str]


def split_name(tool: str, server: str | None) -> tuple[str | None, str]:
    """(server, the tool's own name). A provider-named server wins; otherwise `mcp__server__tool` gives both."""
    m = MCP_NAME.match(tool)
    if server:
        return server, (m.group(2) if m and m.group(1) == server else tool)
    return (m.group(1), m.group(2)) if m else (None, tool)


def _median(values: list[float]) -> float | None:
    return statistics.median(values) if values else None


def aggregate(rows: list[dict[str, Any]], *, money: bool) -> tuple[list[ServerRow], OwnTools, Totals]:
    """Pure: the call rows (one per tool call, with its request's fields) into per-server rows, the project's own tools and
    request totals. `money` False (a flat subscription) leaves every dollar figure out."""
    seen: set[tuple[Any, str]] = set()
    by_server: dict[str, list[dict[str, Any]]] = defaultdict(list)
    own: list[dict[str, Any]] = []
    for r in rows:
        key = (r["run_id"], r["call_id"] or f"row{id(r)}")
        if key in seen:  # the same call twice in one request is one call
            continue
        seen.add(key)
        server, tool = split_name(r["tool"], r["server"] if r["source"] == "provider" else None)
        r = {**r, "tool": tool}
        if server:
            r["server"] = server
            by_server[server].append(r)
        else:
            own.append(r)

    def request_rows(calls: list[dict[str, Any]]) -> list[dict[str, Any]]:
        distinct: dict[Any, dict[str, Any]] = {}
        for c in calls:
            distinct.setdefault(c["run_id"], c)
        return list(distinct.values())

    servers: list[ServerRow] = []
    all_requests: dict[Any, dict[str, Any]] = {}
    servers_per_request: Counter = Counter()
    for server, calls in by_server.items():
        reqs = request_rows(calls)
        for q in reqs:
            all_requests.setdefault(q["run_id"], q)
            servers_per_request[q["run_id"]] += 1
        provider_calls = sum(1 for c in calls if c["source"] == "provider")
        certainty = "provider_reported" if provider_calls == len(calls) else ("likely" if provider_calls == 0 else "mixed")
        priced = [q["cost"] for q in reqs if q["cost"] is not None]
        failed_known = [c for c in calls if c["failed"] in ("true", "false")]
        servers.append(ServerRow(
            server=server, certainty=certainty, calls=len(calls),
            failed_calls=sum(1 for c in failed_known if c["failed"] == "true"), failure_known_calls=len(failed_known),
            requests=len(reqs), task_runs=len({q["trace_id"] for q in reqs if q["trace_id"]}),
            first_seen=min(c["created_at"] for c in calls), last_seen=max(c["created_at"] for c in calls),
            request_time_ms=_median([q["latency_ms"] for q in reqs if q["latency_ms"] is not None]),
            request_tokens_in=sum(q["tokens_in"] or 0 for q in reqs), request_tokens_out=sum(q["tokens_out"] or 0 for q in reqs),
            request_cache_read_tokens=sum(q["cache_read"] or 0 for q in reqs),
            request_cost_usd=sum(priced) if money and priced else None,
            unpriced_requests=sum(1 for q in reqs if q["cost"] is None) if money else 0,
            tools=sorted(Counter(c["tool"] for c in calls).items(), key=lambda kv: (-kv[1], kv[0]))[:TOP_TOOLS],
            tasks=sorted(Counter(c["job"] for c in calls).items(), key=lambda kv: (-kv[1], kv[0]))[:TOP_TASKS],
            providers=sorted({c["provider"] for c in calls if c["provider"]})))
    servers.sort(key=lambda s: (-s.calls, s.server))
    priced_all = [q["cost"] for q in all_requests.values() if q["cost"] is not None]
    totals = Totals(
        requests=len(all_requests), requests_with_several_servers=sum(1 for n in servers_per_request.values() if n > 1),
        tokens_in=sum(q["tokens_in"] or 0 for q in all_requests.values()), tokens_out=sum(q["tokens_out"] or 0 for q in all_requests.values()),
        cache_read_tokens=sum(q["cache_read"] or 0 for q in all_requests.values()),
        cost_usd=sum(priced_all) if money and priced_all else None,
        unpriced_requests=sum(1 for q in all_requests.values() if q["cost"] is None) if money else 0)
    return servers, OwnTools(
        calls=len(own), requests=len({r["run_id"] for r in own}),
        tools=sorted(Counter(r["tool"] for r in own).items(), key=lambda kv: (-kv[1], kv[0]))[:TOP_TOOLS]), totals


def support_rows(providers: list[str]) -> list[SupportRow]:
    """What each provider seen in this project's calls tells us, and the cases that stay unsupported or unknown."""
    out: list[SupportRow] = []
    for name in providers:
        s: Support | None = support_for(name)
        if s is None:
            out.append(SupportRow(
                key="unknown", label=name or "Unknown provider", native="unknown", we_read=(),
                we_do_not_read=("We have not checked how this provider reports MCP or tool-server calls.",),
                not_reported_by_provider=("Nothing is assumed: any MCP call from it would be labelled likely, from the tool's name only.",),
                limits=(), sources=(), checked_on=CHECKED_ON, seen_as=name))
        else:
            out.append(SupportRow(s.key, s.label, s.native, s.we_read, s.we_do_not_read, s.not_reported_by_provider, s.limits,
                                  s.sources, CHECKED_ON, name))
    return sorted(out, key=lambda r: (r.key == "unknown", r.label))


_CALLS = """
SELECT r.run_id, r.created_at, j.name AS job, r.trace_id, r.provider, r.latency_ms, r.tokens_in, r.tokens_out,
       r.cache_read_tokens AS cache_read, r.cost_usd::float8 AS cost,
       c.value->>'name' AS tool, c.value->>'server' AS server, c.value->>'source' AS source,
       c.value->>'id' AS call_id, c.value->>'failed' AS failed
FROM runs r
JOIN jobs j ON j.job_id = r.job_id
CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(r.tool_calls) = 'array' THEN r.tool_calls ELSE '[]'::jsonb END) AS c(value)
WHERE r.project_id = :project AND r.run_kind = 'PRODUCTION' AND r.state <> 'INGESTION_FAILED'
  AND r.created_at >= :since AND r.created_at < :until {job}
  AND jsonb_typeof(c.value) = 'object' AND jsonb_typeof(c.value->'name') = 'string'
ORDER BY r.created_at DESC, r.run_id
LIMIT :limit
"""
_UNREADABLE = """
SELECT
  (SELECT count(*) FROM runs r JOIN jobs j ON j.job_id = r.job_id
    WHERE r.project_id = :project AND r.run_kind = 'PRODUCTION' AND r.created_at >= :since AND r.created_at < :until {job}
      AND r.tool_calls IS NOT NULL AND jsonb_typeof(r.tool_calls) NOT IN ('array', 'null'))
  +
  (SELECT count(*) FROM runs r JOIN jobs j ON j.job_id = r.job_id
    CROSS JOIN LATERAL jsonb_array_elements(r.tool_calls) AS c(value)
    WHERE r.project_id = :project AND r.run_kind = 'PRODUCTION' AND r.created_at >= :since AND r.created_at < :until {job}
      AND r.tool_calls IS NOT NULL AND jsonb_typeof(r.tool_calls) = 'array'
      AND NOT COALESCE(jsonb_typeof(c.value) = 'object' AND jsonb_typeof(c.value->'name') = 'string', false))
"""
_PROVIDERS = """
SELECT DISTINCT r.provider FROM runs r JOIN jobs j ON j.job_id = r.job_id
WHERE r.project_id = :project AND r.run_kind = 'PRODUCTION' AND r.created_at >= :since AND r.created_at < :until {job}
  AND r.provider IS NOT NULL
"""


async def tool_servers(session: AsyncSession, project_id: str, *, days: int = 30, job: str | None = None, mode: str = "per_use",
                       now: datetime | None = None) -> ToolServers:
    if days not in DAYS:
        raise ValueError(f"days must be one of {DAYS}")
    until = (now or datetime.now(UTC)).replace(microsecond=0)
    since = until - timedelta(days=days)
    clause = "AND j.name = :job" if job else ""
    params: dict[str, Any] = {"project": project_id, "since": since, "until": until}
    if job:
        params["job"] = job
    rows = [dict(r._mapping) for r in (await session.execute(text(_CALLS.format(job=clause)), {**params, "limit": MAX_CALL_ROWS + 1})).all()]
    truncated = len(rows) > MAX_CALL_ROWS
    rows = rows[:MAX_CALL_ROWS]
    unreadable = int((await session.execute(text(_UNREADABLE.format(job=clause)), params)).scalar_one() or 0)
    providers = [p for (p,) in (await session.execute(text(_PROVIDERS.format(job=clause)), params)).all()]
    servers, own, totals = aggregate(rows, money=mode != "subscription")

    notes: list[str] = []
    if not rows:
        notes.append("No tool calls were recorded in this period.")
    elif not servers:
        notes.append("Tool calls were recorded, but none came from an MCP server we can recognise: none was named by the provider "
                     "and no tool name looks like mcp__server__tool. A tool-server call under another name cannot be seen.")
    if any(s.certainty != "provider_reported" for s in servers):
        notes.append("A server marked 'likely MCP' is only guessed from its tool names.")
    if unreadable:
        notes.append(f"{unreadable:,} tool-call records could not be read (not a list, or without a name) and are left out.")
    if truncated:
        notes.append(f"Only the newest {MAX_CALL_ROWS:,} tool calls were read.")
    return ToolServers(days=days, since=since, until=until, servers=servers, own_tools=own, totals=totals, support=support_rows(sorted(providers)),
                       unreadable_calls=unreadable, truncated=truncated, notes=notes, method=METHOD)


__all__ = ["DAYS", "METHOD", "SUPPORT", "ToolServers", "aggregate", "split_name", "support_rows", "tool_servers"]
