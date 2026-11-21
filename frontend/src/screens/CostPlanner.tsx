/** Cost planner: what one task might cost at traffic levels the user types, worked out from that task's own recorded calls.
 *  A scenario calculator, never a forecast: it reads our own server, calls no provider, changes nothing, and keeps the user's assumptions apart
 *  from measured history. Unknown and unpriced calls stay visible; with too little data it says so instead of showing a number. */
import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { canAdminister, useMyRole } from "../app/useMyRole";
import { useProject } from "../app/project";
import { ExportButton } from "../features/exports/ExportButton";
import { useJobs } from "../features/jobs/hooks/useJobs";
import { plannerQuery, usePlanner, type ModelPlan, type PlannerInput } from "../features/insights/api/plannerApi";
import { count, pct, shortDate, usd } from "../ui/format";
import { EmptyState, ErrorState, Panel, PanelHeader, Pill, Reveal, Segmented, Skeleton } from "../ui/primitives";

const DAYS = [7, 30, 90] as const;
const field = "rounded-[8px] border border-rule bg-surface px-2.5 py-1.5 text-sm text-ink";
const DEFAULT_CALLS = ["1000", "10000", "100000"];

interface Draft {
  job: string;
  days: string;
  calls: string[];
  retry: string;
  input: string;
  output: string;
  farOut: boolean;
  period: "day" | "week" | "month";
}

/** The assumptions as link parameters. Only what the person typed: no numbers from their data ever go into a link. */
export function draftToParams(d: Draft): Record<string, string> {
  const out: Record<string, string> = { task: d.job, days: d.days, period: d.period };
  const calls = d.calls.map((c) => c.trim()).filter(Boolean);
  if (calls.length) out.tasks = calls.join(",");
  if (d.retry.trim()) out.retry = d.retry.trim();
  if (d.input.trim()) out.input = d.input.trim();
  if (d.output.trim()) out.output = d.output.trim();
  if (d.farOut) out.farout = "1";
  return out;
}

/** The reverse, forgiving: anything unknown falls back to the default. Whatever comes back is checked again by parseDraft and by the server. */
export function draftFromParams(sp: URLSearchParams): Draft | null {
  const job = sp.get("task");
  if (!job) return null;
  const tasks = (sp.get("tasks") ?? "").split(",").map((c) => c.trim()).slice(0, 3);
  const period = sp.get("period");
  const days = sp.get("days");
  return {
    job,
    days: days && (DAYS as readonly number[]).includes(Number(days)) ? days : "30",
    calls: [0, 1, 2].map((i) => tasks[i] ?? ""),
    retry: sp.get("retry") ?? "",
    input: sp.get("input") ?? "",
    output: sp.get("output") ?? "",
    farOut: sp.get("farout") === "1",
    period: period === "day" || period === "week" ? period : "month",
  };
}

/** The typed assumptions as a request, or the first thing wrong with them in words. Mirrors the server's limits; the server checks again. */
export function parseDraft(d: Draft): { input: PlannerInput } | { error: string } {
  if (!d.job) return { error: "Choose a task first." };
  const calls = d.calls.filter((c) => c.trim() !== "").map(Number);
  if (calls.length === 0) return { error: "Enter at least one number of tasks." };
  if (calls.some((c) => !Number.isInteger(c) || c < 1 || c > 1_000_000_000)) return { error: "Tasks per period must be whole numbers from 1 to 1,000,000,000." };
  const retry = Number(d.retry === "" ? "0" : d.retry);
  if (!Number.isFinite(retry) || retry < 0 || retry > 1000) return { error: "Retry rate must be a percentage from 0 to 1000." };
  const input = Number(d.input === "" ? "0" : d.input);
  const output = Number(d.output === "" ? "0" : d.output);
  if (![input, output].every((n) => Number.isFinite(n) && n >= -90 && n <= 1000)) return { error: "Size changes must be percentages from −90 to 1000." };
  return {
    input: { job: d.job, days: Number(d.days), calls, retryRate: retry / 100, inputChangePct: input, outputChangePct: output, excludeFarOut: d.farOut, period: d.period },
  };
}

function Range({ s }: { s: ModelPlan["scenarios"][number] }) {
  if (s.estimate_usd === null) return <span className="text-muted">Not enough comparable data</span>;
  return (
    <span className="tabular">
      <span className="font-semibold text-ink">{usd(s.estimate_usd)}</span>
      {s.low_usd !== null && s.high_usd !== null ? (
        <span className="block text-xs text-dim">likely between {usd(s.low_usd)} and {usd(s.high_usd)}</span>
      ) : (
        <span className="block text-xs text-muted">{s.range_note}</span>
      )}
    </span>
  );
}

function ModelCard({ m, period, farOut }: { m: ModelPlan; period: string; farOut: boolean }) {
  const c = m.cost_per_success;
  const leftOut = Object.entries(m.left_out);
  return (
    <article className="rounded-[14px] border border-rule p-4" aria-label={`Scenarios for ${m.model}`} data-testid="planner-model">
      <header className="flex flex-wrap items-center gap-2">
        <h3 className="text-lg font-semibold text-ink [overflow-wrap:anywhere]">{m.model}</h3>
        {m.provider && <Pill tone="neutral" icon={false}>{m.provider}</Pill>}
        <Pill tone={m.status === "ESTIMATE" ? "good" : m.status === "ESTIMATE_NO_RANGE" ? "warn" : "neutral"}>{m.status === "NOT_ENOUGH_DATA" ? "Not enough comparable data" : m.status === "ESTIMATE" ? "Estimate with range" : "Estimate, no range"}</Pill>
      </header>
      <p className="mt-1 text-sm text-dim" data-testid="planner-status">{m.status_text}</p>

      <div className="mt-3 overflow-x-auto" role="group" aria-label={`Scenario costs for ${m.model}`} tabIndex={0}>
        <table className="w-full min-w-[30rem] text-left text-sm">
          <caption className="sr-only">Estimated cost per {period} for {m.model} at each number of tasks you entered. List-price estimates from your recorded calls, not an invoice.</caption>
          <thead>
            <tr className="text-xs text-muted">
              <th scope="col" className="py-1 font-medium">Tasks per {period} (you entered)</th>
              <th scope="col" className="text-right font-medium">Attempts</th>
              <th scope="col" className="text-right font-medium">Estimated cost per {period}</th>
              <th scope="col" className="text-right font-medium">Per task</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-rule">
            {m.scenarios.map((s) => (
              <tr key={s.tasks_per_period} data-testid="planner-scenario">
                <th scope="row" className="py-2 text-left font-normal tabular">{count(s.tasks_per_period)}</th>
                <td className="tabular text-right">{count(Math.round(s.attempts))}</td>
                <td className="text-right"><Range s={s} /></td>
                <td className="tabular text-right">{s.per_task_usd === null ? "–" : usd(s.per_task_usd)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <dl className="mt-3 grid gap-x-6 gap-y-1 text-xs text-dim sm:grid-cols-2">
        <div><dt className="inline font-medium text-ink">Measured from your history: </dt><dd className="inline">{count(m.observed_calls)} calls, {count(m.used_calls)} used for the estimate{m.first_call && m.last_call ? `, ${shortDate(m.first_call)} to ${shortDate(m.last_call)}` : ""}</dd></div>
        <div><dt className="inline font-medium text-ink">What drives it: </dt><dd className="inline">an average call costs {usd(m.mean_call_usd)} ({usd(m.mean_input_side_usd)} for input, {usd(m.mean_output_side_usd)} for output); about {count(Math.round(m.mean_tokens_in ?? 0))} tokens in and {count(Math.round(m.mean_tokens_out ?? 0))} out</dd></div>
        <div><dt className="inline font-medium text-ink">Call sizes: </dt><dd className="inline">typical {usd(m.median_call_usd)}, 1 in 10 above {usd(m.p90_call_usd)}, largest {usd(m.max_call_usd)}</dd></div>
        <div><dt className="inline font-medium text-ink">Prices used: </dt><dd className="inline">{m.versions_used.length === 0 ? "none (no usable priced call)" : m.versions_used.map((v) => `list price in force from ${shortDate(v.effective_from)} (${count(v.runs)} calls)`).join("; ")}</dd></div>
      </dl>
      {m.uneven && <p className="mt-2 text-xs text-warn" role="note">Call sizes here are very uneven, so the real spread may be wider than the range shown.</p>}
      {farOut && m.filtered_out > 0 && (
        <p className="mt-2 text-xs text-dim" role="note" data-testid="filter-effect">Filter on: {count(m.filtered_out)} far-out call(s) left out. The average call is {usd(m.mean_call_usd)} with the filter and {usd(m.mean_call_unfiltered_usd)} without it.</p>
      )}
      {leftOut.length > 0 && (
        <div className="mt-3 text-xs text-dim" data-testid="left-out">
          <p className="font-medium text-ink">Some usage is unpriced or left out of this estimate ({count(leftOut.reduce((a, [, n]) => a + n, 0))} calls). They are never counted as free:</p>
          <ul className="mt-1 list-disc space-y-0.5 pl-5">{leftOut.map(([why, n]) => <li key={why}>{count(n)}: {why}</li>)}</ul>
        </div>
      )}
      {m.flagged_included > 0 && <p className="mt-2 text-xs text-muted">{count(m.flagged_included)} used call(s) carry a doubtful-total flag; see Data coverage.</p>}

      <div className="mt-3 rounded-[10px] bg-surface-2/50 p-3 text-xs text-dim" data-testid="planner-quality">
        <p className="font-medium text-ink">Quality beside cost</p>
        <p className="mt-0.5">Passed {count(m.passed)}, failed {count(m.failed)}, not checked {count(m.unchecked)}, left out of the estimate {count(m.excluded)}.</p>
        {c.value_usd === null ? (
          <p>Cost per correct answer: not enough data{c.reason ? `. ${c.reason}` : ""}</p>
        ) : (
          <p>Cost per correct answer (checked calls only): {usd(c.value_usd)} = {usd(c.spend_usd)} over {count(c.passed)} passes among {count(c.checked_priced_runs)} priced, checked calls.</p>
        )}
      </div>
    </article>
  );
}

export default function CostPlanner() {
  const taskList = useJobs();
  const [params, setParams] = useSearchParams();
  const fromLink = draftFromParams(params);
  const startDraft: Draft = fromLink ?? { job: "", days: "30", calls: DEFAULT_CALLS, retry: "", input: "", output: "", farOut: false, period: "month" };
  const [draft, setDraft] = useState<Draft>(startDraft);
  const startApplied = fromLink ? parseDraft(fromLink) : null;
  const [applied, setApplied] = useState<PlannerInput | null>(startApplied && "input" in startApplied ? startApplied.input : null);
  const [error, setError] = useState<string | null>(startApplied && "error" in startApplied ? startApplied.error : null);
  const [copied, setCopied] = useState<"idle" | "done" | "failed">("idle");
  const { mode: scope } = useProject();
  const role = useMyRole();
  // The server decides who may download; the button is only left out for people it would refuse.
  const canExport = scope === "owned" && canAdminister(role);
  useEffect(() => {
    if (copied === "idle") return undefined;
    const t = window.setTimeout(() => setCopied("idle"), 4000);
    return () => window.clearTimeout(t);
  }, [copied]);
  const q = usePlanner(applied);
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setDraft((d) => ({ ...d, [k]: v }));
  const names = taskList.data?.map((j) => j.name) ?? [];
  const chosen = draft.job || names[0] || "";

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const r = parseDraft({ ...draft, job: chosen });
    if ("error" in r) { setError(r.error); return; }
    setError(null);
    setApplied(r.input);
    setParams(draftToParams({ ...draft, job: chosen }), { replace: true });
  }

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(window.location.href);
      setCopied("done");
    } catch {
      setCopied("failed");
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-3xl font-semibold tracking-tight">Cost planner</h1>
        <p className="mt-1 max-w-2xl text-sm text-dim">
          Try numbers and see what a task might cost, using that task's own recorded calls. It is a calculator, not a forecast: nothing is sent to a provider and nothing is changed in your app.
        </p>
      </div>

      <Reveal>
        <Panel className="p-5 md:p-6">
          <PanelHeader title="Your assumptions" hint="Everything here is typed by you. We never guess your future traffic." />
          {taskList.isPending ? <Skeleton className="mt-4 h-32" /> : taskList.isError ? <div className="mt-4"><ErrorState error={taskList.error} onRetry={() => void taskList.refetch()} /></div> : names.length === 0 ? (
            <div className="mt-4"><EmptyState title="No tasks yet" hint="Once your app has recorded calls for a task, you can plan its cost here." /></div>
          ) : (
            <form onSubmit={submit} className="mt-4 flex flex-col gap-4" aria-label="Scenario assumptions" noValidate>
              <div className="flex flex-wrap items-end gap-4">
                <label className="flex flex-col gap-1 text-xs text-dim" htmlFor="plan-task">Task
                  <select id="plan-task" className={field} value={chosen} onChange={(e) => set("job", e.target.value)}>{names.map((n) => <option key={n} value={n}>{n}</option>)}</select>
                </label>
                <label className="flex flex-col gap-1 text-xs text-dim" htmlFor="plan-period">Count tasks per
                  <select id="plan-period" className={field} value={draft.period} onChange={(e) => set("period", e.target.value as Draft["period"])}><option value="day">day</option><option value="week">week</option><option value="month">month</option></select>
                </label>
                <Segmented label="History to use" value={draft.days} options={DAYS.map((d) => ({ value: String(d), label: `${d} days` }))} onChange={(v) => set("days", v)} />
              </div>
              <fieldset className="flex flex-wrap items-end gap-3">
                <legend className="mb-1 text-xs text-dim">Tasks per {draft.period} to price (up to three scenarios, for example 1×, 10×, 100×)</legend>
                {draft.calls.map((c, i) => (
                  <label key={i} className="flex flex-col gap-1 text-xs text-dim" htmlFor={`plan-calls-${i}`}>Scenario {i + 1}
                    <input id={`plan-calls-${i}`} inputMode="numeric" className={`${field} w-32 tabular`} value={c} onChange={(e) => set("calls", draft.calls.map((x, j) => (j === i ? e.target.value : x)))} />
                  </label>
                ))}
              </fieldset>
              <div className="flex flex-wrap items-end gap-4">
                <label className="flex flex-col gap-1 text-xs text-dim" htmlFor="plan-retry">Retries: extra attempts per 100 tasks (%)
                  <input id="plan-retry" inputMode="decimal" placeholder="0" className={`${field} w-28 tabular`} value={draft.retry} onChange={(e) => set("retry", e.target.value)} />
                </label>
                <label className="flex flex-col gap-1 text-xs text-dim" htmlFor="plan-in">Input size change (%)
                  <input id="plan-in" inputMode="decimal" placeholder="0" className={`${field} w-28 tabular`} value={draft.input} onChange={(e) => set("input", e.target.value)} />
                </label>
                <label className="flex flex-col gap-1 text-xs text-dim" htmlFor="plan-out">Output size change (%)
                  <input id="plan-out" inputMode="decimal" placeholder="0" className={`${field} w-28 tabular`} value={draft.output} onChange={(e) => set("output", e.target.value)} />
                </label>
                <label className="flex items-center gap-2 text-xs text-dim" htmlFor="plan-farout">
                  <input id="plan-farout" type="checkbox" checked={draft.farOut} onChange={(e) => set("farOut", e.target.checked)} />
                  Leave out far-out calls (you can turn this off again)
                </label>
                <button type="submit" className="rounded-[10px] bg-ink px-4 py-2 text-sm font-semibold text-bg">Calculate</button>
              </div>
              {error && <p className="text-sm text-bad" role="alert" data-testid="planner-error">{error}</p>}
            </form>
          )}
        </Panel>
      </Reveal>

      {applied && (
        <Reveal delay={0.05}>
          <Panel className="p-5 md:p-6" aria-live="polite">
            <PanelHeader
              title={`Scenarios for “${applied.job}”`}
              hint="Measured history and your assumptions are shown apart. List-price estimates, not an invoice."
              actions={
                <div className="flex flex-wrap items-start justify-end gap-3">
                  <div className="flex flex-col items-end gap-1.5">
                    <button type="button" onClick={() => void copyLink()} className="rounded-[10px] border border-rule bg-surface px-3 py-2 text-sm font-medium text-ink hover:bg-surface-2">Copy link to this scenario</button>
                    <p role="status" aria-live="polite" className="max-w-xs text-right text-xs text-dim" data-testid="copy-note">
                      {copied === "done" ? "Link copied. It holds only the numbers you typed. Whoever opens it sees their own recorded calls and prices." : copied === "failed" ? "Could not copy. Copy the address from your browser instead." : ""}
                    </p>
                  </div>
                  {canExport && (
                    <ExportButton path={`/v1/insights/planner/export.csv?${plannerQuery(applied)}`} what={`the “${applied.job}” scenarios`} title="Download these scenarios as a spreadsheet file (CSV)">Download scenarios (CSV)</ExportButton>
                  )}
                </div>
              }
            />
            <div className="mt-4 flex flex-col gap-4">
              {q.isPending ? <Skeleton className="h-48" /> : q.isError ? <ErrorState error={q.error} onRetry={() => void q.refetch()} /> : q.data.models.length === 0 ? (
                <EmptyState title="No recorded calls for this task in this period" hint="Pick a longer history or another task. Nothing is made up to fill the gap." />
              ) : (
                <>
                  <section aria-label="Assumptions used" data-testid="planner-assumptions">
                    <h3 className="text-sm font-semibold text-ink">Assumptions used</h3>
                    <ul className="mt-1 grid gap-x-6 gap-y-0.5 text-xs text-dim sm:grid-cols-2">
                      {q.data.assumptions.map((a) => <li key={a.name}><span className="font-medium text-ink">{a.name}:</span> {a.value} <Pill tone="neutral" icon={false}>{a.source}</Pill></li>)}
                    </ul>
                    <p className="mt-2 text-xs text-dim">
                      {q.data.observed_retry_rate === null ? "Measured retry rate: unknown (your app sends no task ids, so retries cannot be told from separate tasks)." : `Measured from your task ids: ${pct(q.data.observed_retry_rate, 0)} extra attempts per task. Enter your own number above if you expect something different.`}
                    </p>
                    <p className="mt-1 text-xs text-dim">What counts as correct: {q.data.success_definition}.</p>
                  </section>
                  {q.data.models.map((m) => <ModelCard key={`${m.model}-${m.provider ?? ""}`} m={m} period={q.data.period_label} farOut={applied.excludeFarOut} />)}
                  {q.data.not_tested.length > 0 && (
                    <div className="rounded-[12px] border border-rule p-3.5 text-sm" data-testid="not-tested">
                      <p className="font-semibold text-ink">Not tested on this workload</p>
                      <p className="mt-1 text-dim">Used elsewhere in this project but never on this task, so no cost or quality is shown for them: {q.data.not_tested.join(", ")}.</p>
                    </div>
                  )}
                  <ul className="list-disc space-y-0.5 pl-5 text-xs text-muted">{q.data.notes.map((n) => <li key={n}>{n}</li>)}</ul>
                  <p className="rounded-[10px] bg-surface-2/60 p-3 text-xs text-dim" role="note" data-testid="planner-disclaimer">{q.data.disclaimer}</p>
                </>
              )}
            </div>
          </Panel>
        </Reveal>
      )}
    </div>
  );
}
