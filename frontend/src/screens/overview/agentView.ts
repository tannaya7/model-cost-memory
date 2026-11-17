/** Plain-language wording for the agents view. Pure, so it is easy to test. */
import type { AgentUsage, ToolsUsage, TraceUsage } from "../../features/insights/api/agentsApi";
import { jobTitle } from "../../features/jobs/jobTitle";
import type { BillingMode } from "../../features/projects/hooks/useBillingMode";
import { count, usd } from "../../ui/format";

export const MIN_CALLS = 25;
/** Tool definitions this big on every call may be worth a look. The number of tools is not stored, so only size is used. */
export const TOOL_LIST_TIP_TOKENS = 10_000;

export const agentName = (a: string) => (a === "unlabelled" ? "Unnamed agent" : jobTitle(a));

export type Badge = { id: string; text: string; sure: boolean };

/** Labels worked out from the calls. "Probably" is said whenever we are not certain. */
export function agentBadges(a: AgentUsage): Badge[] {
  const out: Badge[] = [];
  if (a.works_like_agent === "yes") out.push({ id: "agent", text: "Looks like an agent", sure: false });
  else if (a.works_like_agent === "probably") out.push({ id: "agent", text: "Might look like an agent", sure: false });
  if (a.uses_tools) out.push({ id: "tools", text: "Uses tools", sure: true });
  if (a.tool_source === "mcp") out.push({ id: "mcp", text: (a.tool_servers ?? []).length ? `Tool names look like tool servers (MCP): ${(a.tool_servers ?? []).join(", ")}` : "Tool names look like tool servers (MCP)", sure: false });
  else if (a.tool_source === "tool_list") out.push({ id: "list", text: "Has a tool list", sure: true });
  return out;
}

/** What an agent or task used, in the words that fit how the project pays: money for per use, tokens for a subscription, both labelled for both. */
export function usedText(spendUsd: number, tokens: number, mode: BillingMode): string {
  const money = spendUsd > 0 ? usd(spendUsd) : "cost not known";
  if (mode === "per_use") return money;
  const tok = `${count(tokens)} tokens`;
  return mode === "subscription" ? tok : `${tok} · ${spendUsd > 0 ? `${money} at list prices` : "list-price cost not known"}`;
}

export function loopText(t: TraceUsage, mode: BillingMode = "per_use"): string | null {
  const l = t.possible_loop;
  if (!l) return null;
  const how = l.uses_arguments ? "with the same details" : "with the same question";
  const cost = l.cost_usd < 0.01 ? "under 1 cent" : `$${l.cost_usd.toFixed(2)}`;
  if (mode === "subscription") return `Possible loop: ${l.step} ran ${l.repeats} times in a short stretch ${how}.`;
  return `Possible loop: ${l.step} ran ${l.repeats} times in a short stretch ${how}, costing about ${cost}${mode === "both" ? " at list prices" : ""}.`;
}

export function toolListTip(t: ToolsUsage, mode: BillingMode = "per_use"): string | null {
  if (t.avg_tools_tokens < TOOL_LIST_TIP_TOKENS) return null;
  const what = mode === "subscription" ? "use fewer tokens" : "lower the cost";
  return `The list of tools you send may be large. A shorter list, or sending only the tools each step needs, may ${what}. It is an idea, not a promise.`;
}
