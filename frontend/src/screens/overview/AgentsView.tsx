/** "What is using your tokens": agents, their heaviest runs, and the tool list. All worked out from the calls; nobody has to label anything. */
import { useAgentInsights, type AgentInsights, type AgentUsage, type ToolsUsage, type TraceUsage } from "../../features/insights/api/agentsApi";
import { jobTitle } from "../../features/jobs/jobTitle";
import { count, pct } from "../../ui/format";
import { Link } from "react-router-dom";
import { useToolInputsSwitch } from "../../features/projects/hooks/useToolInputs";
import { Help } from "../../ui/Help";
import { NotEnoughData, NoCallsYet } from "../../ui/NotEnoughData";
import { ErrorState, Skeleton } from "../../ui/primitives";
import { Shell, type Ctx, type ShellProps } from "./widgets";
import { MIN_CALLS, agentBadges, agentName, loopText, toolListTip, usedText } from "./agentView";
import { useBillingMode } from "../../features/projects/hooks/useBillingMode";

const AGENTS_HELP = "An agent is a part of your app that makes AI calls, often a helper with a job such as researching or writing. We group calls by the agent name your code sends. Calls with no name are shown as Unnamed agent. Shares are of all the tokens used in the period.";
const TOOLS_HELP = "Tool servers (MCP) are ready-made add-ons that let an AI app reach outside services such as GitHub or Slack. We only say the tool names look like tool servers when they follow the usual mcp__server__tool naming, which is a habit rather than a rule, so it can be wrong. Otherwise we call it a tool list.";

function Badges({ a }: { a: AgentUsage }) {
  const badges = agentBadges(a);
  if (badges.length === 0) return null;
  return (
    <ul className="mt-2 flex flex-wrap gap-1.5" aria-label="What we noticed">
      {badges.map((b) => (
        <li key={b.id} className="rounded-md border border-rule bg-surface px-1.5 py-0.5 text-[11px] text-dim">{b.text}</li>
      ))}
    </ul>
  );
}

function AgentCard({ a }: { a: AgentUsage }) {
  const { mode } = useBillingMode();
  return (
    <li className="rounded-[12px] border border-rule bg-surface-2 p-4">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <p className="min-w-0 break-words text-sm font-semibold text-ink">{agentName(a.agent)}</p>
        <p className="text-sm font-semibold text-ink tabular">{pct(a.share, 0)} of your tokens</p>
      </div>
      <div role="img" aria-label={`${pct(a.share, 0)} of all tokens`} className="mt-2 h-2 overflow-hidden rounded-full bg-surface-3">
        <div className="h-full rounded-full bg-gradient-to-r from-accent to-accent-2" style={{ width: `${Math.min(Math.max(a.share, 0), 1) * 100}%` }} />
      </div>
      <p className="mt-2 text-[13px] text-dim tabular">
        {count(a.runs)} calls · {usedText(a.spend_usd, a.tokens_in + a.tokens_out + (a.cache_read_tokens ?? 0), mode)}
        {a.steps_per_task !== null && a.steps_per_task !== undefined && <> · about {a.steps_per_task} steps per task</>}
      </p>
      {(a.models ?? []).length > 0 && <p className="mt-0.5 break-words text-xs text-muted">Models: {(a.models ?? []).join(", ")}</p>}
      <Badges a={a} />
      {(a.top_tools ?? []).length > 0 && (
        <p className="mt-2 break-words text-xs text-dim">
          Tools used most: {(a.top_tools ?? []).slice(0, 3).map((t) => `${t.name} (${count(t.calls)})`).join(", ")}
        </p>
      )}
    </li>
  );
}

/** One soft line under a possible repeated call found without tool inputs, pointing at the Settings switch while it is off. */
function LoopInputsHint() {
  const sw = useToolInputsSwitch();
  if (!sw.canEdit || !sw.ready || sw.on) return null;
  return (
    <span className="mt-1 block text-xs text-dim">
      A repeated call whose details change each step is easy to miss. You can <Link className="underline" to="/settings#tool-inputs">turn on keeping tool inputs</Link> so repeats can be compared on their details.
    </span>
  );
}

function TraceRow({ t }: { t: TraceUsage }) {
  const { mode } = useBillingMode();
  const loop = loopText(t, mode);
  return (
    <li className="rounded-[12px] border border-rule bg-surface-2 p-3">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <p className="min-w-0 break-all font-mono text-xs text-ink" title="The task id your code sent">{t.trace_id}</p>
        <p className="text-sm font-semibold text-ink tabular">{count(t.tokens)} tokens</p>
      </div>
      <p className="mt-1 text-[13px] text-dim tabular">
        {count(t.calls)} calls{mode === "per_use" ? ` · ${usedText(t.spend_usd, t.tokens, mode)}` : mode === "both" ? ` · ${usedText(t.spend_usd, t.tokens, mode).replace(/^[^·]*· /, "")}` : ""}
        {t.multi_agent && <> · several agents worked on it ({(t.agent_names ?? []).map(agentName).join(", ")})</>}
      </p>
      {loop && (
        <p className="mt-2 rounded-md border border-warn/40 bg-warn/10 p-2 text-[13px] text-ink">
          {loop} <span className="ml-1 rounded border border-rule px-1 text-[10px] uppercase tracking-wider text-muted">Beta</span>
          {t.possible_loop && !t.possible_loop.uses_arguments && <LoopInputsHint />}
        </p>
      )}
      {!loop && t.repeated_prompts && <p className="mt-2 text-[13px] text-dim">The same question was sent several times, which may be a retry.</p>}
    </li>
  );
}

function ToolRow({ t, showJob = true }: { t: ToolsUsage; showJob?: boolean }) {
  const { mode } = useBillingMode();
  const tip = toolListTip(t, mode);
  return (
    <li className="rounded-[12px] border border-rule bg-surface-2 p-3">
      <p className="text-sm text-ink">
        {showJob && <span className="font-semibold">{jobTitle(t.job)}: </span>}
        about {count(t.avg_tools_tokens)} tokens of tool list on every call, roughly {pct(t.share_of_tokens_in, 0)} of what you send in
      </p>
      <p className="mt-0.5 text-xs text-muted">Estimate: size guessed from the tool list your code sends.</p>
      {tip && <p className="mt-1 text-[13px] text-dim">{tip}</p>}
    </li>
  );
}

/** An empty or older reply must never crash the screen. */
function normalise(raw: Partial<AgentInsights> | undefined): AgentInsights {
  return {
    agents: Array.isArray(raw?.agents) ? raw.agents : [],
    traces: Array.isArray(raw?.traces) ? raw.traces : [],
    tools: Array.isArray(raw?.tools) ? raw.tools : [],
    kinds: raw?.kinds ?? { calls: 0, uses_tools: false, works_like_agent: null, tool_source: null, tool_servers: [], multi_agent: false },
  };
}

function totalCalls(d: AgentInsights) {
  return d.agents.reduce((n, a) => n + a.runs, 0);
}

function Loading() {
  return (
    <div className="space-y-3" aria-busy="true">
      <Skeleton className="h-24 w-full" />
      <Skeleton className="h-24 w-full" />
    </div>
  );
}

/** The agents, heaviest runs and tool list for the whole project. */
export function AgentsBody({ days }: { days: number }) {
  const q = useAgentInsights(days);
  if (q.isPending) return <Loading />;
  if (q.isError) return <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  const d = normalise(q.data);
  const n = totalCalls(d);
  if (n === 0) return <NoCallsYet />;
  if (n < MIN_CALLS) {
    return (
      <NotEnoughData n={n} min={MIN_CALLS} what="AI calls">
        Next step: keep using your app. Once there are enough calls we show who uses the tokens.
      </NotEnoughData>
    );
  }
  const named = d.agents.some((a) => a.agent !== "unlabelled");
  return (
    <div className="space-y-4">
      {!named && (
        <p className="text-[13px] text-dim">
          None of your calls name an agent, so they are grouped as one Unnamed agent. If your app has several helpers, adding an agent name to each call lets us split them.
        </p>
      )}
      {d.kinds.multi_agent && <p className="text-[13px] text-dim">Several agents share some of your tasks, so a single task may use tokens from more than one agent.</p>}
      <ul className="space-y-3">{d.agents.map((a) => <AgentCard key={a.agent} a={a} />)}</ul>
      {d.traces.length > 0 && (
        <section>
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted">Heaviest tasks</h3>
          <ul className="space-y-2">{d.traces.slice(0, 5).map((t) => <TraceRow key={t.trace_id} t={t} />)}</ul>
        </section>
      )}
      {d.tools.length > 0 && (
        <section>
          <h3 className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-muted">
            Tool list size <Help label="What is a tool list?">{TOOLS_HELP}</Help>
          </h3>
          <ul className="space-y-2">{d.tools.slice(0, 3).map((t) => <ToolRow key={t.job} t={t} />)}</ul>
        </section>
      )}
      <p className="text-xs text-muted">Counts are measured from the last {days} days of live calls. Labels such as "works like an agent" are our best reading of your calls and may be wrong. Possible repeated calls are in beta.</p>
    </div>
  );
}

/** Just this AI task's tool list size, for its Tokens tab. */
export function ToolListBody({ job, days }: { job: string; days: number }) {
  const q = useAgentInsights(days);
  if (q.isPending) return <Skeleton className="h-16 w-full" />;
  if (q.isError) return <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  const mine = normalise(q.data).tools.find((t) => t.job === job);
  if (!mine) return <p className="text-[13px] text-dim">This task does not send a tool list, or has not reported its size yet.</p>;
  return (
    <ul>
      <ToolRow t={mine} showJob={false} />
    </ul>
  );
}

export function AgentsView({ ctx, shell }: { ctx: Ctx; shell: ShellProps }) {
  return (
    <Shell shell={shell} title="What is using your tokens" help={AGENTS_HELP} hint="Which agents use the most, and their heaviest tasks.">
      <AgentsBody days={ctx.days} />
    </Shell>
  );
}
