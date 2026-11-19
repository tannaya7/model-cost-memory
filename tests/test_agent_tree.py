"""Multi-agent trees, possible repeated calls and cohorts: parents and children without double counting, unlinked and unstructured
calls, duplicate records, polling and retries that are legitimate, chosen thresholds with their evidence, and equivalent cohorts only.
Analysis only: nothing is stopped, cancelled or reconfigured."""

import re
import uuid
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest

from agent_memory.insights import agent_tree as at
from agent_memory.insights.agent_kinds import detect_loop, make_step
from agent_memory.models import Job, Project, Run
from agent_memory.projects import create_project

T0 = datetime(2026, 11, 18, 9, 0, tzinfo=UTC)


def call(rid, *, span=None, parent=None, agent="a", tokens=100, cost=0.01, sec=0.0, tools=None, args=None, prompt="p", out=None, failed=None, model="m", job="invoice"):
    return at.Call(run_id=rid, job=job, agent=agent, model=model, span_id=span, parent_span_id=parent, created_at=T0 + timedelta(seconds=sec),
                   latency_ms=100, tokens=tokens, cost=cost, tool_names=tools or [], arguments_hash=args, prompt_hash=prompt, output_hash=out, failed=failed)


def by_id(tree):
    return {n.call.run_id: n for n in tree.roots + tree.unlinked + tree.unstructured} | {c.call.run_id: c for r in tree.roots + tree.unlinked for c in _all(r)}


def _all(n):
    stack = [n]
    while stack:
        cur = stack.pop()
        yield cur
        stack.extend(cur.children)


# --- parents and children, and totals that count each call once --------------------------------------------------------------

def tree_of_five():
    return [call("orch", span="s0", tokens=1000, cost=0.10, sec=0), call("plan", span="s1", parent="s0", tokens=400, cost=0.04, sec=1),
            call("code", span="s2", parent="s0", tokens=600, cost=0.06, sec=2), call("test", span="s3", parent="s1", tokens=200, cost=0.02, sec=3),
            call("rev", span="s4", parent="s2", tokens=300, cost=0.03, sec=4)]


def test_children_sit_under_their_parents_and_subtree_totals_add_their_own_plus_children_once():
    t = at.build_tree(tree_of_five())
    [root] = t.roots
    assert root.call.run_id == "orch" and sorted(c.call.run_id for c in root.children) == ["code", "plan"]
    plan = by_id(t)["plan"]
    assert [c.call.run_id for c in plan.children] == ["test"]
    assert (plan.own.tokens, plan.subtree.tokens) == (400, 600) and plan.subtree.cost_usd == pytest.approx(0.06)
    assert root.subtree.tokens == 2500 and root.subtree.calls == 5 and root.subtree.cost_usd == pytest.approx(0.25)
    assert t.totals.tokens == 2500 and t.totals.calls == 5  # the task total is every call once, not the sum of subtrees


def test_the_task_total_always_equals_roots_plus_unlinked_plus_unstructured_each_call_once():
    calls = tree_of_five() + [call("lost", span="x1", parent="nobody", tokens=70, cost=0.007, sec=9), call("flat", tokens=30, cost=0.003, sec=10),
                              call("lost-child", span="x2", parent="x1", tokens=5, cost=0.0005, sec=11)]
    t = at.build_tree(calls)
    parts = sum(r.subtree.tokens for r in t.roots) + sum(u.subtree.tokens for u in t.unlinked) + sum(f.own.tokens for f in t.unstructured)
    assert parts == t.totals.tokens == sum(c.tokens for c in calls)
    assert sum(r.subtree.calls for r in t.roots) + sum(u.subtree.calls for u in t.unlinked) + len(t.unstructured) == len(calls)


def test_a_very_deep_chain_does_not_blow_the_stack_and_still_counts_each_call_once():
    calls = [call(f"n{i}", span=f"s{i}", parent=f"s{i - 1}" if i else None, tokens=1, cost=0.001, sec=i) for i in range(3000)]
    t = at.build_tree(calls)
    assert len(t.roots) == 1 and t.roots[0].subtree.calls == 3000 and t.totals.tokens == 3000


# --- unlinked, unstructured, duplicate and broken ids ---------------------------------------------------------------------------

def test_a_child_whose_parent_was_never_recorded_is_unlinked_with_the_missing_id_not_attached_to_a_guess():
    t = at.build_tree(tree_of_five() + [call("lost", span="x1", parent="ghost", sec=9)])
    [u] = t.unlinked
    assert (u.call.run_id, u.link, u.reason, u.missing_parent) == ("lost", "unlinked", "parent not recorded", "ghost")
    assert all(u not in _all(r) for r in t.roots)
    assert any("names a parent that was not recorded" in n for n in t.notes)


def test_the_children_of_an_unlinked_call_stay_under_it():
    t = at.build_tree([call("lost", span="x1", parent="ghost"), call("kid", span="x2", parent="x1", sec=1)])
    [u] = t.unlinked
    assert [c.call.run_id for c in u.children] == ["kid"] and u.subtree.calls == 2


def test_calls_that_sent_no_ids_are_unstructured_and_said_so_only_when_others_have_structure():
    mixed = at.build_tree(tree_of_five() + [call("flat", sec=9)])
    assert [n.call.run_id for n in mixed.unstructured] == ["flat"] and any("sent no span ids" in n for n in mixed.notes)
    plain = at.build_tree([call("a"), call("b", sec=1)])
    assert len(plain.unstructured) == 2 and not plain.roots and plain.notes == []  # an app that sends none is not nagged


def test_a_call_that_is_its_own_parent_and_a_cycle_are_unlinked_not_looped_over():
    own = at.build_tree([call("a", span="s1", parent="s1")])
    assert own.unlinked[0].reason == "its parent id is its own id" and own.totals.calls == 1
    cyc = at.build_tree([call("a", span="s1", parent="s2"), call("b", span="s2", parent="s1", sec=1), call("c", span="s3", sec=2)])
    assert sorted(n.call.run_id for n in cyc.unlinked) == ["a", "b"] and all(n.reason == "its parent ids form a cycle" for n in cyc.unlinked)
    assert [r.call.run_id for r in cyc.roots] == ["c"] and cyc.totals.calls == 3


def test_two_calls_sharing_a_span_id_are_both_counted_flagged_and_children_go_to_the_first():
    t = at.build_tree([call("first", span="s1", sec=0), call("second", span="s1", sec=1), call("kid", span="s2", parent="s1", sec=2)])
    assert t.totals.calls == 3 and t.duplicate_spans == 1
    assert by_id(t)["first"].duplicate_span and by_id(t)["second"].duplicate_span
    assert [c.call.run_id for c in by_id(t)["first"].children] == ["kid"] and by_id(t)["second"].children == []
    assert any("used by more than one call" in n for n in t.notes)


def test_a_record_of_the_same_call_sent_twice_counts_once():
    c = call("same", span="s1", tokens=500, cost=0.05)
    t = at.build_tree([c, call("same", span="s1", tokens=500, cost=0.05), call("other", sec=1)])
    assert t.totals.calls == 2 and t.totals.tokens == 600
    assert any("1 duplicate record of the same call was counted once" in n for n in t.notes)


def test_unpriced_calls_are_counted_and_a_subscription_has_no_dollars():
    calls = [call("a", span="s1", cost=0.5), call("b", span="s2", parent="s1", cost=None, sec=1)]
    t = at.build_tree(calls)
    assert t.totals.cost_usd == pytest.approx(0.5) and t.totals.unpriced_calls == 1 and t.roots[0].subtree.unpriced_calls == 1
    s = at.build_tree(calls, money=False)
    assert s.totals.cost_usd is None and s.totals.unpriced_calls == 0 and s.totals.tokens == 200


# --- possible repeated calls: the chosen threshold, evidence, and legitimate repeats --------------------------------------------------

def same(n, *, sec_each=1.0, args="h1", out=None, failed=None, tools=("search",), start=0.0, prefix="r"):
    return [call(f"{prefix}{i}", sec=start + i * sec_each, tools=list(tools), args=args, out=out, failed=failed(i) if callable(failed) else failed) for i in range(n)]


@pytest.mark.parametrize(("n", "repeats", "flagged"), [(5, 5, True), (4, 5, False), (6, 6, True), (5, 6, False), (3, 3, True), (9, 10, False), (10, 10, True)])
def test_the_chosen_threshold_decides_exactly_at_the_boundary(n, repeats, flagged):
    window = 15 if repeats == 10 else 10
    assert (at.find_repeats(same(n), repeats=repeats, window=window) is not None) is flagged


def test_the_window_must_be_at_least_the_repeats():
    with pytest.raises(ValueError):
        at.find_repeats(same(5), repeats=5, window=3)


def test_repeats_spread_beyond_the_window_are_not_flagged():
    spread = []
    for i in range(10):
        spread += [call(f"r{i}", sec=i * 2, tools=["search"], args="h1"), call(f"o{i}", sec=i * 2 + 1, tools=["other"], args=f"x{i}")]
    assert at.find_repeats(spread, repeats=5, window=7) is None  # 1 in every 2 calls: at most 4 in any 7
    assert at.find_repeats(spread, repeats=4, window=7) is not None


def test_different_arguments_are_not_the_same_call():
    calls = [call(f"r{i}", sec=i, tools=["search"], args=f"h{i}") for i in range(8)]
    assert at.find_repeats(calls, repeats=3, window=7) is None


def test_the_evidence_lists_every_repeated_call_with_its_gap_and_whether_it_was_inside_the_window():
    calls = [call("a", sec=0, tools=["other"], args="o")] + same(6, sec_each=2.0) + [call("z", sec=100, tools=["other"], args="o")]
    r = at.find_repeats(calls, repeats=5, window=7)
    assert r.repeats == 6 and r.in_window >= 5 and r.basis == "arguments" and r.step == "the search tool"
    assert [c["run_id"] for c in r.calls] == [f"r{i}" for i in range(6)]
    assert r.calls[0]["gap_seconds"] is None and all(c["gap_seconds"] == 2.0 for c in r.calls[1:])
    assert (r.repeats_threshold, r.window) == (5, 7) and r.median_gap_seconds == 2.0


def test_polling_whose_results_change_each_time_is_progress_and_not_flagged():
    statuses = [call(f"p{i}", sec=i * 30, tools=["get_status"], args="job-1", out=f"status-{i}") for i in range(8)]
    assert at.find_repeats(statuses, repeats=5, window=7) is None


def test_polling_that_keeps_returning_the_same_thing_is_a_possible_repeated_call_with_a_polling_hint_and_no_verdict():
    waiting = [call(f"p{i}", sec=i * 30, tools=["get_status"], args="job-1", out="pending") for i in range(6)]
    r = at.find_repeats(waiting, repeats=5, window=7)
    text = " ".join(r.hints)
    assert r is not None and r.median_gap_seconds == 30 and r.distinct_results == 1
    assert "This can be valid: polling and retries repeat on purpose" in text and "about 30 seconds apart, which is how polling often looks" in text
    assert "Stored results were mostly the same each time" in text


def test_a_retry_pattern_shows_the_failures_that_came_before():
    calls = same(5, failed=lambda i: i < 4)
    r = at.find_repeats(calls, repeats=5, window=7)
    assert r.failed_calls == 4 and any("4 of these calls are recorded as failed, which is how retries often look" in h for h in r.hints)


def test_without_stored_arguments_the_comparison_is_the_same_tool_and_prompt_and_says_so():
    calls = [call(f"r{i}", sec=i, tools=["search"], args=None, prompt="same question") for i in range(5)]
    r = at.find_repeats(calls, repeats=5, window=7)
    assert r.basis == "prompt" and any("Arguments were not stored" in h and "same tool and the same prompt" in h for h in r.hints)


def test_nothing_in_the_flag_calls_it_waste_a_loop_or_certain():
    r = at.find_repeats(same(6, sec_each=30.0, out="pending"), repeats=5, window=7)
    blob = " ".join([r.step, *r.hints, *at.METHOD])
    assert not re.search(r"\b(waste\w*|wasted|loop\w*|stuck|runaway|definitely|certainly|bug|broken|stop it|kill)\b", blob, re.I)


@pytest.mark.parametrize("scenario", ["identical_prompts", "tool_with_args", "changing_results", "short", "mixed"])
def test_at_the_defaults_this_agrees_with_the_older_loop_check(scenario):
    def steps_and_calls():
        rows = {
            "identical_prompts": [call(f"r{i}", sec=i, tools=[], args=None, prompt="same") for i in range(8)],
            "tool_with_args": same(6),
            "changing_results": [call(f"r{i}", sec=i, tools=["t"], args="a", out=f"o{i}") for i in range(7)],
            "short": same(3),
            "mixed": same(3) + [call(f"x{i}", sec=10 + i, tools=["u"], args=f"u{i}") for i in range(4)] + same(3, start=20, prefix="q"),
        }[scenario]
        return rows

    calls = steps_and_calls()
    steps = [make_step(agent=c.agent, trace_id="t", model=c.model, prompt_hash=c.prompt_hash,
                       tool_calls=[{"name": n, "arguments": ({"k": c.arguments_hash} if c.arguments_hash else None)} for n in c.tool_names], tools_tokens=0,
                       tool_call_count=len(c.tool_names), output=c.output_hash, cost_usd=c.cost, tokens=c.tokens, created_at=c.created_at) for c in calls]
    old = detect_loop(steps)
    new = at.find_repeats(calls, repeats=at.DEFAULT_REPEATS, window=at.DEFAULT_WINDOW)
    assert (old is None) == (new is None)
    if old:
        assert new.repeats == old.repeats


# --- cohorts: equivalent tasks only, measured, no multiplier -------------------------------------------------------------------------

def trace(job="invoice", models=("m",), agents=1, tokens=1000, cost=0.1, jobs=1):
    return {"job": job, "jobs": jobs, "models": list(models), "agents": agents, "tokens": tokens, "cost": cost}


def test_a_cohort_needs_enough_tasks_on_both_sides_and_compares_measured_medians_only():
    rows = [trace(tokens=1000 + i, cost=0.10 + i / 1000) for i in range(12)] + [trace(agents=3, tokens=4000 + i, cost=0.40 + i / 1000) for i in range(11)]
    [c], notes = at.cohorts(rows, money=True)
    assert (c.job, c.models) == ("invoice", ["m"]) and c.single_agent["tokens"]["tasks"] == 12 and c.multi_agent["tokens"]["tasks"] == 11
    assert c.single_agent["tokens"]["median"] == 1005.5 and c.multi_agent["tokens"]["median"] == 4005
    assert set(c.multi_agent["tokens"]) == {"tasks", "median", "p25", "p75"}  # no ratio, no multiplier
    assert notes == []


def test_too_few_tasks_on_either_side_are_not_compared_and_say_so():
    rows = [trace() for _ in range(12)] + [trace(agents=2) for _ in range(9)]
    assert at.cohorts(rows, money=True)[0] == []
    assert any("fewer than 10" in n for n in at.cohorts(rows, money=True)[1])


def test_tasks_on_different_models_or_different_ai_tasks_are_never_compared_with_each_other():
    rows = [trace(models=("big",)) for _ in range(12)] + [trace(models=("big", "mini"), agents=2) for _ in range(12)]
    assert at.cohorts(rows, money=True)[0] == []  # not the same models
    other = [trace(job="support") for _ in range(12)] + [trace(job="invoice", agents=2) for _ in range(12)]
    assert at.cohorts(other, money=True)[0] == []  # not the same AI task
    mixed = [trace(jobs=2) for _ in range(30)]
    assert at.cohorts(mixed, money=True) == ([], ["30 tasks span more than one AI task and are not comparable, so they are left out."])


def test_a_subscription_cohort_has_tokens_and_no_cost():
    rows = [trace() for _ in range(10)] + [trace(agents=2) for _ in range(10)]
    [c], _ = at.cohorts(rows, money=False)
    assert c.single_agent["cost_usd"] is None and c.multi_agent["cost_usd"] is None and c.single_agent["tokens"]["median"] == 1000


def test_no_universal_multiplier_appears_in_the_method():
    blob = " ".join(at.METHOD)
    assert "state no multiplier" in blob and not re.search(r"\b\d+(\.\d+)?\s?(x|×|times)\b", blob)


def test_the_analysis_cannot_stop_cancel_or_change_anything():
    src = Path(at.__file__).read_text(encoding="utf8")
    assert not re.search(r"^\s*(import|from)\s+(httpx|requests|aiohttp|urllib|socket|subprocess)\b", src, re.M)
    assert not re.search(r"\b(INSERT|UPDATE|DELETE)\s", src)


# --- from the database and the API --------------------------------------------------------------------------------------------------

async def seed(session, pid="p", trace_id="t1", mode="per_use"):
    p = Project(project_id=pid, api_key_hash="k" + pid, billing_mode=mode)
    session.add(p)
    await session.flush()
    job = Job(project_id=pid, name="invoice", check_kind="ANSWER_KEY", check_config={"fields": ["x"]})
    session.add(job)
    await session.flush()
    return job


def run(session, job, trace_id, span=None, parent=None, agent="a", sec=0, tokens=100, cost=0.01, pid="p", tool="search", args=None, out=None, kind="PRODUCTION"):
    rid = uuid.uuid4()
    session.add(Run(run_id=rid, job_id=job.job_id, project_id=pid, prompt="p", prompt_hash=f"h{rid}", model="m", model_version="m", agent=agent,
                    trace_id=trace_id, span_id=span, parent_span_id=parent, tokens_in=tokens, tokens_out=0, cost_usd=cost, run_kind=kind,
                    outcome="UNKNOWN", state="INDEXED", output=out, created_at=datetime.now(UTC) - timedelta(hours=1) + timedelta(seconds=sec),
                    tool_calls=[{"name": tool, "id": None, **({"arguments": args} if args else {})}] if tool else None))
    return rid


async def test_a_task_comes_back_as_a_flat_tree_with_depth_parents_totals_and_structure_counts(client, session):
    project, key = await create_project(session, "proj1")
    job = Job(project_id=project.project_id, name="invoice", check_kind="ANSWER_KEY", check_config={"fields": ["x"]})
    session.add(job)
    await session.flush()
    pid = project.project_id
    orch = run(session, job, "t1", "s0", None, "orchestrator", 0, 1000, 0.10, pid=pid)
    plan = run(session, job, "t1", "s1", "s0", "planner", 1, 400, 0.04, pid=pid)
    kid = run(session, job, "t1", "s2", "s1", "coder", 2, 200, 0.02, pid=pid)
    lost = run(session, job, "t1", "s9", "ghost", "tester", 3, 70, 0.007, pid=pid)
    flat = run(session, job, "t1", None, None, None, 4, 30, 0.003, pid=pid)
    await session.commit()
    body = (await client.get("/v1/insights/agent-task?trace_id=t1", headers={"X-API-Key": key})).json()
    assert body["totals"]["calls"] == 5 and body["totals"]["tokens"] == 1700 and body["totals"]["cost_usd"] == pytest.approx(0.17)
    assert body["structure"] == {"roots": 1, "linked_children": 2, "unlinked": 1, "no_structure": 1}
    ns = {n["run_id"]: n for n in body["nodes"]}
    assert [(n["section"], n["depth"]) for n in body["nodes"]] == [("tree", 0), ("tree", 1), ("tree", 2), ("unlinked", 0), ("no_structure", 0)]
    assert ns[str(plan)]["parent_run_id"] == str(orch) and ns[str(kid)]["parent_run_id"] == str(plan)
    assert ns[str(orch)]["subtree"]["tokens"] == 1600 and ns[str(orch)]["own"]["tokens"] == 1000 and ns[str(orch)]["child_count"] == 1
    assert ns[str(lost)]["link"] == "unlinked" and ns[str(lost)]["missing_parent"] == "ghost" and ns[str(flat)]["link"] == "no_structure"
    assert sum(n["own"]["tokens"] for n in body["nodes"]) == body["totals"]["tokens"]  # every call once
    assert any("names a parent that was not recorded" in n for n in body["notes"])


async def test_the_list_gives_summaries_the_chosen_threshold_and_possible_repeated_calls_not_verdicts(client, session):
    project, key = await create_project(session, "proj1")
    job = Job(project_id=project.project_id, name="invoice", check_kind="ANSWER_KEY", check_config={"fields": ["x"]})
    session.add(job)
    await session.flush()
    pid = project.project_id
    for i in range(6):
        run(session, job, "poll", None, None, "worker", i * 30, 10, 0.001, pid=pid, tool="get_status", args={"job": 1}, out="pending")
    for i in range(3):
        run(session, job, "calm", None, None, "worker", i, 10, 0.001, pid=pid, tool=f"t{i}")
    await session.commit()
    h = {"X-API-Key": key}
    body = (await client.get("/v1/insights/agent-tasks?days=30&repeats=5&window=7", headers=h)).json()
    by = {t["trace_id"]: t for t in body["tasks"]}
    assert by["poll"]["repeated_step"] == "the get_status tool" and by["poll"]["repeated_times"] == 6 and by["calm"]["repeated_step"] is None
    assert (body["repeats"], body["window"], body["repeat_choices"], body["min_cohort"]) == (5, 7, [3, 4, 5, 6, 8, 10], 10)
    lenient = (await client.get("/v1/insights/agent-tasks?repeats=8&window=10", headers=h)).json()
    assert next(t for t in lenient["tasks"] if t["trace_id"] == "poll")["repeated_step"] is None  # the viewer's threshold, not ours
    detail = (await client.get("/v1/insights/agent-task?trace_id=poll&repeats=5&window=7", headers=h)).json()["repeated"]
    assert detail["label"] == "possible_repeated_call" and len(detail["calls"]) == 6 and detail["basis"] == "arguments"
    assert any("This can be valid" in x for x in detail["hints"]) and not re.search(r"waste|loop", str(detail), re.I)


async def test_other_projects_tasks_are_invisible_and_inputs_are_checked(client, session):
    mine, key = await create_project(session, "proj1")
    theirs, _ = await create_project(session, "proj2")
    j1 = Job(project_id=mine.project_id, name="invoice", check_kind="ANSWER_KEY", check_config={"fields": ["x"]})
    j2 = Job(project_id=theirs.project_id, name="secret-job", check_kind="ANSWER_KEY", check_config={"fields": ["x"]})
    session.add_all([j1, j2])
    await session.flush()
    run(session, j1, "mine", "s0", None, pid=mine.project_id)
    run(session, j2, "theirs", "s0", None, agent="payroll-agent", pid=theirs.project_id)
    await session.commit()
    h = {"X-API-Key": key}
    assert (await client.get("/v1/insights/agent-task?trace_id=mine", headers=h)).status_code == 200
    assert (await client.get("/v1/insights/agent-task?trace_id=theirs", headers=h)).status_code == 404
    listing = (await client.get("/v1/insights/agent-tasks", headers=h)).text
    assert "theirs" not in listing and "payroll-agent" not in listing and "secret-job" not in listing
    assert (await client.get("/v1/insights/agent-tasks?job=secret-job", headers=h)).status_code == 404
    assert (await client.get("/v1/insights/agent-tasks?repeats=7", headers=h)).status_code == 422
    assert (await client.get("/v1/insights/agent-tasks?repeats=10&window=7", headers=h)).status_code == 422
    assert (await client.get("/v1/insights/agent-tasks?days=3", headers=h)).status_code == 422
    assert (await client.get("/v1/insights/agent-task?trace_id=mine&repeats=5&window=5", headers=h)).status_code == 200
    assert (await client.get("/v1/insights/agent-tasks")).status_code in (401, 403)


async def test_re_tests_and_other_run_kinds_are_not_part_of_a_task(client, session):
    project, key = await create_project(session, "proj1")
    job = Job(project_id=project.project_id, name="invoice", check_kind="ANSWER_KEY", check_config={"fields": ["x"]})
    session.add(job)
    await session.flush()
    run(session, job, "t", "s0", None, pid=project.project_id)
    run(session, job, "t", "s1", "s0", pid=project.project_id, kind="RETEST")
    await session.commit()
    body = (await client.get("/v1/insights/agent-task?trace_id=t", headers={"X-API-Key": key})).json()
    assert body["totals"]["calls"] == 1


async def test_a_subscription_project_gets_tokens_and_no_dollars(client, session):
    project, key = await create_project(session, "proj1")
    project.billing_mode = "subscription"
    job = Job(project_id=project.project_id, name="invoice", check_kind="ANSWER_KEY", check_config={"fields": ["x"]})
    session.add(job)
    await session.flush()
    run(session, job, "t", "s0", None, pid=project.project_id, cost=0.5)
    await session.commit()
    h = {"X-API-Key": key}
    a = (await client.get("/v1/insights/agent-task?trace_id=t", headers=h)).json()
    b = (await client.get("/v1/insights/agent-tasks", headers=h)).json()
    assert a["totals"]["cost_usd"] is None and b["tasks"][0]["totals"]["cost_usd"] is None and "$" not in str(a) + str(b)


# --- span ids reach the database ----------------------------------------------------------------------------------------------------

async def test_span_ids_sent_with_a_call_are_stored_and_returned_and_a_retried_send_is_one_call(client, session):
    from tests.test_ingest import JOB, run_body

    _, key = await create_project(session, "proj1")
    h = {"X-API-Key": key}
    assert (await client.post("/v1/jobs", json=JOB, headers=h)).status_code == 201
    body = run_body(trace_id="t9", span_id="s1", parent_span_id="s0", agent="planner")
    assert (await client.post("/v1/runs", json=body, headers=h)).status_code in (200, 201, 202)
    again = await client.post("/v1/runs", json=body, headers=h)  # a retried send of the same call
    assert again.status_code in (200, 201, 202) and again.json().get("status") in ("duplicate", "accepted")
    stored = (await client.get("/v1/runs", headers=h)).json()["items"]
    assert len(stored) == 1 and (stored[0]["span_id"], stored[0]["parent_span_id"]) == ("s1", "s0")
    too_long = await client.post("/v1/runs", json=run_body(span_id="x" * 201), headers=h)
    assert too_long.status_code == 422


def test_the_sdk_sends_span_ids_and_trims_them():
    from tests.test_recorder import Server, anthropic_like, sender_for
    from agent_memory.recorder import RunRecorder

    server = Server()
    sender = sender_for(server)
    with RunRecorder(job="j", sender=sender) as rec:
        rec.capture(anthropic_like(), prompt="p", trace_id="t", span_id="s" * 300, parent_span_id="p1")
    sender.flush(2)
    body = server.bodies()[0]
    assert len(body["span_id"]) == 200 and body["parent_span_id"] == "p1"
    sender.close()
    quiet = Server()
    s2 = sender_for(quiet)
    with RunRecorder(job="j", sender=s2) as rec:
        rec.capture(anthropic_like(), prompt="p")
    s2.flush(2)
    assert "span_id" not in quiet.bodies()[0] and "parent_span_id" not in quiet.bodies()[0]  # nothing is invented
    s2.close()
