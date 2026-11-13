/** The job's other views: quality over time, spend, evidence, runs, history and re-tests. */
import { useP } from "../../app/project";
import { useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { AlertItemCard } from "../../features/alerts/components/AlertItemCard";
import { useDaily } from "../../features/insights/api/dailyApi";
import { useJobInsights } from "../../features/insights/hooks/useSpendInsights";
import { RelatedNews } from "../../features/news/components/RelatedNews";
import { JobHistoryTimeline } from "../../features/recommendations/components/JobHistoryTimeline";
import { useJobHistory } from "../../features/recommendations/hooks/useJobHistory";
import { useJobRegressions } from "../../features/recommendations/hooks/useJobRegressions";
import { RetestProgress } from "../../features/retest/components/RetestProgress";
import { useJobRetests } from "../../features/retest/hooks/useRetest";
import { RunDetailPanel } from "../../features/runs/components/RunDetailPanel";
import { useRuns } from "../../features/runs/hooks/useRuns";
import type { Alert, Breakdown, Recommendation } from "../../shared/api/types";
import { ChartFrame } from "../../ui/charts/ChartFrame";
import { GroupBars, QualityLines, SpendArea, type Marker } from "../../ui/charts/charts";
import { pivot, rollingPassRate, total } from "../../ui/charts/data";
import { colorMap } from "../../ui/charts/series";
import { pct, timeAgo, usd } from "../../ui/format";
import { IconCheck, IconFlask, IconShield } from "../../ui/icons";
import { Button, ButtonLink, EmptyState, ErrorState, ModelName, Panel, PanelHeader, Pill, Segmented, Skeleton } from "../../ui/primitives";

export function QualityTab({ job, rec }: { job: string; rec: Recommendation | null }) {
  const daily = useDaily({ days: 90, job });
  const alerts = useJobRegressions(job);
  const history = useJobHistory(job);
  const points = daily.data ?? [];
  const { rows, names } = useMemo(() => rollingPassRate(points, { days: 90 }), [points]);
  const colors = colorMap(names.concat(rec?.models.map((m) => m.model) ?? []));
  const markers: Marker[] = [
    ...(alerts.data ?? [])
      .filter((a: Alert) => a.kind !== "MODEL_DEPRECATED")
      .map((a: Alert) => ({ day: a.created_at.slice(0, 10), label: a.kind === "SILENT_DROP" ? "silent drop" : "regression", tone: "bad" as const })),
    ...(history.data?.versions ?? [])
      .filter((v) => Date.parse(v.first_seen) > Date.now() - 90 * 86_400_000)
      .map((v) => ({ day: v.first_seen.slice(0, 10), label: `new ${v.model} version`, tone: "info" as const })),
  ].filter((m) => rows.some((r) => r.day === m.day));
  const reference = rec?.models.find((m) => m.model === rec.reference);
  const floor = reference?.weighted_pass_rate != null && rec ? reference.weighted_pass_rate - rec.rules.margin : undefined;
  const open = (alerts.data ?? []).filter((a: Alert) => a.resolved_at === null);

  return (
    <div className="flex flex-col gap-4">
      <Panel className="p-5 md:p-6">
        {daily.isPending ? (
          <Skeleton className="h-72" />
        ) : names.length === 0 ? (
          <EmptyState title="No checked runs in the last 90 days" hint="Pass rates appear once runs on this job have been checked." />
        ) : (
          <ChartFrame
            title="Is it still working? Pass rate over time"
            hint="Each line is a model's pass rate over the previous 7 days. Red lines mark quality drops the system caught; violet lines mark new model versions."
            legend={names.map((n) => ({ name: n, color: colors.get(n)! }))}
            table={{
              columns: ["Day", ...names],
              rows: rows.filter((r) => names.some((n) => r[n] !== null)).map((r) => [r.day, ...names.map((n) => (r[n] === null ? "–" : pct(r[n] as number)))]),
            }}
          >
            <QualityLines rows={rows} names={names} colors={colors} markers={markers} floor={floor} />
          </ChartFrame>
        )}
      </Panel>

      <div className="grid gap-4 lg:grid-cols-3">
        <Panel className="p-5 lg:col-span-2">
          <PanelHeader title="Quality alerts" hint="A version change that made answers worse, or a silent drop under the same name" />
          <div className="mt-4 flex flex-col gap-3">
            {alerts.isPending ? (
              <Skeleton className="h-24" />
            ) : (alerts.data ?? []).length === 0 ? (
              <div className="flex items-center gap-3 rounded-[12px] border border-rule bg-surface-2/50 p-4">
                <span className="grid h-9 w-9 place-items-center rounded-full bg-ok-soft text-ok"><IconShield size={17} /></span>
                <p className="text-sm text-dim">No quality drop found. Every model change is compared on the same mix of inputs, so harder inputs alone do not raise an alarm.</p>
              </div>
            ) : (
              <>
                {open.length > 0 && <p className="text-xs font-semibold uppercase tracking-wider text-bad">{open.length} open</p>}
                {(alerts.data ?? []).map((a: Alert) => (
                  <AlertItemCard key={a.alert_id} item={{ kind: "regression", alert: a, timestamp: a.created_at }} />
                ))}
              </>
            )}
          </div>
        </Panel>
        <Panel className="p-5">
          <RelatedNews title="In the news about this job's models" filters={{ job }} limit={5} emptyText="No recent story names a model this job runs." />
        </Panel>
      </div>
    </div>
  );
}

export function SpendTab({ job }: { job: string }) {
  const daily = useDaily({ days: 60, job });
  const points = daily.data ?? [];
  const { rows, names } = useMemo(() => pivot(points, "model", "spend_usd", 60), [points]);
  const colors = colorMap(names);
  const byModel = names
    .map((n) => {
      const mine = points.filter((p) => p.model === n);
      return { model: n, spend: total(mine, "spend_usd"), runs: total(mine, "runs") };
    })
    .sort((a, b) => b.spend - a.spend);
  const grand = byModel.reduce((s, m) => s + m.spend, 0);

  return (
    <div className="grid gap-4 lg:grid-cols-3">
      <Panel className="p-5 md:p-6 lg:col-span-2">
        {daily.isPending ? (
          <Skeleton className="h-72" />
        ) : names.length === 0 ? (
          <EmptyState title="No spend in the last 60 days" />
        ) : (
          <ChartFrame
            title="What this job costs, per day"
            hint="Last 60 days, stacked by model"
            legend={names.map((n) => ({ name: n, color: colors.get(n)! }))}
            table={{ columns: ["Day", ...names], rows: rows.filter((r) => names.some((n) => (r[n] as number) > 0)).map((r) => [r.day, ...names.map((n) => usd(r[n] as number))]) }}
          >
            <SpendArea rows={rows} names={names} colors={colors} />
          </ChartFrame>
        )}
      </Panel>
      <Panel className="p-5">
        <PanelHeader title="By model" hint={`${usd(grand)} over 60 days`} />
        <ul className="mt-4 flex flex-col gap-3">
          {byModel.map((m) => (
            <li key={m.model}>
              <div className="flex items-baseline justify-between gap-2 text-sm">
                <ModelName className="truncate">{m.model}</ModelName>
                <span className="tabular font-semibold text-ink">{usd(m.spend)}</span>
              </div>
              <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-surface-3">
                <div className="h-full rounded-full" style={{ width: `${grand ? (m.spend / grand) * 100 : 0}%`, background: colors.get(m.model) }} />
              </div>
              <p className="mt-1 text-[11px] text-muted">{m.runs.toLocaleString("en")} runs · {grand ? pct(m.spend / grand, 0) : "–"} of spend</p>
            </li>
          ))}
        </ul>
      </Panel>
    </div>
  );
}

function bars(items: Breakdown[]) {
  const names = [...new Set(items.map((b) => b.model))].sort();
  const groups = [...new Set(items.map((b) => b.group))];
  const rows = groups.map((g) => {
    const row: Record<string, string | number | null> = { group: g };
    for (const n of names) row[n] = items.find((b) => b.group === g && b.model === n)?.pass_rate ?? null;
    return row;
  });
  return { rows, names };
}

export function EvidenceTab({ job, rec }: { job: string; rec: Recommendation | null }) {
  const [days, setDays] = useState<"7" | "30" | "90">("30");
  const insights = useJobInsights(job, Number(days));
  const [by, setBy] = useState<"size" | "prompt">("size");
  if (insights.isPending) return <Skeleton className="h-80" />;
  if (insights.isError) return <ErrorState error={insights.error} onRetry={() => insights.refetch()} />;
  const data = insights.data!;
  const chosen = by === "size" ? data.by_input_size : data.by_prompt_version;
  const { rows, names } = bars(chosen);
  const colors = colorMap(names.concat(rec?.models.map((m) => m.model) ?? []));
  const failing = rec?.evidence.failing_runs ?? [];
  return (
    <div className="grid gap-4 lg:grid-cols-3">
      <Panel className="p-5 md:p-6 lg:col-span-2">
        <ChartFrame
          title="Where each model struggles"
          hint={`Pass rate by ${by === "size" ? "input size: long documents are often where cheaper models fall behind" : "prompt version: did a prompt change help or hurt"}, last ${data.days} days`}
          actions={
            <>
              <Segmented label="Period" value={days} onChange={setDays} options={[{ value: "7", label: "7 d" }, { value: "30", label: "30 d" }, { value: "90", label: "90 d" }]} />
              <Segmented label="Break down by" value={by} onChange={setBy} options={[{ value: "size", label: "Input size" }, { value: "prompt", label: "Prompt version" }]} />
            </>
          }
          legend={names.map((n) => ({ name: n, color: colors.get(n)! }))}
          table={{
            columns: ["Group", "Model", "Runs", "Pass rate", "Likely range", "Cost / success"],
            rows: chosen.map((b) => [b.group, b.model, b.runs.toLocaleString("en"), pct(b.pass_rate), `${pct(b.pass_rate_low)} – ${pct(b.pass_rate_high)}`, usd(b.cost_per_success_usd)]),
          }}
        >
          {rows.length === 0 ? <EmptyState title="Not enough runs to break down yet" /> : <GroupBars rows={rows} names={names} colors={colors} />}
        </ChartFrame>
      </Panel>
      <Panel className="p-5">
        <PanelHeader title="The receipts" hint="The latest failures behind the verdict" />
        {failing.length === 0 ? (
          <p className="mt-4 flex items-center gap-2 text-sm text-dim"><IconCheck size={16} className="text-ok" /> No recent failure on the models compared.</p>
        ) : (
          <ul className="mt-4 flex flex-col gap-2">
            {failing.slice(0, 8).map((f) => (
              <li key={f.run_id} className="rounded-[12px] border border-rule bg-surface-2/50 p-3">
                <div className="flex items-center justify-between gap-2">
                  <ModelName className="truncate text-xs">{f.model}</ModelName>
                  <span className="text-[11px] text-muted">{timeAgo(f.created_at)}</span>
                </div>
                <p className="mt-1 line-clamp-2 text-xs text-dim">{f.outcome_reason ?? "Failed its check"}</p>
              </li>
            ))}
          </ul>
        )}
        <Link to="?tab=runs" className="mt-3 inline-block text-xs font-semibold text-accent hover:underline">All runs →</Link>
      </Panel>
    </div>
  );
}

export function RunsTab({ job, rec }: { job: string; rec: Recommendation | null }) {
  const [params, setParams] = useSearchParams();
  const outcome = (["PASS", "FAIL", "UNKNOWN"].includes(params.get("outcome") ?? "") ? params.get("outcome") : "ALL") as "ALL" | "PASS" | "FAIL" | "UNKNOWN";
  const model = params.get("model") ?? "";
  const recommendation = params.get("recommendation") ?? "";
  const [open, setOpen] = useState<string | null>(null);
  const runs = useRuns({ job, outcome, model: model || undefined, recommendation: recommendation || undefined });
  const items = runs.data?.pages.flatMap((p) => p.items) ?? [];
  const models = [...new Set(rec?.models.map((m) => m.model) ?? [])].sort();
  const set = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    setParams(next, { replace: true });
  };
  return (
    <Panel className="p-5 md:p-6">
      <PanelHeader
        title="Every run, newest first"
        hint="Click a run for its prompt, answer and why it passed or failed"
        actions={
          <>
            {models.length > 1 && (
              <select
                value={model}
                onChange={(e) => set("model", e.target.value)}
                aria-label="Model"
                className="rounded-[10px] border border-rule bg-surface px-3 py-1.5 text-xs font-semibold text-ink outline-none focus:border-accent"
              >
                <option value="">Every model</option>
                {models.map((m) => <option key={m} value={m}>{m}</option>)}
              </select>
            )}
            <Segmented
              label="Outcome"
              value={outcome}
              onChange={(v) => set("outcome", v === "ALL" ? "" : v)}
              options={[{ value: "ALL", label: "All" }, { value: "PASS", label: "Passed" }, { value: "FAIL", label: "Failed" }, { value: "UNKNOWN", label: "Unchecked" }]}
            />
          </>
        }
      />
      {recommendation && (
        <p className="mt-4 flex flex-wrap items-center justify-between gap-2 rounded-[12px] border border-accent/30 bg-accent-soft/50 px-4 py-2.5 text-sm text-dim">
          <span>Showing only the runs one verdict rests on.</span>
          <button type="button" onClick={() => set("recommendation", "")} className="text-xs font-semibold text-accent hover:underline">Show every run</button>
        </p>
      )}
      <div className="mt-4 overflow-x-auto">
        {runs.isPending ? (
          <Skeleton className="h-60" />
        ) : runs.isError ? (
          <ErrorState error={runs.error} onRetry={() => runs.refetch()} />
        ) : items.length === 0 ? (
          <EmptyState title="No runs match" />
        ) : (
          <table className="w-full min-w-[680px] border-collapse text-left text-sm">
            <thead>
              <tr className="text-[11px] uppercase tracking-wider text-muted">
                <th className="px-3 py-2 font-semibold">When</th>
                <th className="px-3 py-2 font-semibold">Model</th>
                <th className="px-3 py-2 font-semibold">Result</th>
                <th className="px-3 py-2 text-right font-semibold">Tokens</th>
                <th className="px-3 py-2 text-right font-semibold">Cost</th>
                <th className="px-3 py-2 font-semibold">Prompt</th>
              </tr>
            </thead>
            <tbody className="tabular">
              {items.map((r) => (
                <tr
                  key={r.run_id}
                  onClick={() => setOpen(r.run_id)}
                  onKeyDown={(e) => e.key === "Enter" && setOpen(r.run_id)}
                  tabIndex={0}
                  className="cursor-pointer border-t border-rule transition-colors hover:bg-surface-2/60 focus:bg-surface-2/60 focus:outline-none"
                >
                  <td className="whitespace-nowrap px-3 py-2.5 text-dim">{timeAgo(r.created_at)}</td>
                  <td className="px-3 py-2.5"><ModelName className="text-xs">{r.model}</ModelName></td>
                  <td className="px-3 py-2.5">
                    <Pill tone={r.outcome === "PASS" ? "good" : r.outcome === "FAIL" ? "bad" : "neutral"}>
                      {r.outcome === "PASS" ? "Passed" : r.outcome === "FAIL" ? "Failed" : "Unchecked"}
                    </Pill>
                  </td>
                  <td className="whitespace-nowrap px-3 py-2.5 text-right text-dim">{(r.tokens_in + r.tokens_out).toLocaleString("en")}</td>
                  <td className="whitespace-nowrap px-3 py-2.5 text-right text-dim">{usd(r.cost_usd)}</td>
                  <td className="max-w-[320px] truncate px-3 py-2.5 font-sans text-xs text-muted">{r.prompt_preview ?? "removed under retention"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {runs.hasNextPage && (
        <div className="mt-4 text-center">
          <Button size="sm" onClick={() => runs.fetchNextPage()} disabled={runs.isFetchingNextPage}>
            {runs.isFetchingNextPage ? "Loading…" : "Load more"}
          </Button>
        </div>
      )}
      <RunDetailPanel runId={open} onClose={() => setOpen(null)} />
    </Panel>
  );
}

export function HistoryTab({ job }: { job: string }) {
  return (
    <Panel className="p-5 md:p-6">
      <PanelHeader title="How the advice changed" hint="Every verdict this job has had, why it changed, and the runs behind each" />
      <div className="mt-5">
        <JobHistoryTimeline jobName={job} />
      </div>
    </Panel>
  );
}

export function RetestsTab({ job, rec }: { job: string; rec: Recommendation | null }) {
  const p = useP();
  const retests = useJobRetests(job);
  const list = retests.data ?? [];
  return (
    <div className="flex flex-col gap-4">
      <Panel glow className="p-5 md:p-6">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="max-w-2xl">
            <h3 className="flex items-center gap-2 text-lg font-semibold tracking-tight"><IconFlask size={18} className="text-accent" /> Try a model on your own past prompts</h3>
            <p className="mt-1 text-sm text-dim">
              A re-test replays a sample of this job's real prompts on another model, checks each answer the same way, and adds the results to the
              evidence. It runs on your provider key, within a budget you set, and never above the monthly cap.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            {(rec?.retest_candidates ?? []).map((m) => (
              <ButtonLink key={m} to={p(`/retest?job=${encodeURIComponent(job)}&model=${encodeURIComponent(m)}`)} variant="primary" size="sm">Re-test {m}</ButtonLink>
            ))}
            <ButtonLink to={p(`/retest?job=${encodeURIComponent(job)}`)} size="sm">Choose a model</ButtonLink>
          </div>
        </div>
      </Panel>
      {retests.isPending ? (
        <Skeleton className="h-40" />
      ) : list.length === 0 ? (
        <EmptyState icon={<IconFlask size={18} />} title="No re-test yet" hint="Re-tests start by themselves when a new cheaper model appears or a verdict is unsure, or you can start one." />
      ) : (
        list.map((r) => (
          <Panel key={r.retest_id} className="p-5">
            <RetestProgress retest={r} />
          </Panel>
        ))
      )}
    </div>
  );
}
