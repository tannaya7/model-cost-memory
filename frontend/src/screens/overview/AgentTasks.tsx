/** "Agent tasks": a task (every call sharing one task id) as a tree of who called whom, with totals that count each call once,
 * possible repeated calls with the calls themselves as evidence, and cohorts of equivalent tasks. Analysis only: nothing is
 * stopped, cancelled or reconfigured, and no AI wrote any of it.
 *
 * What it will not do: call a repeat waste or a loop (polling and retries repeat on purpose), state a multiplier for what several
 * agents cost, or place a call under a parent that was never recorded. Those calls are shown apart, with the missing parent id. */
import { useContext, useId, useMemo, useState } from "react";
import { RunDetailPanel } from "../../features/runs/components/RunDetailPanel";
import {
  isAgentTask, isAgentTasks, TASK_DAYS, useAgentTask, useAgentTasks, type AgentTask, type AgentTaskSummary, type Cohort, type RepeatedCall, type TaskNode,
} from "../../features/insights/api/agentTasksApi";
import { count, usd } from "../../ui/format";
import { Button, cx, ErrorState, Pill, Segmented, Skeleton } from "../../ui/primitives";
import { agentName } from "./agentView";
import { CardLevel, Shell, type ShellProps } from "./widgets";

/** One level below the card's own title, so headings never skip a level. */
const useSub = () => (useContext(CardLevel) === 3 ? "h4" : "h3") as "h3" | "h4";

const REPEATS = [3, 4, 5, 6, 8, 10];
const WINDOWS = [5, 7, 10, 15];
const when = (iso: string) => new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit", timeZone: "UTC" });

const money = (cost: number | null | undefined, unpriced: number) =>
  cost === null || cost === undefined ? (unpriced > 0 ? "cost not known" : null) : `${usd(cost)}${unpriced > 0 ? ` (${count(unpriced)} calls have no known price)` : ""}`;

/** "1 call starts the task, 3 sit under it, 1 names a parent that was not recorded, 2 sent no structure". */
export function structureText(s: AgentTaskSummary["structure"]): string {
  const parts: string[] = [];
  if (s.roots > 0) parts.push(`${count(s.roots)} starting ${s.roots === 1 ? "call" : "calls"} with ${count(s.linked_children)} ${s.linked_children === 1 ? "call" : "calls"} under ${s.roots === 1 ? "it" : "them"}`);
  if (s.unlinked > 0) parts.push(`${count(s.unlinked)} ${s.unlinked === 1 ? "call names" : "calls name"} a parent that was not recorded`);
  if (s.no_structure > 0) parts.push(`${count(s.no_structure)} ${s.no_structure === 1 ? "call sent" : "calls sent"} no structure`);
  return parts.length ? parts.join(" · ") : "No calls.";
}

/** Which nodes are visible when some branches are folded: a node is hidden when an ancestor in the same list is folded. */
export function visibleNodes(nodes: TaskNode[], folded: Set<string>): TaskNode[] {
  const out: TaskNode[] = [];
  let hideBelow: number | null = null;
  for (const n of nodes) {
    if (hideBelow !== null && n.depth > hideBelow) continue;
    hideBelow = null;
    out.push(n);
    if (folded.has(n.run_id)) hideBelow = n.depth;
  }
  return out;
}

function NodeRow({ n, folded, onToggle, onInspect, showMoney }: { n: TaskNode; folded: boolean; onToggle: () => void; onInspect: () => void; showMoney: boolean }) {
  const label = n.agent ? agentName(n.agent) : "Unnamed agent";
  return (
    <li className="py-1.5" style={{ paddingLeft: `${Math.min(n.depth, 8) * 1.25}rem` }} data-testid="tree-node" data-depth={n.depth}>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-sm">
        {n.child_count > 0 ? (
          <button type="button" aria-expanded={!folded} aria-label={`${folded ? "Show" : "Hide"} the ${n.child_count} ${n.child_count === 1 ? "call" : "calls"} under ${label}`} onClick={onToggle} className="grid h-5 w-5 place-items-center rounded border border-rule text-xs text-dim hover:bg-surface-2">
            <span aria-hidden>{folded ? "+" : "−"}</span>
          </button>
        ) : (
          <span className="h-5 w-5" aria-hidden />
        )}
        <span className="font-semibold text-ink">{label}</span>
        <span className="font-mono text-[11px] text-muted">{n.model}</span>
        {n.tools.length > 0 && <span className="text-xs text-muted">uses {n.tools.join(", ")}</span>}
        <span className="tabular text-xs text-dim">
          {count(n.own.tokens)} tokens{showMoney && n.own.cost_usd !== null ? `, ${usd(n.own.cost_usd)}` : ""}
          {n.child_count > 0 ? `; ${count(n.subtree.tokens)} with the calls under it` : ""}
        </span>
        {n.duplicate_span && <Pill tone="info" icon={false}>shares a span id</Pill>}
        <Button size="sm" onClick={onInspect} aria-label={`Inspect this call by ${label}, at ${when(n.started_at)}`}>Inspect</Button>
      </div>
      {n.link === "unlinked" && <p className="ml-7 text-xs text-warn">Parent not recorded{n.missing_parent ? `: ${n.missing_parent}` : ""}. {n.reason !== "parent not recorded" && n.reason ? `(${n.reason}.)` : ""}</p>}
    </li>
  );
}

function TreeSection({ title, nodes, onInspect, showMoney }: { title: string; nodes: TaskNode[]; onInspect: (id: string) => void; showMoney: boolean }) {
  const [folded, setFolded] = useState<Set<string>>(new Set());
  const shown = useMemo(() => visibleNodes(nodes, folded), [nodes, folded]);
  const parents = nodes.filter((n) => n.child_count > 0).map((n) => n.run_id);
  const Sub = useSub();
  const hid = useId();
  if (nodes.length === 0) return null;
  return (
    <div data-testid="tree-section">
      <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
        <Sub id={hid} className="text-xs font-semibold uppercase tracking-wider text-muted">{title}</Sub>
        {parents.length > 0 && (
          <span className="flex gap-1.5">
            <Button size="sm" onClick={() => setFolded(new Set(parents))}>Fold all</Button>
            <Button size="sm" onClick={() => setFolded(new Set())}>Unfold all</Button>
          </span>
        )}
      </div>
      <ul className="divide-y divide-rule/60 rounded-[10px] border border-rule px-2">
        {shown.map((n) => (
          <NodeRow key={n.run_id} n={n} folded={folded.has(n.run_id)} showMoney={showMoney} onInspect={() => onInspect(n.run_id)}
            onToggle={() => setFolded((f) => { const next = new Set(f); if (next.has(n.run_id)) next.delete(n.run_id); else next.add(n.run_id); return next; })} />
        ))}
      </ul>
    </div>
  );
}

function RepeatedPanel({ r, onInspect, showMoney }: { r: RepeatedCall; onInspect: (id: string) => void; showMoney: boolean }) {
  const Sub = useSub();
  const hid = useId();
  return (
    <div className="rounded-[10px] border border-warn/40 bg-warn/10 p-3 text-sm" data-testid="repeated">
      <Sub id={hid} className="font-semibold text-ink">Possible repeated call</Sub>
      <p className="mt-1 text-dim">
        {r.step} ran {count(r.repeats)} times in this task, and at least {r.threshold} within {r.window} calls. Compared on {r.basis === "arguments" ? "the same tool and the same details" : "the same tool and the same prompt (details were not stored)"}.
        {showMoney && r.cost_usd !== null ? ` The recorded cost of these calls was ${usd(r.cost_usd)}. That is a measurement, not a verdict.` : ""}
      </p>
      <ul className="mt-2 list-disc space-y-0.5 pl-5 text-xs text-muted" data-testid="repeated-hints">{r.hints.map((h) => <li key={h}>{h}</li>)}</ul>
      <div className="scroll-hint-x mt-2 overflow-auto rounded-[10px] border border-rule bg-surface" tabIndex={0} role="group" aria-label="The repeated calls">
        <table className="w-full border-collapse text-left text-xs">
          <thead className="bg-surface-2 text-[11px] uppercase tracking-wider text-muted">
            <tr><th scope="col" className="px-2 py-1.5">#</th><th scope="col" className="px-2 py-1.5">Time (UTC)</th><th scope="col" className="px-2 py-1.5">Since the one before</th><th scope="col" className="px-2 py-1.5">Agent</th><th scope="col" className="px-2 py-1.5">Tokens</th><th scope="col" className="px-2 py-1.5">Result</th><th scope="col" className="px-2 py-1.5"><span className="sr-only">Inspect</span></th></tr>
          </thead>
          <tbody className="tabular">
            {r.calls.map((c, i) => (
              <tr key={c.run_id} className={cx("border-t border-rule", c.in_window && "bg-warn/5")} data-testid="repeat-row">
                <td className="px-2 py-1">{i + 1}</td>
                <td className="px-2 py-1">{when(c.at)}</td>
                <td className="px-2 py-1">{c.gap_seconds === null ? "first" : `${c.gap_seconds.toLocaleString("en", { maximumFractionDigits: 1 })} s`}</td>
                <td className="px-2 py-1">{c.agent ? agentName(c.agent) : "Unnamed agent"}</td>
                <td className="px-2 py-1">{count(c.tokens)}</td>
                <td className="px-2 py-1">{c.failed === true ? "Failed" : c.failed === false ? "Succeeded" : "Not recorded"}</td>
                <td className="px-2 py-1"><Button size="sm" onClick={() => onInspect(c.run_id)} aria-label={`Inspect call ${i + 1} of the repeated calls`}>Inspect</Button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-1 text-[11px] text-muted">Shaded rows are the stretch that reached your threshold. This can be valid: polling and retries repeat on purpose.</p>
    </div>
  );
}

export function TaskDetail({ traceId, repeats, window }: { traceId: string; repeats: number; window: number }) {
  const q = useAgentTask(traceId, repeats, window);
  const [open, setOpen] = useState<string | null>(null);
  if (q.isPending) return <Skeleton className="h-32" />;
  if (q.isError || !isAgentTask(q.data)) return <ErrorState error={q.error ?? new Error("Could not load the task")} onRetry={() => void q.refetch()} />;
  const t: AgentTask = q.data;
  const showMoney = t.totals.cost_usd !== null || t.totals.unpriced_calls > 0;
  const sec = (s: TaskNode["section"]) => t.nodes.filter((n) => n.section === s);
  return (
    <div className="mt-2 flex flex-col gap-3" data-testid="task-detail">
      <p className="text-xs text-muted tabular" data-testid="task-total">
        Task total, each call counted once: {count(t.totals.calls)} calls, {count(t.totals.tokens)} tokens{showMoney && money(t.totals.cost_usd, t.totals.unpriced_calls) ? `, ${money(t.totals.cost_usd, t.totals.unpriced_calls)}` : ""}.
      </p>
      <TreeSection title="Calls, starting from the first" nodes={sec("tree")} onInspect={setOpen} showMoney={showMoney} />
      <TreeSection title="Calls whose parent was not recorded" nodes={sec("unlinked")} onInspect={setOpen} showMoney={showMoney} />
      <TreeSection title="Calls that sent no structure" nodes={sec("no_structure")} onInspect={setOpen} showMoney={showMoney} />
      {t.repeated && <RepeatedPanel r={t.repeated} onInspect={setOpen} showMoney={showMoney} />}
      {t.notes.length > 0 && <ul className="list-disc space-y-0.5 pl-5 text-xs text-muted" data-testid="task-notes">{t.notes.map((n) => <li key={n}>{n}</li>)}</ul>}
      <RunDetailPanel runId={open} onClose={() => setOpen(null)} />
    </div>
  );
}

function TaskRow({ t, repeats, window, showMoney }: { t: AgentTaskSummary; repeats: number; window: number; showMoney: boolean }) {
  const [open, setOpen] = useState(false);
  const id = `task-${t.trace_id.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
  return (
    <li className="rounded-[12px] border border-rule bg-surface-2/50 p-3" data-testid="task-row">
      <button type="button" aria-expanded={open} aria-controls={id} onClick={() => setOpen((o) => !o)} className="flex w-full flex-wrap items-center justify-between gap-x-3 gap-y-1 text-left">
        <span className="min-w-0 break-all font-mono text-xs text-ink" title="The task id your code sent">{open ? "− " : "+ "}{t.trace_id}</span>
        <span className="text-sm font-semibold text-ink tabular">{count(t.totals.tokens)} tokens</span>
      </button>
      <p className="mt-1 text-[13px] text-dim tabular">
        {count(t.totals.calls)} calls{showMoney && money(t.totals.cost_usd, t.totals.unpriced_calls) ? ` · ${money(t.totals.cost_usd, t.totals.unpriced_calls)}` : ""}
        {t.agents.length > 1 ? ` · ${t.agents.map(agentName).join(", ")}` : t.agents.length === 1 ? ` · ${agentName(t.agents[0])}` : ""}
      </p>
      <p className="mt-0.5 text-xs text-muted" data-testid="structure">{structureText(t.structure)}</p>
      {t.repeated_step && (
        <p className="mt-1 text-xs text-warn" data-testid="repeat-flag">
          Possible repeated call: {t.repeated_step} {count(t.repeated_times ?? 0)} times. This can be valid, such as polling or retries.
        </p>
      )}
      <div id={id}>{open && <TaskDetail traceId={t.trace_id} repeats={repeats} window={window} />}</div>
    </li>
  );
}

function side(label: string, s: Cohort["single_agent"], money: boolean) {
  const c = money && s.cost_usd ? `, median ${usd(s.cost_usd.median)}` : "";
  return `${label}: ${count(s.tokens.tasks)} tasks, median ${count(Math.round(s.tokens.median))} tokens (middle half ${count(Math.round(s.tokens.p25))} to ${count(Math.round(s.tokens.p75))})${c}`;
}

export function CohortList({ cohorts, minCohort, showMoney }: { cohorts: Cohort[]; minCohort: number; showMoney: boolean }) {
  const Sub = useSub();
  const hid = useId();
  return (
    <div data-testid="cohorts">
      <Sub id={hid} className="mb-1 text-xs font-semibold uppercase tracking-wider text-muted">Comparing equivalent tasks</Sub>
      {cohorts.length === 0 ? (
        <p className="text-sm text-dim" data-testid="no-cohorts">
          Not enough equivalent tasks to compare yet. It takes at least {minCohort} single-agent and {minCohort} multi-agent tasks of the same AI task on the same models.
        </p>
      ) : (
        <ul className="space-y-2 text-sm text-dim">
          {cohorts.map((c) => (
            <li key={`${c.job}-${c.models.join()}`} data-testid="cohort">
              <span className="font-semibold text-ink">{c.job}</span> on <span className="font-mono text-xs">{c.models.join(", ")}</span>. {side("One agent", c.single_agent, showMoney)}. {side("Several agents", c.multi_agent, showMoney)}.
            </li>
          ))}
        </ul>
      )}
      <p className="mt-1 text-xs text-muted">Measured in this project only. Tasks that look alike can still differ in other ways, so this does not show that using several agents causes the difference. No multiplier is claimed.</p>
    </div>
  );
}

export function AgentTasksBody({ days, repeats, window }: { days: number; repeats: number; window: number }) {
  const q = useAgentTasks(days, repeats, window);
  if (q.isPending) return <Skeleton className="h-40" />;
  if (q.isError || !isAgentTasks(q.data)) return <ErrorState error={q.error ?? new Error("Could not load the tasks")} onRetry={() => void q.refetch()} />;
  const d = q.data;
  const showMoney = d.mode !== "subscription";
  return (
    <div className="flex flex-col gap-4" data-testid="agent-tasks">
      {d.tasks.length === 0 ? (
        <p className="text-sm text-dim" data-testid="no-tasks">{d.notes[0] ?? "No task with a task id was recorded in this period."}</p>
      ) : (
        <ul className="flex flex-col gap-2">{d.tasks.map((t) => <TaskRow key={t.trace_id} t={t} repeats={repeats} window={window} showMoney={showMoney} />)}</ul>
      )}
      <CohortList cohorts={d.cohorts} minCohort={d.min_cohort} showMoney={showMoney} />
      {d.tasks.length > 0 && d.notes.length > 0 && <ul className="list-disc space-y-0.5 pl-5 text-xs text-muted" data-testid="notes">{d.notes.map((n) => <li key={n}>{n}</li>)}</ul>}
      <details className="text-xs text-muted">
        <summary className="cursor-pointer font-semibold text-dim">How these numbers are worked out</summary>
        <ul className="mt-2 list-disc space-y-1 pl-5">{d.method.map((m) => <li key={m}>{m}</li>)}</ul>
      </details>
    </div>
  );
}

const thresholdField = "rounded-[8px] border border-rule bg-surface px-2 py-1 text-xs text-ink";

/** The reader's own rule for pointing out a possible repeated call: how many times within how many calls. Shared by the Overview card and the
 *  MCP & Agents page, so both say the same thing and neither is a measured limit. */
export function RepeatThreshold({ repeats, window, onRepeats, onWindow }: { repeats: number; window: number; onRepeats: (n: number) => void; onWindow: (n: number) => void }) {
  return (
    <div className="mb-3 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-dim" data-testid="threshold">
      <span>Point out a call repeated at least</span>
      <label className="sr-only" htmlFor="repeat-count">Number of repeats</label>
      <select id="repeat-count" className={thresholdField} value={repeats} onChange={(e) => { const r = Number(e.target.value); onRepeats(r); if (window < r) onWindow(WINDOWS.find((w) => w >= r) ?? 15); }}>
        {REPEATS.map((r) => <option key={r} value={r}>{r} times</option>)}
      </select>
      <span>within</span>
      <label className="sr-only" htmlFor="repeat-window">Window of calls</label>
      <select id="repeat-window" className={thresholdField} value={window} onChange={(e) => onWindow(Number(e.target.value))}>
        {WINDOWS.map((w) => <option key={w} value={w} disabled={w < repeats}>{w} calls</option>)}
      </select>
      <span className="text-muted">Your choice, not a measured limit.</span>
    </div>
  );
}

export function AgentTasks({ shell }: { shell: ShellProps }) {
  const [days, setDays] = useState("30");
  const [repeats, setRepeats] = useState(5);
  const [window, setWindow] = useState(7);
  return (
    <Shell
      shell={shell}
      title="Agent tasks"
      hint="A task is every call that shares one task id. Analysis only: nothing is stopped, cancelled or changed."
      controls={<Segmented label="Period" value={days} options={TASK_DAYS.map((d) => ({ value: String(d), label: `${d} days` }))} onChange={setDays} />}
    >
      <RepeatThreshold repeats={repeats} window={window} onRepeats={setRepeats} onWindow={setWindow} />
      <AgentTasksBody days={Number(days)} repeats={repeats} window={window} />
    </Shell>
  );
}
