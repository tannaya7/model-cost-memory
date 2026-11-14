/** The job's tokens: input and output over time, average input per run, and rule-based hints to trim them. */
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { useReducedMotion } from "framer-motion";
import { useDaily } from "../../features/insights/api/dailyApi";
import { ChartFrame, TooltipCard } from "../../ui/charts/ChartFrame";
import { CHART } from "../../ui/charts/series";
import { count, shortDate } from "../../ui/format";
import { DeltaPill } from "../overview/widgets";
import { TokenBars } from "../overview/TokenUsage";
import { avgInputPerRun, dailySeries, hasTokens, hints, tokenPeriods, totals, type TokenPoint } from "../overview/tokenMetrics";
import { EmptyState, Panel, Skeleton } from "../../ui/primitives";

const DAYS = 30;
const tickDay = (d: string) => shortDate(`${d}T00:00:00Z`);

export function TokensTab({ job }: { job: string }) {
  const daily = useDaily({ days: DAYS * 2, job });
  const animate = !useReducedMotion();

  if (daily.isPending) return <Skeleton className="h-72 w-full" />;
  const points = (daily.data ?? []) as TokenPoint[];
  if (!hasTokens(points)) {
    return <EmptyState title="No token counts yet" hint="Token figures appear once this job's recorded runs report how many tokens they used." />;
  }

  const { cur, prev } = tokenPeriods(points, DAYS);
  const rows = dailySeries(points, DAYS);
  const avgNow = avgInputPerRun(cur);
  const avgBefore = avgInputPerRun(prev);
  const avgChange = avgNow !== null && avgBefore ? (avgNow - avgBefore) / avgBefore : null;
  const avgRows = rows.map((r) => {
    const runs = totals(points.filter((p) => p.day === r.day)).runs;
    return { day: r.day, avg: runs > 0 ? Math.round((r.input + r.cached) / runs) : null };
  });
  const found = hints(cur, prev);

  return (
    <div className="flex flex-col gap-4">
      <Panel className="p-5">
        <ChartFrame
          title="Input and output tokens"
          hint={`Last ${DAYS} days: ${count(cur.input + cur.cacheRead)} input, ${count(cur.output)} output`}
          legend={[
            { name: "Input", color: "var(--series-1)" },
            { name: "Output", color: "var(--series-3)" },
            { name: "Cached", color: "var(--series-7)" },
          ]}
          table={{ columns: ["Day", "Input", "Output", "Cached"], rows: rows.map((r) => [r.day, count(r.input), count(r.output), count(r.cached)]) }}
        >
          <TokenBars rows={rows} height={220} />
        </ChartFrame>
      </Panel>

      <Panel className="p-5">
        <ChartFrame
          title="Average input per run"
          hint={
            <span className="inline-flex flex-wrap items-center gap-2">
              {avgNow === null ? "No runs yet" : `${count(Math.round(avgNow))} tokens per run`}
              {avgNow !== null && <DeltaPill value={avgChange} upIsGood={false} />}
              <span className="text-xs text-muted">vs the {DAYS} days before</span>
            </span>
          }
          table={{ columns: ["Day", "Input per run"], rows: avgRows.map((r) => [r.day, r.avg === null ? "–" : count(r.avg)]) }}
        >
          <div style={{ height: 180 }} className="w-full">
            <ResponsiveContainer>
              <LineChart data={avgRows} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
                <CartesianGrid stroke={CHART.grid} vertical={false} />
                <XAxis dataKey="day" tickFormatter={tickDay} tick={CHART.tickFont} axisLine={{ stroke: CHART.axis }} tickLine={false} minTickGap={28} />
                <YAxis tickFormatter={(v: number) => count(v)} tick={CHART.tickFont} axisLine={false} tickLine={false} width={48} />
                <Tooltip
                  content={({ active, payload, label }) =>
                    active && payload?.length ? <TooltipCard title={tickDay(String(label))} rows={[{ color: "var(--series-1)", label: "Input per run", value: count(Number(payload[0].value)) }]} /> : null
                  }
                />
                <Line type="monotone" dataKey="avg" stroke="var(--series-1)" strokeWidth={2} dot={false} connectNulls isAnimationActive={animate} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </ChartFrame>
      </Panel>

      <Panel className="p-5">
        <h2 className="text-[15px] font-semibold tracking-tight text-ink">Ways to use fewer tokens</h2>
        <p className="mt-0.5 text-[13px] text-dim">Rule-based suggestions from the last {DAYS} days. They are estimates, not promises.</p>
        {found.length === 0 ? (
          <p className="mt-3 text-sm text-dim">Nothing stands out. Token use looks in proportion for this job.</p>
        ) : (
          <ul className="mt-3 space-y-3">
            {found.map((h) => (
              <li key={h.id} className="rounded-[12px] border border-rule bg-surface-2 p-4">
                <p className="text-sm font-semibold text-ink">{h.title}</p>
                <p className="mt-1 text-[13px] text-ink tabular">{h.facts}</p>
                <p className="mt-1 text-[13px] text-dim">{h.advice}</p>
              </li>
            ))}
          </ul>
        )}
        <p className="mt-4 text-xs text-muted">Figures are from recorded runs.</p>
      </Panel>
    </div>
  );
}
