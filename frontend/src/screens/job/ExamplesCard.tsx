/** What a task looks like in practice (last 30 days): counted facts plus up to three real example calls. */
import { tokensAre } from "../../features/projects/moneyWording";
import { useBillingMode } from "../../features/projects/hooks/useBillingMode";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { useDaily } from "../../features/insights/api/dailyApi";
import { pickPassExamples, summaryLines } from "../../features/runs/sample";
import { fetchRuns } from "../../features/runs/api/runsApi";
import { RunDetailPanel } from "../../features/runs/components/RunDetailPanel";
import type { Run } from "../../shared/api/types";
import { ErrorState, ModelName, Panel, PanelHeader, Pill, Skeleton } from "../../ui/primitives";

const REMOVED = "The text of this call was removed after your retention period (see Settings). Only the numbers are kept.";

function Example({ title, run, onOpen }: { title: string; run: Run; onOpen: (id: string) => void }) {
  const removed = run.prompt_preview == null && run.output_preview == null;
  return (
    <li>
      <p className="mb-1.5 text-[13px] font-semibold text-ink">{title}</p>
      <button
        type="button"
        onClick={() => onOpen(run.run_id)}
        className="w-full rounded-[12px] border border-rule bg-surface-2/40 p-4 text-left transition-colors hover:border-rule-strong focus:border-accent focus:outline-none"
      >
        <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted">
          <span className="flex items-center gap-2">
            <ModelName className="text-xs">{run.model}</ModelName>
            <Pill tone={run.outcome === "PASS" ? "good" : run.outcome === "FAIL" ? "bad" : "neutral"}>
              {run.outcome === "PASS" ? "Correct" : run.outcome === "FAIL" ? "Wrong" : "Not checked yet"}
            </Pill>
          </span>
          <span>{new Date(run.created_at).toLocaleDateString("en", { day: "numeric", month: "short", timeZone: "UTC" })}</span>
        </div>
        {removed ? (
          <p className="mt-3 text-sm text-dim">{REMOVED}</p>
        ) : (
          <dl className="mt-3 grid gap-2 text-sm">
            <div>
              <dt className="text-[11px] font-semibold uppercase tracking-wider text-muted">You asked:</dt>
              <dd className="line-clamp-2 break-words text-ink">{run.prompt_preview ?? REMOVED}</dd>
            </div>
            <div>
              <dt className="text-[11px] font-semibold uppercase tracking-wider text-muted">The AI answered:</dt>
              <dd className="line-clamp-2 break-words text-dim">{run.output_preview ?? REMOVED}</dd>
            </div>
          </dl>
        )}
        {run.outcome === "FAIL" && run.outcome_reason && <p className="mt-2 text-xs text-dim">Why it was marked wrong: {run.outcome_reason}</p>}
      </button>
    </li>
  );
}

export function ExamplesCard({ job }: { job: string }) {
  const { mode: billing } = useBillingMode();
  const [open, setOpen] = useState<string | null>(null);
  const daily = useDaily({ job, days: 30 });
  const pass = useQuery({ queryKey: ["runs", "practice", job, "PASS"], queryFn: () => fetchRuns({ job, outcome: "PASS", limit: 20 }) });
  const fail = useQuery({ queryKey: ["runs", "practice", job, "FAIL"], queryFn: () => fetchRuns({ job, outcome: "FAIL", limit: 1 }) });

  const passItems = useMemo(() => pass.data?.items ?? [], [pass.data]);
  const failItem = fail.data?.items[0] ?? null;
  const { typical, different } = useMemo(() => pickPassExamples(passItems), [passItems]);
  const pending = pass.isPending || fail.isPending || daily.isPending;
  const error = pass.error ?? fail.error;

  const points = daily.data ?? [];
  const calls = points.reduce((a, d) => a + d.runs, 0);
  const tokensIn = points.reduce((a, d) => a + d.tokens_in, 0);
  const lines = summaryLines({ calls, tokensIn, previews: [...passItems, ...(failItem ? [failItem] : [])].map((r) => r.prompt_preview) });
  const nothingChecked = passItems.length === 0 && !failItem;

  return (
    <Panel className="p-5 md:p-6">
      <PanelHeader title="What this task looks like in practice" hint="The last 30 days" />
      <div className="mt-4">
        {pending ? (
          <Skeleton className="h-40" />
        ) : error ? (
          <ErrorState
            error={error}
            onRetry={() => {
              pass.refetch();
              fail.refetch();
            }}
          />
        ) : (
          <>
            <div className="space-y-1.5 text-sm text-dim">
              <p className="text-ink">{lines.sent}</p>
              {lines.typical && <p>{lines.typical}</p>}
              {lines.tokens && (
                <details className="text-xs text-muted">
                  <summary className="cursor-pointer">What are tokens?</summary>
                  <p className="mt-1">{tokensAre(billing)} Longer prompts and answers use more tokens.</p>
                </details>
              )}
              <p>
                A call lands in this task because your code names it <span className="rounded-md border border-rule bg-surface-2 px-1.5 py-0.5 font-mono text-xs">{job}</span> when it sends the call. We do not guess from the content.
              </p>
            </div>
            <ul className="mt-5 flex flex-col gap-4">
              {typical && <Example title="A typical call (marked correct)" run={typical} onOpen={setOpen} />}
              {different && <Example title="A different kind of call (marked correct)" run={different} onOpen={setOpen} />}
              {failItem && <Example title="A call marked wrong" run={failItem} onOpen={setOpen} />}
            </ul>
            {!failItem && !nothingChecked && <p className="mt-4 text-sm text-dim">No call has been marked wrong yet.</p>}
            {nothingChecked && (
              <p className="mt-4 text-sm text-dim">
                Answers are not checked yet, so we cannot show a correct or a wrong call. See "How we decide an answer is correct" in the What this task is box above.
              </p>
            )}
          </>
        )}
      </div>
      <p className="mt-4 text-xs text-muted">This text comes from your own calls and is visible only to people with access to this project.</p>
      <RunDetailPanel runId={open} onClose={() => setOpen(null)} />
    </Panel>
  );
}
