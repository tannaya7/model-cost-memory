/** MCP & Agents: which agents, agent tasks and MCP tool servers appear in the customer's own recorded calls, and how much usage they account for.
 *  The parts are the ones the Overview already shows, gathered under one top-level destination; nothing is re-implemented here.
 *
 *  Analysis only: this page reads recorded calls. It never connects to, stops, disables or reconfigures an agent, an MCP server, the app or
 *  its traffic, and "possible repeated call" is never called waste. */
import { useState } from "react";
import { EmptyState, Panel, PanelHeader, Reveal, Segmented } from "../ui/primitives";
import { AgentsBody } from "./overview/AgentsView";
import { AgentTasksBody, RepeatThreshold } from "./overview/AgentTasks";
import { ToolServersBody } from "./overview/ToolServers";

const DAYS = [7, 30, 90] as const;

function Legend() {
  return (
    <dl className="grid gap-3 text-sm sm:grid-cols-3" aria-label="How to read the labels on this page">
      <div className="rounded-[12px] border border-rule bg-surface-2/50 p-3.5">
        <dt className="font-semibold text-ink">Exact</dt>
        <dd className="mt-1 text-dim">Counted from the calls your app recorded, each call once. A request's usage total, as the provider reported it, is also exact.</dd>
      </div>
      <div className="rounded-[12px] border border-rule bg-surface-2/50 p-3.5">
        <dt className="font-semibold text-ink">Inferred</dt>
        <dd className="mt-1 text-dim">Worked out from a name pattern, for example a tool called <span className="font-mono text-xs">mcp__server__tool</span>. Shown as "Likely", never as certain.</dd>
      </div>
      <div className="rounded-[12px] border border-rule bg-surface-2/50 p-3.5">
        <dt className="font-semibold text-ink">Estimated</dt>
        <dd className="mt-1 text-dim">A share we worked out, such as the size of a tool list. Providers report one usage total per request, so a tool's own tokens are unknown unless said otherwise.</dd>
      </div>
    </dl>
  );
}

export default function McpAgents() {
  const [days, setDays] = useState("30");
  const [repeats, setRepeats] = useState(5);
  const [window, setWindow] = useState(7);
  const n = Number(days);
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight">MCP &amp; Agents</h1>
          <p className="mt-1 max-w-2xl text-sm text-dim">
            Which agents, agent tasks and tool servers appear in the calls your app recorded, and how much usage they account for. This page reads recorded calls only. It never connects to, stops or changes your agents, your MCP servers, your app or your models.
          </p>
        </div>
        <Segmented label="Period" value={days} options={DAYS.map((d) => ({ value: String(d), label: `${d} days` }))} onChange={setDays} />
      </div>

      <Reveal><Legend /></Reveal>

      <Reveal delay={0.05}>
        <Panel className="p-5 md:p-6" id="agents">
          <PanelHeader title="What is using your tokens" hint="The agents that account for the most usage, their heaviest tasks, the tools they use, and how big your tool lists are." />
          <div className="mt-4"><AgentsBody days={n} /></div>
        </Panel>
      </Reveal>

      <Reveal delay={0.1}>
        <Panel className="p-5 md:p-6" id="agent-tasks">
          <PanelHeader title="Agent tasks" hint="A task is every call that shares one task id, shown as a tree of which call started which, with a total that counts each call once." />
          <div className="mt-4">
            <RepeatThreshold repeats={repeats} window={window} onRepeats={setRepeats} onWindow={setWindow} />
            <AgentTasksBody days={n} repeats={repeats} window={window} />
          </div>
        </Panel>
      </Reveal>

      <Reveal delay={0.15}>
        <Panel className="p-5 md:p-6" id="mcp">
          <PanelHeader title="MCP and tool servers" hint="Which tool servers your recorded calls use, how often, from which task, and the usage of those whole requests." />
          <div className="mt-4"><ToolServersBody days={n} /></div>
        </Panel>
      </Reveal>

      <EmptyState title="Possible repeats are not waste" hint="A call repeated several times can be polling, a retry or a normal workflow. We point it out and show the calls behind it, so you can decide whether it is expected. We never stop, hide or change a call." />
    </div>
  );
}
