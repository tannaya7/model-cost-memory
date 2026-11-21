/** Data coverage: how complete and reliable the records Model & Cost Memory RECEIVED are.
 *  It describes received records only. Calls that never reached us cannot be seen, so no "100% complete" figure is shown. Every share names its
 *  denominator; unknown is never shown as zero; doubtful calls stay in every total and are listed under the reason. Read-only. */
import { useState } from "react";
import { useCoverage, type CoverageShare } from "../features/insights/api/coverageApi";
import { useJobs } from "../features/jobs/hooks/useJobs";
import { count, pct, shortDate } from "../ui/format";
import { EmptyState, ErrorState, Panel, PanelHeader, Reveal, Segmented, Skeleton } from "../ui/primitives";

const DAYS = [7, 30, 90] as const;
const field = "rounded-[8px] border border-rule bg-surface px-2.5 py-1.5 text-sm text-ink";

function Row({ label, share, of, note }: { label: string; share: CoverageShare; of: string; note?: string }) {
  return (
    <tr data-testid="coverage-row">
      <th scope="row" className="py-2 text-left font-normal">
        <span className="font-medium text-ink">{label}</span>
        {note && <span className="block text-[11px] text-muted">{note}</span>}
      </th>
      <td className="tabular text-right">{count(share.runs)}</td>
      <td className="tabular text-right">{share.share === null ? "n/a" : pct(share.share, 1)}</td>
      <td className="text-right text-xs text-muted">of {of}</td>
    </tr>
  );
}

export default function DataCoverage() {
  const taskList = useJobs();
  const [days, setDays] = useState("30");
  const [provider, setProvider] = useState("");
  const [model, setModel] = useState("");
  const [task, setTask] = useState("");
  const q = useCoverage({ days: Number(days), provider: provider.trim(), model: model.trim(), job: task });

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-3xl font-semibold tracking-tight">Data coverage</h1>
        <p className="mt-1 max-w-2xl text-sm text-dim">
          How complete and reliable the calls we received are, so you know how far to trust the totals, comparisons and plans built on them. This describes what reached us. It cannot see calls your app made that never did.
        </p>
      </div>

      <Panel className="p-4 md:p-5">
        <form className="flex flex-wrap items-end gap-4" aria-label="Coverage filters" onSubmit={(e) => e.preventDefault()}>
          <Segmented label="Period" value={days} options={DAYS.map((d) => ({ value: String(d), label: `${d} days` }))} onChange={setDays} />
          <label className="flex flex-col gap-1 text-xs text-dim" htmlFor="cov-task">Task
            <select id="cov-task" className={field} value={task} onChange={(e) => setTask(e.target.value)}>
              <option value="">All tasks</option>
              {(taskList.data ?? []).map((j) => <option key={j.name} value={j.name}>{j.name}</option>)}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-xs text-dim" htmlFor="cov-provider">Provider
            <input id="cov-provider" className={`${field} w-36`} value={provider} placeholder="all" onChange={(e) => setProvider(e.target.value)} />
          </label>
          <label className="flex flex-col gap-1 text-xs text-dim" htmlFor="cov-model">Model
            <input id="cov-model" className={`${field} w-44`} value={model} placeholder="all" onChange={(e) => setModel(e.target.value)} />
          </label>
        </form>
      </Panel>

      {q.isPending ? <Skeleton className="h-64" /> : q.isError ? <ErrorState error={q.error} onRetry={() => void q.refetch()} /> : q.data.attempts === 0 ? (
        <EmptyState title="No calls received in this period" hint="Once your app has sent calls, this page shows how complete they are. Nothing is shown or invented until then." />
      ) : (
        <>
          <Reveal>
            <Panel className="p-5 md:p-6" id="summary">
              <PanelHeader title="What we received" hint={q.data.scope} />
              <p className="mt-3 text-sm text-dim" data-testid="coverage-counts">
                <strong className="text-ink">{count(q.data.logical_tasks)}</strong> tasks and <strong className="text-ink">{count(q.data.attempts)}</strong> attempts, {shortDate(q.data.period_start)} to {shortDate(q.data.period_end)} ({q.data.timezone}).
                {q.data.tasks_with_several_attempts > 0 && ` ${count(q.data.tasks_with_several_attempts)} task(s) made several attempts (${count(q.data.extra_attempts)} extra); they are shown, never merged into one.`}
                {q.data.logical_tasks === q.data.attempts && " Your app sends no task ids, so each attempt counts as its own task."}
                {q.data.excluded_attempts > 0 && ` ${count(q.data.excluded_attempts)} archived or invalid attempt(s) are in the counts above but left out of the check figures.`}
              </p>
              <div className="mt-3 overflow-x-auto" role="group" aria-label="Coverage figures" tabIndex={0}>
                <table className="w-full min-w-[34rem] text-left text-sm">
                  <caption className="sr-only">How many received attempts have usage, a model, a price and a check result, each with the number it is a share of</caption>
                  <thead><tr className="text-xs text-muted"><th scope="col" className="py-1 font-medium">Measure</th><th scope="col" className="text-right font-medium">Attempts</th><th scope="col" className="text-right font-medium">Share</th><th scope="col" className="text-right font-medium">Denominator</th></tr></thead>
                  <tbody className="divide-y divide-rule">
                    <Row label="Provider reported usage" share={q.data.usage_reported} of="attempts received" />
                    <Row label="No usage block (tokens and cost unknown)" share={q.data.no_usage_block} of="attempts received" />
                    <Row label="Model name present" share={q.data.model_known} of="attempts received" />
                    <Row label="Cost calculated here from usage and a list price" share={q.data.priced} of="attempts received" />
                    <Row label="Cost sent by your app" share={q.data.caller_cost} of="attempts received" note="Used as sent; not recalculated" />
                    <Row label="No cost known" share={q.data.unpriced} of="attempts received" note="Unknown, never counted as free" />
                    <Row label="Checked (passed or failed)" share={q.data.checked} of="attempts not archived or invalid" note={`${count(q.data.passed)} passed, ${count(q.data.failed)} failed`} />
                    <Row label="Not checked yet" share={q.data.unchecked} of="attempts not archived or invalid" />
                    <Row label="Flagged as doubtful" share={q.data.flagged} of="attempts received" note="Kept in every total; see below" />
                  </tbody>
                </table>
              </div>
              <p className="mt-3 text-xs text-muted" data-testid="duplicates">
                Duplicate deliveries ignored: {q.data.duplicates_ignored === null ? "not available with a filter" : count(q.data.duplicates_ignored)}. {q.data.duplicates_note}
              </p>
            </Panel>
          </Reveal>

          <Reveal delay={0.05}>
            <Panel className="p-5 md:p-6" id="causes">
              <PanelHeader title="Where the data is doubtful" hint="Each line comes from your actual calls. Nothing is hidden: these calls stay in every total." />
              {q.data.causes.length === 0 ? (
                <p className="mt-3 text-sm text-dim" data-testid="no-causes">No doubtful calls were found in these records. That says nothing about calls that never reached us.</p>
              ) : (
                <ul className="mt-3 flex flex-col gap-3" data-testid="causes">
                  {q.data.causes.map((c) => (
                    <li key={c.code} className="rounded-[12px] border border-rule p-3.5">
                      <p className="text-sm font-medium text-ink"><span className="tabular">{count(c.runs)}</span> call(s): {c.label}</p>
                      <details className="mt-1 text-xs text-dim">
                        <summary className="cursor-pointer text-ink">Show {c.examples.length} example(s)</summary>
                        <ul className="mt-1 space-y-0.5">{c.examples.map((e) => <li key={e.run_id} className="tabular [overflow-wrap:anywhere]">{e.run_id} · {e.model}{e.provider ? ` · ${e.provider}` : ""} · {shortDate(e.created_at)}</li>)}</ul>
                        <p className="mt-1 text-muted">Ids, model and time only. Prompts, outputs and keys are never shown here.</p>
                      </details>
                    </li>
                  ))}
                </ul>
              )}
            </Panel>
          </Reveal>

          <Reveal delay={0.08}>
            <Panel className="p-5 md:p-6" id="basis">
              <PanelHeader title="How each cost was worked out" hint="Calculated from reported usage and a dated list price, or sent by your app. None is a charge your provider confirmed." />
              <ul className="mt-3 space-y-1 text-sm" data-testid="basis">{q.data.basis.map((b) => <li key={b.status}><span className="tabular font-medium text-ink">{count(b.runs)}</span> <span className="text-dim">{b.label}</span></li>)}</ul>
              {q.data.providers.length > 0 && (
                <div className="mt-4" data-testid="providers">
                  <p className="text-sm font-semibold text-ink">What each provider's usage fields mean</p>
                  <p className="text-xs text-muted">Providers report different fields and they are not equivalent. Token groups that are inside another count are not added twice.</p>
                  <ul className="mt-2 space-y-2 text-xs text-dim">
                    {q.data.providers.map((p) => (
                      <li key={`${p.provider}-${p.usage_shape}`}><span className="font-medium text-ink">{p.provider ?? "provider not named"} · {p.usage_shape ?? "layout not recorded"}</span> ({count(p.runs)} calls)
                        {Object.keys(p.field_notes).length > 0 ? <ul className="ml-4 list-disc">{Object.entries(p.field_notes).map(([k, v]) => <li key={k}>{k}: {v}</li>)}</ul> : <span> – no field notes for this layout</span>}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </Panel>
          </Reveal>

          <Reveal delay={0.1}>
            <Panel className="p-5 md:p-6" id="limits">
              <PanelHeader title="What this cannot measure" hint="Said plainly, so a tidy-looking page is never mistaken for a complete one." />
              <ul className="mt-3 list-disc space-y-1 pl-5 text-sm text-dim" data-testid="cannot-measure">{q.data.cannot_measure.map((t) => <li key={t}>{t}</li>)}</ul>
              <ul className="mt-3 list-disc space-y-0.5 pl-5 text-xs text-muted">{q.data.notes.map((t) => <li key={t}>{t}</li>)}</ul>
            </Panel>
          </Reveal>
        </>
      )}
    </div>
  );
}
