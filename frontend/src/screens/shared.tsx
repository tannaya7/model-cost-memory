/** Data and pieces shared by several screens. */
import { useQueries } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { fetchRecommendation } from "../features/recommendations/api/recommendationsApi";
import type { Job, Recommendation } from "../shared/api/types";
import { CountUp } from "../shared/motion/CountUp";
import { Sparkline } from "../ui/charts/charts";
import { cx, Pill } from "../ui/primitives";
import { VERDICT, type Verdict } from "../ui/format";

/** Every job's recommendation, fetched side by side. Jobs without enough runs answer 404 or a thin
 * verdict; those come back as null rather than failing the whole screen. */
export function useAllRecommendations(jobs: Job[] | undefined) {
  const results = useQueries({
    queries: (jobs ?? []).map((job) => ({
      queryKey: ["recommendation", job.name],
      queryFn: () => fetchRecommendation(job.name),
      staleTime: 60_000,
      retry: false,
    })),
  });
  const byJob = new Map<string, Recommendation | null>();
  (jobs ?? []).forEach((job, i) => byJob.set(job.name, results[i]?.data ?? null));
  return { byJob, isPending: results.some((r) => r.isPending) };
}

/** The money a recommendation would save each month, when it advises a move that saves money. */
export function monthlySaving(rec: Recommendation | null | undefined): number {
  if (!rec || (rec.verdict !== "DOWNGRADE" && rec.verdict !== "SWITCH")) return 0;
  return Math.max(0, rec.forecast?.monthly_saving_usd ?? 0);
}

export function VerdictPill({ verdict }: { verdict: Verdict }) {
  const v = VERDICT[verdict];
  return <Pill tone={v.tone}>{v.label}</Pill>;
}

/** A headline number with a label, an optional change and an optional trend line. */
export function StatTile({
  label,
  value,
  format,
  decimals = 0,
  prefix = "",
  suffix = "",
  note,
  trend,
  trendColor,
  icon,
  accent = false,
}: {
  label: string;
  value: number | null;
  format?: (v: number) => string;
  decimals?: number;
  prefix?: string;
  suffix?: string;
  note?: ReactNode;
  trend?: number[];
  trendColor?: string;
  icon?: ReactNode;
  accent?: boolean;
}) {
  return (
    <div className={cx("panel flex min-w-0 flex-col justify-between gap-3 p-5", accent && "ring-1 ring-accent/30")}>
      <div className="flex items-center justify-between gap-2">
        <p className="text-[13px] font-medium text-dim">{label}</p>
        {icon && <span className="text-muted">{icon}</span>}
      </div>
      <div>
        <p className="text-[28px] font-semibold leading-none tracking-tight text-ink">
          {value === null ? (
            "–"
          ) : format ? (
            format(value)
          ) : (
            <CountUp value={value} decimals={decimals} prefix={prefix} suffix={suffix} />
          )}
        </p>
        {note && <p className="mt-1.5 text-xs text-muted">{note}</p>}
      </div>
      {trend && trend.length > 1 && <Sparkline values={trend} color={trendColor} />}
    </div>
  );
}

/** "+12%" in the right colour for whether up is good. */
export function Delta({ change, upIsGood }: { change: number | null; upIsGood: boolean }) {
  if (change === null || !Number.isFinite(change)) return null;
  const up = change >= 0;
  const good = up === upIsGood;
  return (
    <span className={cx("font-semibold", Math.abs(change) < 0.005 ? "text-muted" : good ? "text-ok" : "text-bad")}>
      {up ? "▲" : "▼"} {Math.abs(change * 100).toFixed(0)}%
    </span>
  );
}
