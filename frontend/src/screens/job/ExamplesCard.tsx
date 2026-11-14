/** A spread of this month's AI calls for a task: what was asked and what the AI answered. */
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useDaily } from "../../features/insights/api/dailyApi";
import { pickMonthlySample } from "../../features/runs/sample";
import { fetchRuns } from "../../features/runs/api/runsApi";
import { RunDetailPanel } from "../../features/runs/components/RunDetailPanel";

import { EmptyState, ErrorState, ModelName, Panel, PanelHeader, Pill, Skeleton } from "../../ui/primitives";

const REMOVED = "The text of this call was removed after your retention period (see Settings). Only the numbers are kept.";

export function ExamplesCard({ job }: { job: string }) {
  const [open, setOpen] = useState<string | null>(null);
  const q = useQuery({ queryKey: ["runs", "examples", job], queryFn: () => fetchRuns({ job, limit: 50 }) });
  const items = pickMonthlySample(q.data?.items ?? []);
  const daily = useDaily({ job, days: 31 });
  const month = new Date().toISOString().slice(0, 7);
  const sent = daily.data ? daily.data.filter((d) => d.day.startsWith(month)).reduce((a, d) => a + d.runs, 0) : null;
  const total = sent ?? items.length;

  return (
    <Panel className="p-5 md:p-6">
      <PanelHeader title="This month's examples" hint={items.length ? `This month you sent ${total.toLocaleString("en")} AI calls to this task. Here are ${items.length} of them.` : "What you asked and what the AI answered"} />
      <div className="mt-4">
        {q.isPending ? (
          <Skeleton className="h-40" />
        ) : q.isError ? (
          <ErrorState error={q.error} onRetry={() => q.refetch()} />
        ) : items.length === 0 ? (
          <EmptyState title="No AI calls this month yet" hint="Once your code sends a call for this task, a few examples show up here." />
        ) : (
          <ul className="flex flex-col gap-3">
            {items.map((r) => {
              const removed = r.prompt_preview == null && r.output_preview == null;
              return (
                <li key={r.run_id}>
                  <button
                    type="button"
                    onClick={() => setOpen(r.run_id)}
                    className="w-full rounded-[12px] border border-rule bg-surface-2/40 p-4 text-left transition-colors hover:border-rule-strong focus:border-accent focus:outline-none"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted">
                      <span className="flex items-center gap-2">
                        <ModelName className="text-xs">{r.model}</ModelName>
                        <Pill tone={r.outcome === "PASS" ? "good" : r.outcome === "FAIL" ? "bad" : "neutral"}>
                          {r.outcome === "PASS" ? "Correct" : r.outcome === "FAIL" ? "Wrong" : "Not checked yet"}
                        </Pill>
                      </span>
                      <span>{new Date(r.created_at).toLocaleDateString("en", { day: "numeric", month: "short", timeZone: "UTC" })}</span>
                    </div>
                    {removed ? (
                      <p className="mt-3 text-sm text-dim">{REMOVED}</p>
                    ) : (
                      <dl className="mt-3 grid gap-2 text-sm">
                        <div>
                          <dt className="text-[11px] font-semibold uppercase tracking-wider text-muted">You asked</dt>
                          <dd className="line-clamp-3 break-words text-ink">{r.prompt_preview ?? REMOVED}</dd>
                        </div>
                        <div>
                          <dt className="text-[11px] font-semibold uppercase tracking-wider text-muted">The AI answered</dt>
                          <dd className="line-clamp-3 break-words text-dim">{r.output_preview ?? REMOVED}</dd>
                        </div>
                      </dl>
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
      <p className="mt-4 text-xs text-muted">This text comes from your own AI calls and is visible only to people with access to this project.</p>
      <RunDetailPanel runId={open} onClose={() => setOpen(null)} />
    </Panel>
  );
}
