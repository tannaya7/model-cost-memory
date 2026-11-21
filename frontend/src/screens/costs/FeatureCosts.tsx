/** "Cost by your own feature labels": what each feature or workflow the customer's app named in its calls cost, how often it ran, and how
 *  often its answers passed. The labels are the customer's own words, sent by their app, and nothing here verifies them: not an identity, not
 *  a chargeback record. Unlabelled calls are shown as their own row. Analysis only: nothing is written into the customer's code. */
import { useFeatureBreakdown, type FeatureRow } from "../../features/insights/api/featuresApi";
import { count, pct, usd } from "../../ui/format";
import { EmptyState, ErrorState, Pill, Skeleton } from "../../ui/primitives";

const SNIPPET_PY = `recorder.record(prompt=prompt, response=response, feature="support_summary")`;
const SNIPPET_JS = `recorder.record({ prompt, response, feature: "support_summary" })`;

function Success({ row }: { row: FeatureRow }) {
  const c = row.cost_per_success;
  if (c.value_usd === null) {
    return <span className="text-xs text-muted" title={c.reason ?? undefined}>Not enough data{c.reason ? `: ${c.reason}` : ""}</span>;
  }
  return (
    <span className="tabular" title={`${usd(c.spend_usd)} of checked, priced calls ÷ ${count(c.passed)} passes. Calls left out: ${count(c.unchecked_runs)} unchecked, ${count(c.checked_unpriced_runs)} unpriced.`}>
      {usd(c.value_usd)}
    </span>
  );
}

export function FeatureCostsBody({ days }: { days: number }) {
  const q = useFeatureBreakdown(days);
  if (q.isPending) return <Skeleton className="h-40" />;
  if (q.isError) return <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  const d = q.data;
  if (d.total_runs === 0) {
    return <EmptyState title="No calls in this period" hint="When your app has sent calls, each feature you label appears here with its cost. Nothing is shown until there is data." />;
  }
  return (
    <div className="flex flex-col gap-4" data-testid="feature-costs">
      <p className="text-sm text-dim" data-testid="labelled-share">
        {d.labelled_runs === 0
          ? `None of the ${count(d.total_runs)} calls in this period carried a feature label.`
          : `${pct(d.labelled_share ?? 0, 0)} of the ${count(d.total_runs)} calls carried a feature label.`}
        {" "}Labels are your own app's words. They are not verified and not a chargeback record.
      </p>
      {d.labelled_runs === 0 && (
        <div className="rounded-[12px] border border-rule bg-surface-2/50 p-3.5 text-sm text-dim" data-testid="how-to-label">
          <p className="font-semibold text-ink">Want a cost per feature?</p>
          <p className="mt-1">Your app can name each call's feature or workflow. It is optional, and you choose whether to add it. We never change your code.</p>
          <pre className="mt-2 overflow-x-auto rounded-[8px] bg-bg p-2 text-xs text-ink">{SNIPPET_PY}</pre>
          <pre className="mt-1 overflow-x-auto rounded-[8px] bg-bg p-2 text-xs text-ink">{SNIPPET_JS}</pre>
        </div>
      )}
      <div className="overflow-x-auto" role="group" aria-label="Cost by feature label" tabIndex={0}>
        <table className="w-full min-w-[44rem] text-left text-sm">
          <caption className="sr-only">Calls, tokens, list-price cost and checked answers for each feature label, over the last {d.period_days} days</caption>
          <thead>
            <tr className="text-xs text-muted">
              <th scope="col" className="py-1 font-medium">Feature</th>
              <th scope="col" className="text-right font-medium">Calls</th>
              <th scope="col" className="text-right font-medium">Tokens</th>
              <th scope="col" className="text-right font-medium">Cost (list price)</th>
              <th scope="col" className="text-right font-medium">Share</th>
              <th scope="col" className="text-right font-medium">Passed / failed / not checked</th>
              <th scope="col" className="text-right font-medium">Cost per correct answer</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-rule">
            {d.rows.map((r) => (
              <tr key={`${r.feature ?? r.label}`} data-testid="feature-row">
                <th scope="row" className="py-2 text-left font-normal">
                  <span className="font-medium text-ink [overflow-wrap:anywhere]">{r.label}</span>
                  {r.feature !== null && <span className="ml-2"><Pill tone="neutral" icon={false}>your label</Pill></span>}
                  {r.folded_labels ? <span className="ml-2 text-xs text-muted">{count(r.folded_labels)} smaller labels added together</span> : null}
                </th>
                <td className="tabular text-right">{count(r.runs)}</td>
                <td className="tabular text-right">
                  {count(r.tokens)}
                  {r.no_usage_runs > 0 && <span className="block text-[11px] text-muted">unknown for {count(r.no_usage_runs)} calls</span>}
                </td>
                <td className="tabular text-right">
                  {usd(r.spend_usd)}
                  {r.unpriced_runs > 0 && <span className="block text-[11px] text-muted">{count(r.unpriced_runs)} unpriced, left out</span>}
                </td>
                <td className="tabular text-right">{r.share_of_spend === null ? "n/a" : pct(r.share_of_spend, 0)}</td>
                <td className="tabular text-right">{count(r.passed)} / {count(r.failed)} / {count(r.unchecked)}</td>
                <td className="text-right"><Success row={r} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {d.truncated && <p className="text-xs text-muted" role="note">Your app sent more distinct labels than we read. The smallest are not in any row.</p>}
      <ul className="list-disc space-y-0.5 pl-5 text-xs text-muted" data-testid="feature-notes">{d.notes.map((n) => <li key={n}>{n}</li>)}</ul>
    </div>
  );
}
