"""Plain-language labels for tool use, agents, tool servers, several agents and possible loops."""

from agent_memory.insights.agent_kinds import (
    Step, detect_loop, is_multi_agent, make_step, mcp_servers, tool_source, top_tools, uses_tools, works_like_agent,
)


def step(agent=None, trace="t", tools=(), prompt="p", args=None, out=None, cost=0.01, tt=0):
    return Step(agent=agent, trace_id=trace, model="m", prompt_hash=prompt, tool_names=list(tools),
                arguments_hash=args, output_hash=out, tools_tokens=tt, tool_call_count=len(tools), cost_usd=cost)


def test_uses_tools_from_offered_or_called():
    assert not uses_tools([step()])
    assert uses_tools([step(tt=500)])
    assert uses_tools([step(tools=["search"])])


def test_agent_needs_several_calls_with_repeated_tool_use():
    calls = [step(tools=["a"]), step(tools=["b"]), step()]
    assert works_like_agent(calls) == "yes"
    assert works_like_agent(calls[:2]) is None
    assert works_like_agent([step(tools=["a"]), step()]) is None


def test_without_trace_id_it_is_only_probably():
    calls = [step(trace=None, tools=["a"]), step(trace=None, tools=["a"]), step(trace=None)]
    assert works_like_agent(calls) == "probably"


def test_mcp_only_when_names_match():
    assert tool_source(["mcp__github__create_issue", "search"], True) == "mcp"
    assert mcp_servers(["mcp__github__a", "mcp__github__b", "mcp__slack__c", "plain"]) == ["github", "slack"]
    assert tool_source(["search", "fetch"], True) == "tool_list"
    assert tool_source(["mcp_like", "mcp__broken"], False) == "tool_list"
    assert tool_source([], False) is None


def test_multi_agent_needs_distinct_labels_in_one_trace():
    assert is_multi_agent([step("planner", "t1"), step("coder", "t1")])
    assert not is_multi_agent([step("planner", "t1"), step("coder", "t2")])
    assert not is_multi_agent([step("planner", "t1"), step(None, "t1")])
    assert not is_multi_agent([step("planner", "t1"), step("planner", "t1")])


def test_top_tools_counts():
    assert top_tools(["a", "b", "a"]) == [("a", 2), ("b", 1)]


def test_loop_with_arguments():
    steps = [step(tools=["search"], args="x", out="same") for _ in range(5)]
    loop = detect_loop(steps)
    assert loop and loop.repeats == 5 and loop.uses_arguments and "search" in loop.step
    assert loop.cost_usd == 0.05


def test_loop_without_arguments_uses_tool_and_identical_prompt():
    steps = [step(tools=["search"], prompt="same") for _ in range(6)] + [step(tools=["search"], prompt="other")]
    loop = detect_loop(steps)
    assert loop and loop.repeats == 6 and not loop.uses_arguments


def test_four_repeats_or_spread_out_repeats_are_not_flagged():
    assert detect_loop([step(tools=["s"], args="x") for _ in range(4)]) is None
    spread = [step(tools=["s"], args="x") if i % 2 == 0 else step(tools=["t"], args=str(i)) for i in range(14)]
    assert detect_loop(spread) is None  # 4 of any 7


def test_changing_results_are_not_a_loop():
    steps = [step(tools=["search"], args="x", out=f"r{i}") for i in range(6)]
    assert detect_loop(steps) is None


def test_make_step_hashes_arguments_only_when_stored():
    a = make_step(agent=None, trace_id="t", model="m", prompt_hash="p", tool_calls=[{"name": "s"}], tools_tokens=None,
                  tool_call_count=1, output=None, cost_usd=None, tokens=1, created_at=None)
    b = make_step(agent=None, trace_id="t", model="m", prompt_hash="p", tool_calls=[{"name": "s", "arguments": {"q": 1}}],
                  tools_tokens=None, tool_call_count=1, output="o", cost_usd=0.5, tokens=1, created_at=None)
    assert a.arguments_hash is None and b.arguments_hash and b.output_hash and b.cost_usd == 0.5
