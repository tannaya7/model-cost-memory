/** Overview widget: how many tokens the runs used, how they split, who used most and what that means for a token limit. */
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { useReducedMotion } from "framer-motion";
import { jobTitle } from "../../features/jobs/jobTitle";
import { useLimits } from "../../features/limits/hooks/useLimits";
import { hoursLabel } from "../../features/limits/format";
import { ChartFrame, TooltipCard } from "../../ui/charts/ChartFrame";
import { CHART } from "../../ui/charts/series";
import { count, pct, shortDate } from "../../ui/format";
import { EmptyState, Skeleton } from "../../ui/primitives";
import { DeltaPill, Shell, type Ctx, type ShellProps } from "./widgets";
import { cacheShare, dailySeries, hasTokens, limitRisk, tokenPeriods, topConsumers, type TokenDay, type TokenPoint } from "./tokenMetrics";

const TOKEN_SERIES = [
  { key: "input", name: "Input", color: "var(--series-1)" },
  { key: "output", name: "Output", color: "var(--series-3)" },
  { key: "cached", name: "Cached (saved repeats)", color: "var(--series-7)" },
] as const;

const tickDay = (d: string) => shortDate(`${d}T00:00:00Z`);

/** Daily tokens as stacked bars: input, output and cache reads. */
export function TokenBars({ rows, height = 200 }: { rows: TokenDay[]; height?: number }) {
  const animate = !useReducedMotion();
  return (
    <div style={{ height }} className="w-full">
      <ResponsiveContainer>
        <BarChart data={rows} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
          <CartesianGrid stroke={CHART.grid} vertical={false} />
          <XAxis dataKey="day" tickFormatter={tickDay} tick={CHART.tickFont} axisLine={{ stroke: CHART.axis }} tickLine={false} minTickGap={28} />
          <YAxis tickFormatter={(v: number) => count(v)} tick={CHART.tickFont} axisLine={false} tickLine={false} width={48} />
          <Tooltip
            cursor={{ fill: "var(--chart-grid)" }}
            content={({ active, payload, label }) =>
              active && payload?.length ? (
                <TooltipCard
                  title={tickDay(String(label))}
                  rows={payload.map((p) => ({ color: String(p.color), label: String(p.name), value: count(Number(p.value)) }))}
                />
              ) : null
            }
          />
          {TOKEN_SERIES.map((s) => (
            <Bar key={s.key} dataKey={s.key} name={s.name} stackId="tokens" fill={s.color} isAnimationActive={animate} animationDuration={700} />
          ))}
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

export function TokenUsage({ ctx, shell }: { ctx: Ctx; shell: ShellProps }) {
  const limits = useLimits();
  const points = ctx.points as TokenPoint[];
  const cur = ctx.cur as TokenPoint[];

  if (ctx.dailyPending) {
    return (
      <Shell shell={shell} title="Token usage">
        <Skeleton className="h-6 w-40" />
        <Skeleton className="mt-4 h-44 w-full" />
      </Shell>
    );
  }
  if (!hasTokens(cur) && !hasTokens(points)) {
    return (
      <Shell shell={shell} title="Token usage" hint="Tokens are the small pieces of text AI models are billed by. Longer prompts and answers use more tokens.">
        <EmptyState title="No token counts yet" hint="When your app sends AI calls, we count the tokens they use here. Start by creating an AI task and sending a call from your code." />
      </Shell>
    );
  }

  const { cur: t, change } = tokenPeriods(points, ctx.days);
  const rows = dailySeries(points, ctx.days);
  const share = cacheShare(t);
  const jobs = topConsumers(cur, "job", 3);
  const risk = limitRisk(points, limits.data ?? []);

  return (
    <Shell shell={shell} title="Token usage" help="AI is billed by tokens, the small pieces of text it reads and writes. A long question or a long answer uses more tokens, so it costs more. Here we show how many tokens each call uses." hint={`Longer questions and answers use more tokens, so they cost more. Last ${ctx.days} days.`}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[28px] font-semibold leading-none tracking-tight text-ink tabular">{count(t.all)}</span>
        <span className="text-sm text-dim">tokens</span>
        <DeltaPill value={change} upIsGood={false} />
        <span className="text-xs text-muted">compared with the {ctx.days} days before</span>
      </div>

      {risk && (
        <p className="mt-3 rounded-[10px] bg-warn-soft px-3 py-2 text-[13px] text-warn" role="status">
          {risk.hoursToFull !== null && risk.hoursToFull < risk.hoursToReset
            ? `At this rate the ${risk.name} limit is full in ${hoursLabel(risk.hoursToFull)}${risk.ownEstimate ? "" : " (estimate)"}`
            : `The ${risk.name} limit should last until it resets in ${hoursLabel(risk.hoursToReset)} at this rate`}
          {risk.topJobs.length > 0 && `; ${risk.topJobs.length === 1 ? "this AI task" : `these ${risk.topJobs.length} AI tasks`} caused ${Math.round(risk.topShare * 100)}% of the tokens.`}
        </p>
      )}

      <ChartFrame
        className="mt-4"
        title="Tokens per day"
        legend={TOKEN_SERIES.map((s) => ({ name: s.name, color: s.color }))}
        table={{
          columns: ["Day", "Input", "Output", "Cached"],
          rows: rows.map((r) => [r.day, count(r.input), count(r.output), count(r.cached)]),
        }}
      >
        <TokenBars rows={rows} />
      </ChartFrame>

      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wider text-muted">Saved repeats</p>
          <p className="mt-1 text-lg font-semibold text-ink tabular">{share === null ? "–" : pct(share, 0)}</p>
          <p className="text-xs text-muted">of your input was cheaper because the start of the prompt was sent before. When the same start of a prompt is sent again, some providers charge much less for it.</p>
        </div>
        <div>
          <p className="text-xs font-semibold uppercase tracking-wider text-muted">Biggest users of tokens</p>
          {jobs.length === 0 ? (
            <p className="mt-1 text-sm text-dim">None</p>
          ) : (
            <ul className="mt-1 space-y-1">
              {jobs.map((j) => (
                <li key={j.name} className="flex items-center justify-between gap-3 text-sm">
                  <span className="min-w-0 truncate text-ink" title={`Name in your code: ${j.name}`}>
                    {jobTitle(j.name)} <span className="ml-1 rounded-md border border-rule bg-surface-2 px-1.5 py-0.5 font-mono text-[11px] text-dim">{j.name}</span>
                  </span>
                  <span className="shrink-0 text-dim tabular">
                    {count(j.tokens)} · {pct(j.share, 0)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      <p className="mt-auto pt-4 text-xs text-muted">Figures come from recorded runs (your AI calls). Limits and rates are estimates.</p>
    </Shell>
  );
}
