/** Plain-language wording for the agents view. Pure, so it is easy to test. */
import type { AgentUsage, ToolsUsage, TraceUsage } from "../../features/insights/api/agentsApi";
import { jobTitle } from "../../features/jobs/jobTitle";

export const MIN_CALLS = 25;
/** Tool definitions this big on every call may be worth a look. The number of tools is not stored, so only size is used. */
export const TOOL_LIST_TIP_TOKENS = 10_000;

export const agentName = (a: string) => (a === "unlabelled" ? "Unnamed agent" : jobTitle(a));

export type Badge = { id: string; text: string; sure: boolean };

/** Labels worked out from the calls. "Probably" is said whenever we are not certain. */
export function agentBadges(a: AgentUsage): Badge[] {
  const out: Badge[] = [];
  if (a.works_like_agent === "yes") out.push({ id: "agent", text: "Works like an agent", sure: true });
  else if (a.works_like_agent === "probably") out.push({ id: "agent", text: "Probably works like an agent", sure: false });
  if (a.uses_tools) out.push({ id: "tools", text: "Uses tools", sure: true });
  if (a.tool_source === "mcp") out.push({ id: "mcp", text: (a.tool_servers ?? []).length ? `Tool servers: ${(a.tool_servers ?? []).join(", ")}` : "Tool servers", sure: true });
  else if (a.tool_source === "tool_list") out.push({ id: "list", text: "Has a tool list", sure: true });
  return out;
}

export function loopText(t: TraceUsage): string | null {
  const l = t.possible_loop;
  if (!l) return null;
  const how = l.uses_arguments ? "with the same details" : "with the same question";
  const cost = l.cost_usd < 0.01 ? "under 1 cent" : `$${l.cost_usd.toFixed(2)}`;
  return `Possible loop: ${l.step} ran ${l.repeats} times in a short stretch ${how}, costing about ${cost}.`;
}

export function toolListTip(t: ToolsUsage): string | null {
  if (t.avg_tools_tokens < TOOL_LIST_TIP_TOKENS) return null;
  return "The list of tools you send may be large. A shorter list, or sending only the tools each step needs, may lower the cost. It is an idea, not a promise.";
}
