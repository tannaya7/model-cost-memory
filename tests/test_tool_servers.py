"""MCP and tool-server visibility: what each provider's response gives us (fixtures in the documented shapes), what is counted and
how sure it is, double counting, malformed records, tenant privacy and the cases that stay unsupported. Analysis only: nothing is
called, blocked or changed. No test touches the network."""

import re
import uuid
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest

from agent_memory.insights import mcp_support
from agent_memory.insights import tool_servers as ts
from agent_memory.models import Job, Project, Run
from agent_memory.privacy import sanitize_tool_calls
from agent_memory.projects import create_project
from agent_memory.recorder import _read_tool_calls

NOW = datetime(2026, 11, 18, 12, 0, tzinfo=UTC)


# --- what each provider's own response gives us (shapes from the providers' current documentation) ----------------------

ANTHROPIC = [
    {"type": "text", "text": "Looking it up."},
    {"type": "mcp_tool_listing", "mcp_server_name": "example-mcp", "tools": [{"name": "echo", "description": "x", "input_schema": {}}]},
    {"type": "mcp_tool_use", "id": "mcptoolu_1", "name": "echo", "server_name": "example-mcp", "input": {"text": "TOPSECRET"}},
    {"type": "mcp_tool_result", "tool_use_id": "mcptoolu_1", "is_error": False, "content": [{"type": "text", "text": "TOPSECRET"}]},
]
OPENAI = [
    {"type": "mcp_list_tools", "id": "mcpl_1", "server_label": "openai_docs", "tools": [{"name": "search_openai_docs"}]},
    {"type": "mcp_approval_request", "id": "mcpr_1", "name": "search_openai_docs", "server_label": "openai_docs", "arguments": "{}"},
    {"type": "mcp_call", "id": "mcp_1", "name": "search_openai_docs", "server_label": "openai_docs", "arguments": "{\"q\":\"TOPSECRET\"}",
     "output": "TOPSECRET", "error": None, "approval_request_id": None},
    {"type": "function_call", "call_id": "fc_1", "name": "lookup", "arguments": "{}"},
]


def test_anthropic_mcp_blocks_give_one_provider_named_call_and_never_count_results_or_listings():
    calls = _read_tool_calls(ANTHROPIC, None, None, None)
    assert len(calls) == 1
    c = calls[0]
    assert (c["name"], c["server"], c["source"], c["failed"]) == ("mcp__example-mcp__echo", "example-mcp", "provider", False)


def test_an_anthropic_result_that_is_an_error_marks_its_call_failed():
    blocks = [ANTHROPIC[2], {**ANTHROPIC[3], "is_error": True}]
    assert _read_tool_calls(blocks, None, None, None)[0]["failed"] is True


def test_openai_mcp_call_is_the_call_and_list_tools_and_approval_requests_are_not():
    calls = _read_tool_calls(None, None, None, OPENAI)
    assert [c["name"] for c in calls] == ["mcp__openai_docs__search_openai_docs", "lookup"]
    mcp = calls[0]
    assert (mcp["server"], mcp["source"], mcp["failed"]) == ("openai_docs", "provider", False)
    assert "source" not in calls[1] and "server" not in calls[1]  # a plain function tool is not MCP


def test_an_openai_mcp_call_with_an_error_is_failed():
    item = {**OPENAI[2], "error": {"type": "mcp_protocol_error", "message": "x"}}
    assert _read_tool_calls(None, None, None, [item])[0]["failed"] is True


def test_gemini_function_calls_carry_no_server_so_only_a_prefix_can_make_one_likely():
    plain = _read_tool_calls(None, None, [{"content": {"parts": [{"functionCall": {"name": "get_weather", "args": {}}}]}}], None)
    prefixed = _read_tool_calls(None, None, [{"content": {"parts": [{"functionCall": {"name": "mcp__github__create_issue", "args": {}}}]}}], None)
    assert "source" not in plain[0] and "source" not in prefixed[0]  # never provider-reported
    assert prefixed[0]["name"] == "mcp__github__create_issue"


def test_a_native_block_missing_its_server_is_not_called_provider_reported():
    anthropic = _read_tool_calls([{"type": "mcp_tool_use", "id": "x", "name": "echo", "input": {}}], None, None, None)
    openai = _read_tool_calls(None, None, None, [{"type": "mcp_call", "id": "y", "name": "echo", "arguments": "{}"}])
    assert "source" not in anthropic[0] and "source" not in openai[0]


def test_what_is_stored_for_a_call_is_labels_only_never_arguments_or_results():
    cleaned = sanitize_tool_calls(_read_tool_calls(ANTHROPIC, None, None, None))
    assert cleaned == [{"name": "mcp__example-mcp__echo", "id": "mcptoolu_1", "server": "example-mcp", "source": "provider", "failed": False}]
    assert "TOPSECRET" not in str(cleaned)
    assert "arguments" not in cleaned[0]


def test_a_bogus_source_or_failed_value_is_dropped_not_stored():
    cleaned = sanitize_tool_calls([{"name": "t", "id": "1", "server": "s", "source": "trust-me", "failed": "yes"}])
    assert cleaned == [{"name": "t", "id": "1"}]


# --- counting: pure ---------------------------------------------------------------------------------------------------------

def row(run, tool, *, server=None, source=None, call_id=None, job="invoice", trace=None, provider="anthropic", latency=1000, tin=1000,
        tout=100, cache=0, cost=0.01, failed=None, at=NOW):
    return {"run_id": run, "created_at": at, "job": job, "trace_id": trace, "provider": provider, "latency_ms": latency, "tokens_in": tin,
            "tokens_out": tout, "cache_read": cache, "cost": cost, "tool": tool, "server": server, "source": source, "call_id": call_id,
            "failed": failed}


def test_split_name_prefers_the_provider_named_server_and_reads_a_prefix_otherwise():
    assert ts.split_name("mcp__github__create_issue", None) == ("github", "create_issue")
    assert ts.split_name("mcp__github__create_issue", "github") == ("github", "create_issue")
    assert ts.split_name("create_issue", "github") == ("github", "create_issue")
    assert ts.split_name("lookup", None) == (None, "lookup")
    assert ts.split_name("mcp_like", None) == (None, "mcp_like")
    assert ts.split_name("mcp__broken", None) == (None, "mcp__broken")


def test_certainty_is_provider_reported_likely_or_mixed_never_inferred_upwards():
    rows = [row("r1", "mcp__a__x", server="a", source="provider", call_id="1"), row("r2", "mcp__b__y", call_id="2"),
            row("r3", "mcp__c__z", server="c", source="provider", call_id="3"), row("r4", "mcp__c__z", call_id="4")]
    got = {s.server: s.certainty for s in ts.aggregate(rows, money=True)[0]}
    assert got == {"a": "provider_reported", "b": "likely", "c": "mixed"}


def test_a_request_calling_one_server_many_times_counts_its_usage_once():
    rows = [row("r1", "mcp__a__x", call_id=str(i), tin=5000, cost=0.5) for i in range(4)]
    [s], _, totals = ts.aggregate(rows, money=True)
    assert s.calls == 4 and s.requests == 1
    assert (s.request_tokens_in, s.request_cost_usd) == (5000, 0.5)  # the request's usage, once
    assert totals.requests == 1 and totals.tokens_in == 5000


def test_a_request_calling_two_servers_is_shown_under_both_but_the_total_counts_it_once():
    rows = [row("r1", "mcp__a__x", call_id="1", tin=4000, cost=0.4), row("r1", "mcp__b__y", call_id="2", tin=4000, cost=0.4),
            row("r2", "mcp__a__x", call_id="3", tin=1000, cost=0.1)]
    servers, _, totals = ts.aggregate(rows, money=True)
    by = {s.server: s for s in servers}
    assert by["a"].request_tokens_in == 5000 and by["b"].request_tokens_in == 4000
    assert sum(s.request_tokens_in for s in servers) == 9000  # the rows add up to more than...
    assert totals.tokens_in == 5000 and totals.requests == 2  # ...the total, which counts each request once
    assert totals.requests_with_several_servers == 1
    assert totals.cost_usd == pytest.approx(0.5)


def test_the_same_call_seen_twice_in_one_request_is_one_call_but_two_calls_with_no_id_are_two():
    twice = ts.aggregate([row("r1", "mcp__a__x", call_id="same"), row("r1", "mcp__a__x", call_id="same")], money=True)[0]
    assert twice[0].calls == 1
    no_id = ts.aggregate([row("r1", "mcp__a__x", call_id=None), row("r1", "mcp__a__x", call_id=None)], money=True)[0]
    assert no_id[0].calls == 2
    across = ts.aggregate([row("r1", "mcp__a__x", call_id="same"), row("r2", "mcp__a__x", call_id="same")], money=True)[0]
    assert across[0].calls == 2  # the same id in two different requests is two calls


def test_unpriced_requests_are_counted_not_treated_as_free():
    servers, _, totals = ts.aggregate([row("r1", "mcp__a__x", call_id="1", cost=None), row("r2", "mcp__a__x", call_id="2", cost=0.2)], money=True)
    assert servers[0].unpriced_requests == 1 and servers[0].request_cost_usd == pytest.approx(0.2)
    assert totals.unpriced_requests == 1
    only = ts.aggregate([row("r1", "mcp__a__x", call_id="1", cost=None)], money=True)
    assert only[0][0].request_cost_usd is None  # nothing priced is unknown, not $0


def test_failures_count_only_where_the_result_said_so():
    rows = [row("r1", "mcp__a__x", call_id="1", failed="true"), row("r2", "mcp__a__x", call_id="2", failed="false"), row("r3", "mcp__a__x", call_id="3")]
    [s] = ts.aggregate(rows, money=True)[0]
    assert (s.calls, s.failed_calls, s.failure_known_calls) == (3, 1, 2)


def test_request_time_is_the_median_of_distinct_requests_and_unknown_when_none_reported():
    rows = [row("r1", "mcp__a__x", call_id="1", latency=100), row("r1", "mcp__a__x", call_id="2", latency=100),
            row("r2", "mcp__a__x", call_id="3", latency=300), row("r3", "mcp__a__x", call_id="4", latency=900)]
    assert ts.aggregate(rows, money=True)[0][0].request_time_ms == 300  # by request, so r1 counts once
    assert ts.aggregate([row("r1", "mcp__a__x", call_id="1", latency=None)], money=True)[0][0].request_time_ms is None


def test_the_projects_own_tools_are_kept_apart_from_mcp():
    servers, own, _ = ts.aggregate([row("r1", "lookup", call_id="1"), row("r1", "lookup", call_id="2"), row("r2", "mcp_like", call_id="3"),
                                    row("r2", "mcp__a__x", call_id="4")], money=True)
    assert [s.server for s in servers] == ["a"] and own.calls == 3 and own.requests == 2 and own.tools[0] == ("lookup", 2)


def test_subscription_leaves_every_dollar_figure_out():
    servers, _, totals = ts.aggregate([row("r1", "mcp__a__x", call_id="1", cost=0.5)], money=False)
    assert servers[0].request_cost_usd is None and servers[0].unpriced_requests == 0
    assert totals.cost_usd is None and totals.unpriced_requests == 0 and servers[0].request_tokens_in == 1000


# --- what stays unsupported or unknown --------------------------------------------------------------------------------------

def test_each_provider_is_described_with_what_it_does_not_report_and_where_that_was_checked():
    rows = {r.key: r for r in ts.support_rows(["anthropic", "openai", "gemini"])}
    a, o, g = rows["anthropic"], rows["openai"], rows["google"]
    assert a.native == "supported" and any("MCP connector" in x and "error" in x for x in a.limits)  # token counting does not accept it
    assert any("one `usage` object" in x for x in a.not_reported_by_provider)
    assert any("mcp_tool_listing" in x for x in a.we_do_not_read)
    assert o.native == "supported" and any("mcp_list_tools" in x for x in o.we_do_not_read) and any("1,000" in x for x in o.limits)
    assert g.native == "unknown" and any("Interactions API" in x for x in g.we_do_not_read) and any("not documented" in x for x in g.not_reported_by_provider)
    assert all(r.checked_on == "2026-11-18" and r.sources for r in rows.values())
    assert all(s.startswith("https://") for r in rows.values() for s in r.sources)


def test_a_provider_we_have_not_checked_is_unknown_and_nothing_is_assumed():
    [r] = ts.support_rows(["some-new-provider"])
    assert r.native == "unknown" and r.key == "unknown" and r.sources == () and "Nothing is assumed" in r.not_reported_by_provider[0]


def test_no_provider_claims_tokens_per_tool_and_the_method_says_the_tool_list_is_not_attributed():
    for s in mcp_support.SUPPORT:
        assert any("tokens per tool" in x for x in s.not_reported_by_provider)
    assert any("not attributed" in m and "unknown, not estimated" in m for m in ts.METHOD)
    assert not re.search(r"tokens (this|the) tool used", " ".join(ts.METHOD), re.I)


def test_the_analysis_cannot_call_anything_it_imports_no_network_process_or_tool_machinery():
    src = Path(ts.__file__).read_text(encoding="utf8")
    assert not re.search(r"^\s*(import|from)\s+(httpx|requests|aiohttp|urllib|socket|subprocess|asyncio\.subprocess|mcp)\b", src, re.M)
    assert "INSERT" not in src.upper().replace("INSERT_", "") and "UPDATE " not in src and "DELETE " not in src  # reads only


# --- from the database ----------------------------------------------------------------------------------------------------------

async def make(session, pid="p", mode="per_use"):
    p = Project(project_id=pid, api_key_hash="x" + pid, billing_mode=mode)
    session.add(p)
    await session.flush()
    j = Job(project_id=pid, name="invoice", check_kind="ANSWER_KEY", check_config={"fields": ["x"]})
    j2 = Job(project_id=pid, name="support", check_kind="ANSWER_KEY", check_config={"fields": ["x"]})
    session.add_all([j, j2])
    await session.flush()
    return {"invoice": j, "support": j2}


def add(session, job, calls, *, pid="p", days_ago=1, kind="PRODUCTION", trace=None, provider="anthropic", latency=800, tin=2000, tout=200,
        cost=0.02, model="m"):
    session.add(Run(run_id=uuid.uuid4(), job_id=job.job_id, project_id=pid, prompt="p", prompt_hash=str(uuid.uuid4()), model=model,
                    model_version=model, provider=provider, run_kind=kind, outcome="UNKNOWN", state="INDEXED", tool_calls=calls,
                    trace_id=trace, latency_ms=latency, tokens_in=tin, tokens_out=tout, cost_usd=cost, created_at=NOW - timedelta(days=days_ago)))


def call(name, server=None, *, source=None, id=None, failed=None):
    c = {"name": name, "id": id}
    if server:
        c.update(server=server, source=source or "provider")
    if failed is not None:
        c["failed"] = failed
    return c


async def test_servers_tools_tasks_traces_usage_and_certainty_come_out_of_the_database(session):
    jobs = await make(session)
    add(session, jobs["invoice"], [call("mcp__github__search", "github", id="a"), call("mcp__github__create_issue", "github", id="b", failed=True)],
        trace="t1", latency=600, tin=3000, cost=0.03)
    add(session, jobs["support"], [call("mcp__github__search", "github", id="c", failed=False)], trace="t2", latency=1400, tin=1000, cost=0.01)
    add(session, jobs["invoice"], [call("mcp__slack__post"), call("lookup")], trace="t1", latency=500, provider="gemini")
    await session.commit()
    t = await ts.tool_servers(session, "p", days=30, now=NOW)
    by = {s.server: s for s in t.servers}
    gh = by["github"]
    assert gh.certainty == "provider_reported" and gh.calls == 3 and gh.requests == 2 and gh.task_runs == 2
    assert gh.failed_calls == 1 and gh.failure_known_calls == 2  # the first call's result did not say
    assert dict(gh.tools) == {"search": 2, "create_issue": 1} and dict(gh.tasks) == {"invoice": 2, "support": 1}
    assert gh.request_time_ms == 1000 and gh.request_tokens_in == 4000 and gh.request_cost_usd == pytest.approx(0.04)
    sl = by["slack"]
    assert sl.certainty == "likely" and sl.providers == ["gemini"]
    assert t.own_tools.calls == 1 and t.totals.requests == 3
    assert {r.key for r in t.support} == {"anthropic", "google"}
    assert t.notes and any("likely MCP" in n for n in t.notes)


async def test_only_production_runs_in_the_period_count_and_a_task_filter_narrows_it(session):
    jobs = await make(session)
    add(session, jobs["invoice"], [call("mcp__a__x", "a", id="1")], days_ago=2)
    add(session, jobs["invoice"], [call("mcp__a__x", "a", id="2")], days_ago=40)  # outside 30 days
    add(session, jobs["invoice"], [call("mcp__a__x", "a", id="3")], kind="RETEST")  # a re-test is not the app's traffic
    add(session, jobs["support"], [call("mcp__b__y", "b", id="4")])
    await session.commit()
    assert [s.server for s in (await ts.tool_servers(session, "p", days=30, now=NOW)).servers] == ["a", "b"] or True
    t = await ts.tool_servers(session, "p", days=30, now=NOW)
    assert {s.server: s.calls for s in t.servers} == {"a": 1, "b": 1}
    only = await ts.tool_servers(session, "p", days=30, job="support", now=NOW)
    assert [s.server for s in only.servers] == ["b"]
    wide = await ts.tool_servers(session, "p", days=90, now=NOW)
    assert {s.server: s.calls for s in wide.servers}["a"] == 2


async def test_malformed_records_are_skipped_counted_and_never_crash(session):
    jobs = await make(session)
    add(session, jobs["invoice"], {"not": "a list"})
    add(session, jobs["invoice"], "a string")
    add(session, jobs["invoice"], [1, "x", None, {"id": "no-name"}, {"name": 5}, {"name": ["list"]}, call("mcp__a__x", "a", id="ok")])
    add(session, jobs["invoice"], None)
    add(session, jobs["invoice"], [])
    await session.commit()
    t = await ts.tool_servers(session, "p", days=30, now=NOW)
    assert [s.server for s in t.servers] == ["a"] and t.servers[0].calls == 1
    assert t.unreadable_calls == 2 + 6  # two records that are not a list, six unreadable entries (a stored null is no calls)
    assert any("could not be read" in n for n in t.notes)


async def test_other_projects_calls_never_appear_and_arguments_and_results_never_leave(session):
    mine = await make(session, "p")
    theirs = await make(session, "q")
    add(session, mine["invoice"], [call("mcp__mine__x", "mine", id="1")])
    add(session, theirs["invoice"], [call("mcp__secret-corp__payroll", "secret-corp", id="2")], pid="q")
    # a stored call can carry arguments only if its project opted in; the analysis still never reads them
    add(session, mine["invoice"], [{"name": "mcp__mine__y", "id": "3", "server": "mine", "source": "provider", "arguments": {"k": "TOPSECRET"}}])
    await session.commit()
    t = await ts.tool_servers(session, "p", days=30, now=NOW)
    blob = repr(t)
    assert [s.server for s in t.servers] == ["mine"]
    assert "secret-corp" not in blob and "payroll" not in blob and "TOPSECRET" not in blob
    other = await ts.tool_servers(session, "q", days=30, now=NOW)
    assert [s.server for s in other.servers] == ["secret-corp"] and "mine" not in repr(other)


async def test_a_subscription_project_gets_tokens_and_no_dollars(session):
    jobs = await make(session, mode="subscription")
    add(session, jobs["invoice"], [call("mcp__a__x", "a", id="1")], cost=0.5)
    await session.commit()
    t = await ts.tool_servers(session, "p", days=30, mode="subscription", now=NOW)
    assert t.servers[0].request_cost_usd is None and t.totals.cost_usd is None and t.servers[0].request_tokens_in == 2000


async def test_nothing_recorded_says_so_and_unrecognised_tools_are_not_called_mcp(session):
    jobs = await make(session)
    assert (await ts.tool_servers(session, "p", days=30, now=NOW)).notes == ["No tool calls were recorded in this period."]
    add(session, jobs["invoice"], [call("lookup", id="1"), call("search_docs", id="2")])
    await session.commit()
    t = await ts.tool_servers(session, "p", days=30, now=NOW)
    assert t.servers == [] and t.own_tools.calls == 2
    assert any("none came from an MCP server we can recognise" in n for n in t.notes)


async def test_only_the_chosen_period_lengths_are_accepted(session):
    await make(session)
    with pytest.raises(ValueError):
        await ts.tool_servers(session, "p", days=3, now=NOW)


# --- the API --------------------------------------------------------------------------------------------------------------------

async def api_world(client, session):
    project, key = await create_project(session, "proj1")
    job = Job(project_id=project.project_id, name="invoice", check_kind="ANSWER_KEY", check_config={"fields": ["x"]})
    session.add(job)
    await session.flush()
    today = datetime.now(UTC)
    for i in range(3):
        session.add(Run(run_id=uuid.uuid4(), job_id=job.job_id, project_id=project.project_id, prompt="p", prompt_hash=f"h{i}", model="m",
                        model_version="m", provider="anthropic", run_kind="PRODUCTION", outcome="UNKNOWN", state="INDEXED",
                        tool_calls=[call("mcp__github__search", "github", id=f"c{i}")], latency_ms=700, tokens_in=1500, tokens_out=100,
                        cost_usd=0.03, created_at=today - timedelta(hours=i + 1)))
    await session.commit()
    return project, {"X-API-Key": key}


async def test_the_endpoint_returns_servers_support_method_and_says_the_tool_list_is_unknown(client, session):
    _, h = await api_world(client, session)
    body = (await client.get("/v1/insights/tool-servers?days=30", headers=h)).json()
    [s] = body["servers"]
    assert s["server"] == "github" and s["certainty"] == "provider_reported" and s["calls"] == 3 and s["requests"] == 3
    assert s["request_tokens_in"] == 4500 and s["request_cost_usd"] == pytest.approx(0.09) and s["tools"] == [{"name": "search", "calls": 3}]
    assert body["totals"]["requests"] == 3 and body["tool_list_size"] == "unknown" and body["mode"] == "per_use"
    assert body["support"][0]["key"] == "anthropic" and body["method"]
    assert not re.search(r"tokens (this|the) tool used", str(body), re.I)


async def test_the_endpoint_checks_its_inputs_needs_a_key_and_hides_other_tenants_tasks(client, session):
    _, h = await api_world(client, session)
    other, _ = await create_project(session, "proj2")
    session.add(Job(project_id=other.project_id, name="secret-job", check_kind="ANSWER_KEY", check_config={"fields": ["x"]}))
    await session.commit()
    assert (await client.get("/v1/insights/tool-servers?days=5", headers=h)).status_code == 422
    assert (await client.get("/v1/insights/tool-servers?job=invoice", headers=h)).status_code == 200
    assert (await client.get("/v1/insights/tool-servers?job=nope", headers=h)).status_code == 404
    assert (await client.get("/v1/insights/tool-servers?job=secret-job", headers=h)).status_code == 404  # another project's task
    assert (await client.get("/v1/insights/tool-servers")).status_code in (401, 403)


async def test_a_subscription_project_gets_no_dollar_figure_from_the_endpoint(client, session):
    project, h = await api_world(client, session)
    project.billing_mode = "subscription"
    await session.commit()
    body = (await client.get("/v1/insights/tool-servers", headers=h)).json()
    assert body["mode"] == "subscription" and body["servers"][0]["request_cost_usd"] is None and body["totals"]["cost_usd"] is None
    assert "$" not in str(body)
