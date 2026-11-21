/** /company/:orgId/overview : counts, tokens and list-price cost across a company's projects. Aggregates only:
 *  no prompt text, no people. Says what is counted, what is calculated, and what the calling app supplied. */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "react-router-dom";
import { apiFetch } from "../shared/api/apiFetch";
import type { CompanyOverview } from "../shared/api/types";
import { projectPath } from "../shared/projectPath";
import { count, pct, usd } from "../ui/format";
import { ErrorState, Panel, Pill, Segmented, Skeleton } from "../ui/primitives";
import { ThemeToggle } from "../ui/ThemeToggle";
import { ExportButton } from "../features/exports/ExportButton";

const DAYS = [7, 14, 30, 90] as const;
const MODE_WORDS = { per_use: "Pay per use", subscription: "Flat plan", both: "Mixed" } as const;
const SOURCE_WORDS = { verified: "Verified", caller_supplied: "Set by the app", not_recorded: "Not recorded" } as const;

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="panel p-4">
      <p className="text-[11px] uppercase tracking-wider text-muted">{label}</p>
      <p className="tabular mt-1 text-2xl font-semibold text-ink">{value}</p>
      {hint && <p className="mt-1 text-xs text-muted">{hint}</p>}
    </div>
  );
}

function Trend({ days }: { days: CompanyOverview["trend"] }) {
  if (days.length === 0) return null;
  const max = Math.max(...days.map((d) => d.calls), 1);
  return (
    <Panel className="p-5" aria-label="Calls per day">
      <h2 className="text-lg font-semibold">Calls per day</h2>
      <div role="img" aria-label={`Calls per day, from ${days[0].day} to ${days[days.length - 1].day}, most ${count(max)}`} className="mt-3 flex h-24 items-end gap-1">
        {days.map((d) => <span key={d.day} title={`${d.day}: ${count(d.calls)} calls`} className="min-w-1 flex-1 rounded-t bg-accent/70" style={{ height: `${Math.max((d.calls / max) * 100, 3)}%` }} />)}
      </div>
      <details className="mt-3 text-sm">
        <summary className="cursor-pointer text-dim">Show as a table</summary>
        <table className="mt-2 w-full text-left text-sm">
          <thead><tr className="text-xs text-muted"><th scope="col" className="py-1 font-medium">Day</th><th scope="col" className="font-medium">Calls</th><th scope="col" className="font-medium">Tokens</th><th scope="col" className="font-medium">Pay-per-use cost</th></tr></thead>
          <tbody className="divide-y divide-rule">{days.map((d) => <tr key={d.day}><th scope="row" className="py-1 text-left font-normal">{d.day}</th><td className="tabular">{count(d.calls)}</td><td className="tabular">{count(d.tokens)}</td><td className="tabular">{usd(d.billable_usd)}</td></tr>)}</tbody>
        </table>
      </details>
    </Panel>
  );
}

export default function CompanyOverviewScreen() {
  const { orgId = "" } = useParams();
  const [days, setDays] = useState<(typeof DAYS)[number]>(30);
  const q = useQuery({
    queryKey: ["company-overview", orgId, days],
    queryFn: () => apiFetch<CompanyOverview>(`/v1/organisations/${encodeURIComponent(orgId)}/overview?days=${days}`),
    retry: false,
  });
  const o = q.data;
  return (
    <div className="min-h-screen">
      <header className="border-b border-rule">
        <div className="mx-auto flex h-16 max-w-5xl items-center justify-between px-4">
          <Link to={`/company/${orgId}`} className="text-sm font-semibold text-accent hover:underline">Back to the company</Link>
          <ThemeToggle />
        </div>
      </header>
      <main className="mx-auto flex max-w-5xl flex-col gap-6 px-4 py-10">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-3xl font-semibold tracking-tight [overflow-wrap:anywhere]">{o ? `${o.name}: overview` : "Company overview"}</h1>
            <p className="mt-1 text-sm text-dim">Counts and list-price cost across projects you can open. No prompts, no answers and no people.</p>
          </div>
          {o && (o.your_role === "admin" || o.your_role === "owner") && o.totals.has_data && (
            <ExportButton path={`/v1/organisations/${encodeURIComponent(orgId)}/overview/export.csv?days=${days}`} what={`the last ${days} days of ${o.name}`}
              title="Download this overview as a spreadsheet file (CSV): counts, tokens and cost only, never prompts or people">
              Export CSV
            </ExportButton>
          )}
          <Segmented label="Period" value={String(days) as `${(typeof DAYS)[number]}`} options={DAYS.map((d) => ({ value: String(d) as `${typeof d}`, label: `${d} days` }))} onChange={(v) => setDays(Number(v) as (typeof DAYS)[number])} />
        </div>

        {q.isPending && <div role="status" aria-label="Loading" className="grid gap-3 sm:grid-cols-4"><Skeleton className="h-24" /><Skeleton className="h-24" /><Skeleton className="h-24" /><Skeleton className="h-24" /></div>}
        {q.isError && <ErrorState error={q.error} onRetry={() => q.refetch()} />}

        {o && (
          <>
            {!o.totals.has_data ? (
              <Panel className="p-6 text-center">
                <h2 className="text-lg font-semibold">{o.projects_shown === 0 ? "No projects yet" : "No AI calls recorded in this period"}</h2>
                <p className="mt-1 text-sm text-dim">{o.projects_shown === 0 ? "Create a project in this company and send its first call." : "Once a project records calls, the numbers appear here."}</p>
              </Panel>
            ) : (
              <>
                <section aria-label="Totals" className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                  <Stat label="AI calls" value={count(o.totals.calls)} hint="Counted" />
                  <Stat label="Tokens" value={count(o.totals.tokens)} hint="Counted, from calls that report them" />
                  <Stat label="Pay-per-use cost" value={usd(o.totals.billable_usd)} hint="Calculated at list price, not an invoice" />
                  <Stat label="Unpriced calls" value={count(o.totals.unpriced_calls)} hint="Cost unknown, not counted as free" />
                </section>
                {o.by_mode.both.projects > 0 && (
                  <p className="text-sm text-dim">Mixed-mode projects add {usd(o.totals.mixed_mode_usd)} at list price, shown apart because flat-plan calls cannot be told from pay-per-use ones.</p>
                )}
                <Trend days={o.trend} />
              </>
            )}

            <Panel className="p-5" aria-label="Projects">
              <h2 className="text-lg font-semibold">By project</h2>
              {o.projects.length === 0 ? <p className="mt-2 text-sm text-dim">No projects you can open.</p> : (
                <div className="mt-3 overflow-x-auto" tabIndex={0} role="group" aria-label="Projects table">
                  <table className="w-full min-w-[40rem] text-left text-sm">
                    <thead><tr className="text-xs text-muted"><th scope="col" className="py-1 font-medium">Project</th><th scope="col" className="font-medium">Pay mode</th><th scope="col" className="text-right font-medium">Calls</th><th scope="col" className="text-right font-medium">Tokens</th><th scope="col" className="text-right font-medium">Cost</th><th scope="col" className="text-right font-medium">Unpriced</th></tr></thead>
                    <tbody className="divide-y divide-rule">
                      {o.projects.map((p) => (
                        <tr key={p.project_id}>
                          <th scope="row" className="py-2 text-left font-semibold"><Link to={projectPath({ slug: p.slug, project_id: p.project_id })} className="text-accent hover:underline" aria-label={`Open ${p.name}`}>{p.name}</Link></th>
                          <td><Pill tone="neutral" icon={false}>{MODE_WORDS[p.pay_mode]}</Pill></td>
                          <td className="tabular text-right">{count(p.calls)}</td>
                          <td className="tabular text-right">{count(p.tokens)}</td>
                          <td className="tabular text-right">{p.cost_usd === null ? "No dollars on a flat plan" : usd(p.cost_usd)}</td>
                          <td className="tabular text-right">{count(p.unpriced_calls)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Panel>

            {o.tasks.length > 0 && (
              <Panel className="p-5" aria-label="Tasks">
                <h2 className="text-lg font-semibold">By AI task</h2>
                <p className="mt-1 text-sm text-dim">Task names are chosen by each app. They are labels, not verified identities.</p>
                <div className="mt-3 overflow-x-auto" tabIndex={0} role="group" aria-label="Tasks table">
                  <table className="w-full min-w-[36rem] text-left text-sm">
                    <thead><tr className="text-xs text-muted"><th scope="col" className="py-1 font-medium">Task</th><th scope="col" className="font-medium">Project</th><th scope="col" className="text-right font-medium">Calls</th><th scope="col" className="text-right font-medium">Tokens</th><th scope="col" className="text-right font-medium">Cost</th></tr></thead>
                    <tbody className="divide-y divide-rule">
                      {o.tasks.map((t) => <tr key={`${t.project_id}-${t.task}`}><th scope="row" className="py-2 text-left font-normal">{t.task}</th><td className="text-dim">{t.project ?? "Several"}</td><td className="tabular text-right">{count(t.calls)}</td><td className="tabular text-right">{count(t.tokens)}</td><td className="tabular text-right">{t.cost_usd === null ? "Flat plan" : usd(t.cost_usd)}</td></tr>)}
                    </tbody>
                  </table>
                </div>
              </Panel>
            )}

            {o.models.length > 0 && (
              <Panel className="p-5" aria-label="Models">
                <h2 className="text-lg font-semibold">By model</h2>
                <div className="mt-3 overflow-x-auto" tabIndex={0} role="group" aria-label="Models table">
                  <table className="w-full min-w-[32rem] text-left text-sm">
                    <thead><tr className="text-xs text-muted"><th scope="col" className="py-1 font-medium">Model</th><th scope="col" className="text-right font-medium">Calls</th><th scope="col" className="text-right font-medium">Tokens</th><th scope="col" className="text-right font-medium">List-price cost</th><th scope="col" className="text-right font-medium">Unpriced</th></tr></thead>
                    <tbody className="divide-y divide-rule">
                      {o.models.map((m) => <tr key={m.model}><th scope="row" className="py-2 text-left font-normal">{m.model}</th><td className="tabular text-right">{count(m.calls)}</td><td className="tabular text-right">{count(m.tokens)}</td><td className="tabular text-right">{usd(m.cost_usd)}</td><td className="tabular text-right">{count(m.unpriced_calls)}</td></tr>)}
                    </tbody>
                  </table>
                </div>
              </Panel>
            )}

            <Panel className="p-5" aria-label="Data coverage and attribution">
              <h2 className="text-lg font-semibold">How far to trust these numbers</h2>
              <p className="mt-1 text-sm text-dim">
                {o.coverage.token_report_share === null ? "No calls yet." : `${pct(o.coverage.token_report_share, 0)} of calls report token counts.`} Not suitable for charging customers or teams: labels come from the apps.
              </p>
              <ul className="mt-3 divide-y divide-rule text-sm">
                {o.attribution.map((a) => (
                  <li key={a.dimension} className="flex flex-wrap items-baseline justify-between gap-2 py-2">
                    <span className="min-w-0 flex-1"><strong className="font-semibold">{a.dimension.replace("_", " ")}</strong> <span className="text-dim">{a.detail}</span></span>
                    <span className="flex items-center gap-2"><Pill tone={a.source === "verified" ? "good" : "neutral"} icon={false}>{SOURCE_WORDS[a.source]}</Pill>{a.coverage_share !== null && <span className="tabular text-xs text-muted">{pct(a.coverage_share, 0)} of calls</span>}</span>
                  </li>
                ))}
              </ul>
              <ul className="mt-3 list-disc space-y-1 pl-5 text-xs text-muted">{o.notes.map((n) => <li key={n}>{n}</li>)}</ul>
            </Panel>
          </>
        )}
      </main>
    </div>
  );
}
