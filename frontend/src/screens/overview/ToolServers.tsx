/** "MCP and tool servers": which tool servers the project's own recorded calls use, how often, from which task, how long those
 * requests took and the usage of those whole requests. Analysis only: nothing is called, blocked or changed, and this cannot reach
 * the customer's app.
 *
 * What it will not do: say how many tokens a tool used. No provider reports that, only one usage total for the whole request, so
 * request usage is shown as shared with everything else in the request. A server only guessed from a tool name is "likely MCP". */
import { useState } from "react";
import { Link } from "react-router-dom";
import { useP } from "../../app/project";
import { isToolServers, TOOL_DAYS, useToolServers, type McpServer, type McpSupport, type ToolServersAnswer } from "../../features/insights/api/toolServersApi";
import { count, usd } from "../../ui/format";
import { ErrorState, Pill, Segmented, Skeleton } from "../../ui/primitives";
import { Shell, type ShellProps } from "./widgets";

const day = (iso: string) => new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
const seconds = (ms: number) => `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`;

export const CERTAINTY: Record<McpServer["certainty"], { label: string; tone: "good" | "warn" | "info"; mark: string }> = {
  provider_reported: { label: "Reported by the provider", tone: "good", mark: "✓" },
  likely: { label: "Likely MCP: guessed from the tool name", tone: "warn", mark: "?" },
  mixed: { label: "Reported by the provider, and also guessed from names", tone: "info", mark: "~" },
};

export const NATIVE: Record<McpSupport["native"], string> = {
  supported: "Reports MCP calls in its own response",
  partly: "Reports some MCP calls",
  unknown: "Unknown: not documented or not recorded",
};

function ServerCard({ s, mode }: { s: McpServer; mode: ToolServersAnswer["mode"] }) {
  const p = useP();
  const c = CERTAINTY[s.certainty];
  return (
    <li className="rounded-[12px] border border-rule bg-surface-2/50 p-3" data-testid="server-card">
      <p className="flex flex-wrap items-center gap-2 text-sm font-semibold text-ink">
        <span className="font-mono text-[13px]">{s.server}</span>
        <Pill tone={c.tone} icon={false}><span aria-hidden>{c.mark} </span>{c.label}</Pill>
      </p>
      <p className="mt-1 text-sm text-dim tabular">
        {count(s.calls)} {s.calls === 1 ? "call" : "calls"} in {count(s.requests)} {s.requests === 1 ? "request" : "requests"}
        {s.task_runs > 0 ? `, over ${count(s.task_runs)} task ${s.task_runs === 1 ? "run" : "runs"}` : ""}. Last seen {day(s.last_seen)}.
        {s.failure_known_calls > 0 ? ` ${count(s.failed_calls)} of the ${count(s.failure_known_calls)} calls whose result said so failed.` : " Whether calls failed is not recorded."}
      </p>
      <dl className="mt-2 grid gap-x-6 gap-y-1 text-xs sm:grid-cols-2">
        <div>
          <dt className="inline text-muted">Time of those requests: </dt>
          <dd className="inline text-dim tabular">{s.request_time_ms === null ? "not reported" : `${seconds(s.request_time_ms)} in the middle`}. This is the whole request, not the tool.</dd>
        </div>
        <div>
          <dt className="inline text-muted">Usage of those whole requests: </dt>
          <dd className="inline text-dim tabular">
            {count(s.request_tokens_in)} tokens in, {count(s.request_tokens_out)} out{s.request_cache_read_tokens > 0 ? `, ${count(s.request_cache_read_tokens)} read from the cache` : ""}
            {mode !== "subscription" ? (s.request_cost_usd === null ? ", cost not known" : `, ${usd(s.request_cost_usd)}${s.unpriced_requests > 0 ? ` (${count(s.unpriced_requests)} requests have no known price)` : ""}`) : ""}.
            {" "}Shared with everything else in them. Not what the tool used.
          </dd>
        </div>
      </dl>
      {s.tools.length > 0 && (
        <p className="mt-2 text-xs text-muted">
          Tools: {s.tools.map((t, i) => <span key={t.name}>{i > 0 ? ", " : ""}<span className="font-mono text-dim">{t.name}</span> ×{count(t.calls)}</span>)}
        </p>
      )}
      {s.tasks.length > 0 && (
        <p className="mt-1 text-xs text-muted">
          From: {s.tasks.map((t, i) => <span key={t.name}>{i > 0 ? ", " : ""}<Link to={p(`/jobs/${encodeURIComponent(t.name)}`)} className="font-semibold text-accent hover:underline">{t.name}</Link> ×{count(t.calls)}</span>)}
        </p>
      )}
    </li>
  );
}

function SupportList({ rows }: { rows: McpSupport[] }) {
  if (rows.length === 0) return <p className="text-xs text-muted">No provider appears in the calls of this period.</p>;
  return (
    <ul className="space-y-3" data-testid="support">
      {rows.map((r) => (
        <li key={`${r.key}-${r.seen_as}`} className="text-xs text-muted">
          <p className="font-semibold text-dim">{r.label}: {NATIVE[r.native]}. Checked {day(`${r.checked_on}T00:00:00Z`)}.</p>
          {r.we_read.length > 0 && <p className="mt-0.5">We read: {r.we_read.join("; ")}.</p>}
          {r.we_do_not_read.length > 0 && <p className="mt-0.5">We do not read: {r.we_do_not_read.join("; ")}.</p>}
          {r.not_reported_by_provider.length > 0 && <p className="mt-0.5">Not reported by the provider: {r.not_reported_by_provider.join("; ")}.</p>}
          {r.limits.length > 0 && <p className="mt-0.5">Limits: {r.limits.join(" ")}</p>}
          {r.sources.length > 0 && (
            <p className="mt-0.5">
              Source: {r.sources.map((u, i) => <span key={u}>{i > 0 ? ", " : ""}<a href={u} target="_blank" rel="noopener noreferrer" className="font-semibold text-accent hover:underline">{new URL(u).pathname.split("/").filter(Boolean).slice(-1)[0]} ↗</a></span>)}
            </p>
          )}
        </li>
      ))}
    </ul>
  );
}

export function ToolServersBody({ days, job }: { days: number; job?: string }) {
  const q = useToolServers(days, job);
  if (q.isPending) return <Skeleton className="h-40" />;
  if (q.isError || !isToolServers(q.data)) return <ErrorState error={q.error ?? new Error("Could not load the tool servers")} onRetry={() => void q.refetch()} />;
  const d = q.data;
  return (
    <div className="flex flex-col gap-4" data-testid="tool-servers">
      {d.servers.length === 0 ? (
        <p className="text-sm text-dim" data-testid="no-servers">{d.notes[0] ?? "No tool calls were recorded in this period."}</p>
      ) : (
        <>
          <ul className="flex flex-col gap-3">{d.servers.map((s) => <ServerCard key={s.server} s={s} mode={d.mode} />)}</ul>
          <p className="text-xs text-muted" data-testid="totals">
            Across all servers: {count(d.totals.requests)} requests, each counted once
            {d.totals.requests_with_several_servers > 0 ? `. ${count(d.totals.requests_with_several_servers)} of them used more than one server, so the rows above add up to more than this` : ""}.
            {" "}{count(d.totals.tokens_in)} tokens in, {count(d.totals.tokens_out)} out{d.mode !== "subscription" && d.totals.cost_usd !== null ? `, ${usd(d.totals.cost_usd)}` : ""}.
          </p>
        </>
      )}
      {d.own_tools.calls > 0 && (
        <p className="text-xs text-muted" data-testid="own-tools">
          Other tools your app calls, not an MCP server we can recognise: {count(d.own_tools.calls)} calls in {count(d.own_tools.requests)} requests
          {d.own_tools.tools.length > 0 ? ` (${d.own_tools.tools.map((t) => `${t.name} ×${count(t.calls)}`).join(", ")})` : ""}.
        </p>
      )}
      {d.servers.length > 0 && d.notes.length > 0 && (
        <ul className="list-disc space-y-0.5 pl-5 text-xs text-muted" data-testid="notes">{d.notes.map((n) => <li key={n}>{n}</li>)}</ul>
      )}
      <p className="text-xs text-muted" data-testid="tool-list-unknown">
        The size of each server's tool list is not shown: providers load it themselves and report one usage total, so it cannot be split by server. It is unknown, not estimated.
      </p>
      <details className="text-xs text-muted">
        <summary className="cursor-pointer font-semibold text-dim">What each provider tells us, and what stays unknown</summary>
        <div className="mt-2"><SupportList rows={d.support} /></div>
      </details>
      <details className="text-xs text-muted">
        <summary className="cursor-pointer font-semibold text-dim">How these numbers are worked out</summary>
        <ul className="mt-2 list-disc space-y-1 pl-5">{d.method.map((m) => <li key={m}>{m}</li>)}</ul>
      </details>
    </div>
  );
}

export function ToolServers({ shell }: { shell: ShellProps }) {
  const [days, setDays] = useState("30");
  return (
    <Shell
      shell={shell}
      title="MCP and tool servers"
      hint="From your own recorded calls. Analysis only: nothing is called, blocked or changed."
      controls={<Segmented label="Period" value={days} options={TOOL_DAYS.map((d) => ({ value: String(d), label: `${d} days` }))} onChange={setDays} />}
    >
      <ToolServersBody days={Number(days)} />
    </Shell>
  );
}
