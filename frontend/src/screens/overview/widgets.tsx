/** The overview's widgets. Each takes the same context (the period, its points and the jobs) and
 * shows one thing about it. */
import { jobTitle } from "../../features/jobs/jobTitle";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Link } from "react-router-dom";
import { useP } from "../../app/project";
import { useAllRegressions, useDeprecatedModels } from "../../features/alerts/hooks/useAlerts";
import { useLimits } from "../../features/limits/hooks/useLimits";
import { RelatedNews } from "../../features/news/components/RelatedNews";
import type { DayPoint, Job, Recommendation } from "../../shared/api/types";
import { CountUp } from "../../shared/motion/CountUp";
import { ChartFrame } from "../../ui/charts/ChartFrame";
import { CompareArea, SpendArea } from "../../ui/charts/charts";
import { pivot } from "../../ui/charts/data";
import { colorMap, SERIES } from "../../ui/charts/series";
import { count, pct, usd, type Verdict } from "../../ui/format";
import { IconAlert, IconArrowRight, IconBolt, IconCheck, IconClock, IconDollar, IconJobs, IconMore, IconShield, IconSpark } from "../../ui/icons";
import { ButtonLink, cx, EmptyState, ModelName, Panel, Pill, Skeleton } from "../../ui/primitives";
import { monthlySaving, VerdictPill } from "../shared";
import { WIDGETS, type WidgetId } from "./layout";
import { byWeekday, compareSeries, delta, passRate, splitBy, sum, unpricedRuns, WEEKDAYS } from "./metrics";

export interface Ctx {
  days: number;
  points: DayPoint[];
  cur: DayPoint[];
  prev: DayPoint[];
  dailyPending: boolean;
  jobs: Job[] | undefined;
  jobsPending: boolean;
  byJob: Map<string, Recommendation | null>;
  recsPending: boolean;
}

/* ----------------------------------------------------------------------------------------------- */
/* Pieces                                                                                           */

/** A small muted note shown beside a spend figure when some runs could not be priced. */
export function UnpricedChip({ count: n }: { count: number }) {
  if (n <= 0) return null;
  return (
    <span className="inline-flex rounded-full bg-surface-3 px-2 py-0.5 text-[11px] font-medium text-muted" title="These AI calls are on models with no known price, so their cost is not in the total.">
      {n.toLocaleString("en")} unpriced {n === 1 ? "run" : "runs"} not counted
    </span>
  );
}

/** ▲ 12.4% in green or red, by whether the move is good. */
export function DeltaPill({ value, upIsGood }: { value: number | null; upIsGood: boolean }) {
  if (value === null || !Number.isFinite(value)) return <span className="rounded-full bg-surface-3 px-2 py-0.5 text-[11px] font-semibold text-muted">new</span>;
  const flat = Math.abs(value) < 0.005;
  const good = value >= 0 === upIsGood;
  return (
    <span
      className={cx(
        "inline-flex items-center gap-0.5 rounded-full px-2 py-0.5 text-[11px] font-semibold tabular",
        flat ? "bg-surface-3 text-muted" : good ? "bg-ok-soft text-ok" : "bg-bad-soft text-bad",
      )}
    >
      {flat ? "＝" : value >= 0 ? "▲" : "▼"} {Math.abs(value * 100).toFixed(1)}%
    </span>
  );
}

function Toggle<T extends string>({ value, options, onChange, label }: { value: T; options: Array<[T, string]>; onChange: (v: T) => void; label: string }) {
  return (
    <div role="tablist" aria-label={label} className="flex rounded-[9px] border border-rule bg-surface-2 p-0.5">
      {options.map(([v, text]) => (
        <button
          key={v}
          type="button"
          role="tab"
          aria-selected={value === v}
          onClick={() => onChange(v)}
          className={cx("rounded-[7px] px-2.5 py-1 text-xs font-semibold transition-colors", value === v ? "bg-[var(--tab-active)] text-ink shadow-sm ring-1 ring-rule" : "text-muted hover:text-dim")}
        >
          {text}
        </button>
      ))}
    </div>
  );
}

/** The ••• menu on each widget: move it, or take it off the overview. */
function WidgetMenu({ id, onMove, onRemove, first, last }: { id: WidgetId; onMove: (by: -1 | 1) => void; onRemove: () => void; first: boolean; last: boolean }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);
  const item = "block w-full rounded-[8px] px-3 py-1.5 text-left text-sm text-dim hover:bg-surface-3 hover:text-ink disabled:opacity-40 disabled:hover:bg-transparent";
  return (
    <div ref={ref} className="relative">
      <button type="button" aria-label={`Options for ${WIDGETS[id].title}`} aria-expanded={open} onClick={() => setOpen((v) => !v)} className="grid h-8 w-8 place-items-center rounded-[8px] text-muted hover:bg-surface-2 hover:text-ink">
        <IconMore size={18} />
      </button>
      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: -4, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -4, scale: 0.97 }}
            transition={{ duration: 0.12 }}
            className="absolute right-0 top-full z-30 mt-1 w-40 rounded-[12px] border border-rule-strong bg-surface p-1 shadow-xl"
          >
            <button type="button" className={item} disabled={first} onClick={() => { onMove(-1); setOpen(false); }}>Move earlier</button>
            <button type="button" className={item} disabled={last} onClick={() => { onMove(1); setOpen(false); }}>Move later</button>
            <div className="my-1 h-px bg-rule" />
            <button type="button" className={cx(item, "text-bad hover:text-bad")} onClick={() => { onRemove(); setOpen(false); }}>Remove</button>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

export interface ShellProps {
  id: WidgetId;
  first: boolean;
  last: boolean;
  onMove: (by: -1 | 1) => void;
  onRemove: () => void;
}

/** A widget's card: title, controls, the ••• menu, then the content. */
export function Shell({ shell, title, hint, controls, children, className }: { shell: ShellProps; title?: ReactNode; hint?: ReactNode; controls?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <Panel className={cx("flex h-full flex-col p-5", className)}>
      <header className="mb-4 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-[15px] font-semibold tracking-tight text-ink">{title ?? WIDGETS[shell.id].title}</h2>
          {hint && <p className="mt-0.5 text-[13px] text-dim">{hint}</p>}
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {controls}
          <WidgetMenu id={shell.id} first={shell.first} last={shell.last} onMove={shell.onMove} onRemove={shell.onRemove} />
        </div>
      </header>
      <div className="flex min-h-0 flex-1 flex-col">{children}</div>
    </Panel>
  );
}

const periodWord = (days: number) => `${days} days`;

/* ----------------------------------------------------------------------------------------------- */
/* Key numbers                                                                                      */

function Kpi({ label, icon, tint, value, render, change, upIsGood, note, index }: {
  label: string;
  icon: ReactNode;
  tint: string;
  value: number | null;
  render: (v: number) => ReactNode;
  change: number | null | undefined;
  upIsGood: boolean;
  note: ReactNode;
  index: number;
}) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 14 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: 0.05 + index * 0.07, duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
      whileHover={{ y: -3 }}
      className="panel flex min-w-0 flex-col gap-3 p-5"
    >
      <div className="flex items-center justify-between gap-2">
        <p className="text-[14px] font-semibold text-ink">{label}</p>
        <span className="grid h-8 w-8 place-items-center rounded-[10px]" style={{ background: `color-mix(in srgb, ${tint} 14%, transparent)`, color: tint }}>{icon}</span>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[28px] font-semibold leading-none tracking-tight text-ink tabular">{value === null ? "–" : render(value)}</span>
        {change !== undefined && value !== null && <DeltaPill value={change} upIsGood={upIsGood} />}
      </div>
      <p className="text-xs text-muted">{note}</p>
    </motion.div>
  );
}

export function KpiCards({ ctx }: { ctx: Ctx }) {
  const { cur, prev, days, dailyPending } = ctx;
  const spend = sum(cur, "spend_usd");
  const spendPrev = sum(prev, "spend_usd");
  const unpriced = unpricedRuns(cur);
  const runs = sum(cur, "runs");
  const runsPrev = sum(prev, "runs");
  const rate = passRate(cur);
  const ratePrev = passRate(prev);
  const recs = [...ctx.byJob.values()];
  const saving = recs.reduce((s, r) => s + monthlySaving(r), 0);
  const movable = recs.filter((r) => monthlySaving(r) > 0).length;
  if (dailyPending) return <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-[132px]" />)}</div>;
  return (
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
      <Kpi index={0} label="Spend" icon={<IconDollar size={16} />} tint="var(--series-1)" value={spend} render={(v) => <CountUp value={v} prefix="$" decimals={v < 100 ? 2 : 0} />} change={delta(spend, spendPrev)} upIsGood={false} note={<>{`What you paid for AI, vs. ${usd(spendPrev)} the ${periodWord(days)} before`}{unpriced > 0 && <><br /><UnpricedChip count={unpriced} /></>}</>} />
      <Kpi index={1} label="Correct answers" icon={<IconCheck size={16} />} tint="var(--series-3)" value={rate} render={(v) => <CountUp value={v * 100} suffix="%" decimals={1} />} change={rate !== null && ratePrev !== null ? rate - ratePrev : null} upIsGood note={ratePrev !== null ? `vs. ${pct(ratePrev)} the ${periodWord(days)} before` : "Share of checked answers that were correct. Nothing was checked in the period before"} />
      <Kpi index={2} label="AI calls recorded" icon={<IconJobs size={16} />} tint="var(--series-7)" value={runs} render={(v) => <CountUp value={v} />} change={delta(runs, runsPrev)} upIsGood note={`Times your app asked an AI, vs. ${count(runsPrev)} the ${periodWord(days)} before`} />
      <Kpi index={3} label="Saving available" icon={<IconSpark size={16} />} tint="var(--color-ok)" value={ctx.recsPending ? null : saving} render={(v) => <CountUp value={v} prefix="$" decimals={v < 100 ? 2 : 0} suffix="/mo" />} change={undefined} upIsGood note={movable ? `Each month, if ${movable} ${movable === 1 ? "AI task moves" : "AI tasks move"} to a cheaper model` : "Every AI task is on the right model"} />
    </div>
  );
}

/* ----------------------------------------------------------------------------------------------- */
/* What you could save                                                                              */

export function Savings({ ctx }: { ctx: Ctx }) {
  const p = useP();
  const recs = [...ctx.byJob.values()];
  const saving = recs.reduce((s, r) => s + monthlySaving(r), 0);
  const movable = recs.filter((r) => r && (r.verdict === "DOWNGRADE" || r.verdict === "SWITCH")).length;
  const jobs = ctx.jobs?.length ?? 0;
  const someone = movable === 1 ? "One AI task" : `${movable} AI tasks`;
  return (
    <Panel glow className="relative overflow-hidden p-6 md:p-8">
      <div aria-hidden className="pointer-events-none absolute -right-16 -top-24 h-72 w-72 rounded-full bg-accent-2/15 blur-3xl" />
      <div className="relative flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
        <div className="min-w-0">
          <p className="flex items-center gap-2 text-[12px] font-semibold uppercase tracking-[0.18em] text-muted"><IconSpark size={14} className="text-accent" /> Our recommendation</p>
          {ctx.jobsPending || ctx.recsPending ? (
            <Skeleton className="mt-4 h-12 w-80" />
          ) : (
            <>
              <h2 className="mt-3 text-[30px] font-semibold leading-[1.05] tracking-tight md:text-[42px]">
                {saving > 0 ? (
                  <>You could save <span className="text-gradient"><CountUp value={saving} prefix="$" decimals={saving < 100 ? 2 : 0} /></span><span className="text-dim"> a month</span></>
                ) : movable > 0 ? (
                  <>{someone} can run on <span className="text-gradient">a cheaper model</span></>
                ) : jobs === 0 ? (
                  "Start recording AI calls"
                ) : (
                  <>Every AI task is on <span className="text-gradient">the right model</span></>
                )}
              </h2>
              <p className="mt-2.5 max-w-2xl text-[15px] text-dim">
                {movable > 0
                  ? `${someone} can move to a cheaper model that gives just as many correct answers, checked on your own past AI calls. Nothing changes until you decide. (An AI task is one kind of work your app asks an AI to do, like reading invoices or sorting support tickets.)`
                  : jobs === 0
                    ? "Send each AI call through our SDK. We check every answer, remember the results, and tell you the cheapest model that still does the job."
                    : "No cheaper model has been shown to do these AI tasks as well yet. We keep checking as new AI calls arrive and models change."}
              </p>
            </>
          )}
        </div>
        <ButtonLink to={p("/jobs")} variant="primary" className="shrink-0">See every AI task <IconArrowRight size={16} /></ButtonLink>
      </div>
    </Panel>
  );
}

/* ----------------------------------------------------------------------------------------------- */
/* This period against the last                                                                     */

export function SpendTrend({ ctx, shell }: { ctx: Ctx; shell: ShellProps }) {
  const [metric, setMetric] = useState<"spend_usd" | "runs">("spend_usd");
  const rows = compareSeries(ctx.points, ctx.days, metric);
  const total = sum(ctx.cur, metric);
  const before = sum(ctx.prev, metric);
  const fmt = metric === "spend_usd" ? (v: number) => usd(v, { compact: true }) : (v: number) => count(Math.round(v));
  return (
    <Shell
      shell={shell}
      title={metric === "spend_usd" ? "Spend" : "AI calls"}
      hint={`${metric === "spend_usd" ? "What you paid each day" : "How many times your app asked an AI each day"}, last ${ctx.days} days. The dashed line is the ${ctx.days} days before.`}
      controls={<Toggle label="Measure" value={metric} onChange={setMetric} options={[["spend_usd", "Spend"], ["runs", "AI calls"]]} />}
    >
      {ctx.dailyPending ? (
        <Skeleton className="h-60" />
      ) : (
        <div className="grid flex-1 gap-5 md:grid-cols-[180px_1fr] md:items-end">
          <div>
            <p className="text-[34px] font-semibold leading-none tracking-tight text-ink tabular">
              {metric === "spend_usd" ? <CountUp value={total} prefix="$" decimals={total < 100 ? 2 : 0} /> : <CountUp value={total} />}
            </p>
            <p className="mt-2 flex flex-wrap items-center gap-1.5 text-xs text-muted">
              <DeltaPill value={delta(total, before)} upIsGood={metric === "runs"} /> vs. {metric === "spend_usd" ? usd(before) : count(before)}
            </p>
            <ul className="mt-5 flex flex-col gap-1.5 text-xs text-dim">
              <li className="flex items-center gap-2"><span className="h-0.5 w-5 rounded bg-accent" /> This period</li>
              <li className="flex items-center gap-2"><span className="h-0 w-5 border-t-2 border-dashed border-muted" /> The period before</li>
            </ul>
          </div>
          <CompareArea rows={rows} format={fmt} height={230} />
        </div>
      )}
    </Shell>
  );
}

/* ----------------------------------------------------------------------------------------------- */
/* Answers passing: a tick gauge against a target                                                   */

const TARGETS = [0.8, 0.9, 0.95, 0.99];
const TARGET_KEY = "mcm_pass_target";

function readTarget(): number {
  try {
    const v = Number(localStorage.getItem(TARGET_KEY));
    return TARGETS.includes(v) ? v : 0.9;
  } catch {
    return 0.9;
  }
}

function Gauge({ rate, target }: { rate: number; target: number }) {
  const n = 42;
  const start = 210;
  const sweep = 240;
  const cx = 100;
  const cy = 98;
  const lit = Math.round(rate * n);
  const targetAt = Math.round(target * (n - 1));
  const on = rate >= target;
  return (
    <svg viewBox="0 0 200 140" className="mx-auto w-full max-w-[260px]" aria-hidden>
      {Array.from({ length: n }, (_, i) => {
        const a = ((start - (i * sweep) / (n - 1)) * Math.PI) / 180;
        const isTarget = i === targetAt;
        const r1 = isTarget ? 60 : 66;
        const r2 = isTarget ? 94 : 88;
        const color = isTarget ? "var(--color-accent)" : i < lit ? (on ? "var(--color-ok)" : "var(--color-warn)") : "var(--color-rule-strong)";
        return (
          <motion.line
            key={i}
            x1={cx + r1 * Math.cos(a)}
            y1={cy - r1 * Math.sin(a)}
            x2={cx + r2 * Math.cos(a)}
            y2={cy - r2 * Math.sin(a)}
            stroke={color}
            strokeWidth={isTarget ? 3 : 4.2}
            strokeLinecap="round"
            initial={{ opacity: 0 }}
            animate={{ opacity: i < lit || isTarget ? 0.45 + (0.55 * i) / n : 1 }}
            transition={{ delay: 0.15 + i * 0.018, duration: 0.25 }}
          />
        );
      })}
    </svg>
  );
}

export function PassGauge({ ctx, shell }: { ctx: Ctx; shell: ShellProps }) {
  const p = useP();
  const [target, setTarget] = useState(readTarget);
  const rate = passRate(ctx.cur);
  const checked = sum(ctx.cur, "passed") + sum(ctx.cur, "failed");
  const choose = (v: number) => {
    setTarget(v);
    try {
      localStorage.setItem(TARGET_KEY, String(v));
    } catch {
      /* kept for this visit */
    }
  };
  return (
    <Shell
      shell={shell}
      hint={`How many answers were correct, based on ${count(checked)} checked answers in the last ${ctx.days} days. The target is your own goal.`}
      controls={
        <label className="flex items-center gap-1 text-xs text-muted">
          <span className="sr-only">Target</span>
          <select value={target} onChange={(e) => choose(Number(e.target.value))} aria-label="Target" className="rounded-[8px] border border-rule bg-surface-2 px-1.5 py-1 text-xs font-semibold text-dim outline-none focus:border-accent">
            {TARGETS.map((t) => <option key={t} value={t}>Target {Math.round(t * 100)}%</option>)}
          </select>
        </label>
      }
    >
      {ctx.dailyPending ? (
        <Skeleton className="h-52" />
      ) : rate === null ? (
        <EmptyState title="Nothing checked yet" hint="The gauge fills once some answers in this period have been checked as correct or wrong." />
      ) : (
        <div className="relative flex flex-1 flex-col items-center justify-center">
          <Gauge rate={rate} target={target} />
          <div className="absolute inset-x-0 top-[34%] flex flex-col items-center text-center">
            <p className="text-[34px] font-semibold leading-none tracking-tight text-ink tabular"><CountUp value={rate * 100} decimals={1} suffix="%" /></p>
            <p className={cx("mt-1.5 text-xs font-medium", rate >= target ? "text-ok" : "text-warn")}>
              {rate >= target ? `On track for the ${Math.round(target * 100)}% target` : `${((target - rate) * 100).toFixed(1)} points under the ${Math.round(target * 100)}% target`}
            </p>
          </div>
          <Link to={p("/jobs")} className="-mt-3 rounded-full border border-rule bg-surface px-3.5 py-1.5 text-xs font-semibold text-dim shadow-sm transition-colors hover:text-ink">Show details</Link>
        </div>
      )}
    </Shell>
  );
}

/* ----------------------------------------------------------------------------------------------- */
/* Where the money goes: thick split bars                                                           */

export function SpendSplit({ ctx, shell }: { ctx: Ctx; shell: ShellProps }) {
  const [by, setBy] = useState<"job" | "model">("job");
  const [metric, setMetric] = useState<"spend_usd" | "runs">("spend_usd");
  const all = splitBy(ctx.cur, by, metric).filter((x) => x.value > 0);
  const colors = colorMap(splitBy(ctx.points, by, "runs").map((x) => x.name));
  const top = all.slice(0, 3);
  const rest = all.slice(3).reduce((s, x) => s + x.value, 0);
  const parts = rest > 0 ? [...top, { name: `${all.length - 3} more`, value: rest, other: true }] : top;
  const total = all.reduce((s, x) => s + x.value, 0);
  const fmt = (v: number) => (metric === "spend_usd" ? usd(v) : count(v));
  return (
    <Shell
      shell={shell}
      hint={`Which ${by === "job" ? "AI task" : "model"} takes the biggest share of your ${metric === "spend_usd" ? "spending" : "AI calls"}, last ${ctx.days} days`}
      controls={
        <>
          <Toggle label="Split by" value={by} onChange={setBy} options={[["job", "AI task"], ["model", "Model"]]} />
          <Toggle label="Measure" value={metric} onChange={setMetric} options={[["spend_usd", "$"], ["runs", "AI calls"]]} />
        </>
      }
    >
      {ctx.dailyPending ? (
        <Skeleton className="h-28" />
      ) : total === 0 ? (
        <EmptyState title={metric === "spend_usd" ? "No spend in this period" : "No AI calls in this period"} hint="It appears here as soon as your app makes AI calls through our SDK." />
      ) : (
        <div className="rounded-[14px] border border-rule p-4">
          <div className="flex flex-wrap gap-y-4 sm:flex-nowrap">
            {parts.map((part, i) => {
              const color = "other" in part ? "var(--series-other)" : colors.get(part.name) ?? SERIES[i];
              return (
                <div key={part.name} className="flex min-w-[110px] flex-col" style={{ flexGrow: Math.max(part.value / total, 0.12), flexBasis: 0 }}>
                  <div className="flex flex-1 flex-col border-l-2 pl-3 pr-2" style={{ borderColor: color }}>
                    <p className="flex items-center gap-1.5 text-[20px] font-semibold leading-tight text-ink tabular">
                      <span className="h-2.5 w-2.5 shrink-0 rounded-[3px]" style={{ background: color }} />
                      {fmt(part.value)}
                    </p>
                    <p className={cx("mt-0.5 truncate text-xs text-muted", !("other" in part) && "font-mono")} title={part.name}>{part.name}</p>
                    <p className="mb-3 text-[11px] text-muted tabular">{pct(part.value / total, 0)} of the total</p>
                  </div>
                  <motion.span
                    className="h-2 origin-left rounded-b-[6px]"
                    style={{ background: `linear-gradient(180deg, ${color}, color-mix(in srgb, ${color} 70%, transparent))` }}
                    initial={{ scaleX: 0 }}
                    animate={{ scaleX: 1 }}
                    transition={{ delay: 0.1 + i * 0.12, duration: 0.7, ease: [0.22, 1, 0.36, 1] }}
                  />
                </div>
              );
            })}
          </div>
        </div>
      )}
    </Shell>
  );
}

/* ----------------------------------------------------------------------------------------------- */
/* Busiest day: pill bars                                                                           */

export function BusiestDay({ ctx, shell }: { ctx: Ctx; shell: ShellProps }) {
  const values = byWeekday(ctx.cur);
  const max = Math.max(...values);
  const peak = values.indexOf(max);
  const [hover, setHover] = useState<number | null>(null);
  return (
    <Shell shell={shell} hint={max > 0 ? `The day your app asks an AI the most: ${["Sundays", "Mondays", "Tuesdays", "Wednesdays", "Thursdays", "Fridays", "Saturdays"][peak]}, over the last ${ctx.days} days` : `AI calls on each day of the week, last ${ctx.days} days`}>
      {ctx.dailyPending ? (
        <Skeleton className="h-48" />
      ) : max === 0 ? (
        <EmptyState title="No AI calls in this period" hint="Busy days will show here once your app makes AI calls through our SDK." />
      ) : (
        <div className="flex flex-1 items-end justify-between gap-2 pt-6" onMouseLeave={() => setHover(null)}>
          {values.map((v, i) => {
            const isPeak = i === peak;
            const show = isPeak || hover === i;
            return (
              <div key={WEEKDAYS[i]} className="flex flex-1 flex-col items-center gap-2" onMouseEnter={() => setHover(i)}>
                <div className="relative flex h-40 w-full max-w-10 items-end">
                  <motion.div
                    className={cx("relative w-full rounded-full", isPeak ? "bg-gradient-to-b from-accent to-[var(--grad-to)] shadow-[0_10px_24px_-10px_var(--accent-glow)]" : hover === i ? "bg-accent/35" : "bg-surface-3")}
                    initial={{ height: 0 }}
                    animate={{ height: `${Math.max(8, (v / max) * 100)}%` }}
                    transition={{ delay: 0.1 + i * 0.06, duration: 0.7, ease: [0.22, 1, 0.36, 1] }}
                  >
                    {show && (
                      <span className={cx("absolute -top-6 left-1/2 -translate-x-1/2 whitespace-nowrap text-xs font-semibold tabular", isPeak ? "text-ink" : "text-dim")}>{count(v)}</span>
                    )}
                  </motion.div>
                </div>
                <span className={cx("text-xs", isPeak ? "font-semibold text-accent-ink" : "text-muted")}>{WEEKDAYS[i]}</span>
              </div>
            );
          })}
        </div>
      )}
    </Shell>
  );
}

/* ----------------------------------------------------------------------------------------------- */
/* Jobs table                                                                                       */

export function JobsTable({ ctx, shell }: { ctx: Ctx; shell: ShellProps }) {
  const p = useP();
  const jobs = ctx.jobs ?? [];
  const rows = jobs
    .map((job) => {
      const mine = ctx.cur.filter((x) => x.job === job.name);
      const before = ctx.prev.filter((x) => x.job === job.name);
      const spend = sum(mine, "spend_usd");
      return { job, runs: sum(mine, "runs"), spend, change: delta(spend, sum(before, "spend_usd")), rate: passRate(mine), rec: ctx.byJob.get(job.name) ?? null };
    })
    .sort((a, b) => b.spend - a.spend || b.runs - a.runs);
  return (
    <Shell shell={shell} hint={`Each AI task (one kind of work your app asks an AI to do) with what it cost and our recommendation, last ${ctx.days} days`} controls={<Link to={p("/jobs")} className="text-xs font-semibold text-accent-ink hover:underline">All AI tasks →</Link>}>
      {ctx.jobsPending ? (
        <Skeleton className="h-48" />
      ) : jobs.length === 0 ? (
        <EmptyState icon={<IconJobs size={18} />} title="No AI tasks yet" hint="An AI task is one kind of work your app asks an AI to do. Create one, then send its AI calls through our SDK." action={<ButtonLink to={p("/jobs")} variant="primary">Create an AI task</ButtonLink>} />
      ) : (
        <div className="-mx-5 overflow-x-auto">
          <table className="w-full min-w-[620px] text-sm">
            <thead>
              <tr className="text-left text-[11px] font-semibold uppercase tracking-wider text-muted">
                <th className="px-5 pb-2 font-semibold">AI task</th>
                <th className="pb-2 text-right font-semibold">AI calls</th>
                <th className="pb-2 text-right font-semibold">Spend</th>
                <th className="pb-2 pl-4 font-semibold">Spend change</th>
                <th className="pb-2 text-right font-semibold">Correct answers</th>
                <th className="px-5 pb-2 text-right font-semibold">Our recommendation</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => {
                const up = r.change !== null && r.change > 0.005;
                const down = r.change !== null && r.change < -0.005;
                return (
                  <motion.tr key={r.job.job_id} initial={{ opacity: 0, x: -8 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: 0.05 + i * 0.05 }} className="border-t border-rule transition-colors hover:bg-surface-2/70">
                    <td className="px-5 py-3">
                      <Link to={p(`/jobs/${encodeURIComponent(r.job.name)}`)} className="text-[13.5px] font-semibold text-ink hover:text-accent-ink">{jobTitle(r.job.name)}</Link>
                      <span className="ml-2 rounded bg-surface-3 px-1.5 py-0.5 font-mono text-[10.5px] text-muted" title="The name used in your code">{r.job.name}</span>
                      {r.rec?.current?.model && <p className="mt-0.5 text-xs text-muted"><ModelName className="text-muted">{r.rec.current.model}</ModelName></p>}
                    </td>
                    <td className="py-3 text-right text-dim tabular">{count(r.runs)}</td>
                    <td className="py-3 text-right font-semibold text-ink tabular">{usd(r.spend)}</td>
                    <td className="py-3 pl-4">
                      <span className={cx("inline-flex items-center gap-1.5 text-xs font-semibold tabular", up ? "text-bad" : down ? "text-ok" : "text-muted")}>
                        <span className={cx("grid h-4 w-4 place-items-center rounded-full border text-[9px]", up ? "border-bad" : down ? "border-ok" : "border-rule-strong")}>{up ? "↑" : down ? "↓" : "–"}</span>
                        {r.change === null ? "new" : `${Math.abs(r.change * 100).toFixed(0)}%`}
                      </span>
                    </td>
                    <td className="py-3 text-right text-dim tabular">{pct(r.rate)}</td>
                    <td className="px-5 py-3 text-right">{r.rec ? <VerdictPill verdict={r.rec.verdict as Verdict} /> : <Pill tone="neutral">Still learning</Pill>}</td>
                  </motion.tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Shell>
  );
}

/* ----------------------------------------------------------------------------------------------- */
/* Needs your attention, spend by job, how it works, news                                           */

export function Attention({ shell }: { shell: ShellProps }) {
  const p = useP();
  const regressions = useAllRegressions();
  const deprecated = useDeprecatedModels();
  const limits = useLimits();
  const items = [
    ...(regressions.data ?? [])
      .filter((a) => a.resolved_at === null)
      .map((a) => ({ key: a.alert_id, tone: "bad" as const, icon: <IconAlert size={16} />, title: a.summary, sub: a.job, to: p(`/jobs/${encodeURIComponent(a.job)}?tab=quality`) })),
    ...(deprecated.data ?? []).map((m) => ({
      key: m.model,
      tone: "warn" as const,
      icon: <IconClock size={16} />,
      title: `${m.model} ${m.status === "RETIRED" ? "has been retired" : "is being retired"}`,
      sub: m.shutdown_date ? `Shutdown ${new Date(m.shutdown_date).toLocaleDateString("en", { day: "numeric", month: "short", year: "numeric" })}` : "No shutdown date published",
      to: p("/models"),
    })),
    ...(limits.data ?? [])
      .filter((l) => l.state === "AT_RISK" || l.state === "EXHAUSTED")
      .map((l) => ({
        key: l.limit_id,
        tone: l.state === "EXHAUSTED" ? ("bad" as const) : ("warn" as const),
        icon: <IconBolt size={16} />,
        title: `${l.name} ${l.state === "EXHAUSTED" ? "is used up" : `runs out in ${Math.round(l.hours_to_full ?? 0)} h`}`,
        sub: `Resets in ${Math.round(l.hours_to_reset)} h`,
        to: p("/settings#limits"),
      })),
  ];
  return (
    <Shell shell={shell} hint="Things to look at now: answers getting worse, models being shut down, and usage limits about to run out">
      {items.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 py-6 text-center">
          <span className="grid h-11 w-11 place-items-center rounded-full bg-ok-soft text-ok"><IconShield size={20} /></span>
          <p className="text-sm font-semibold text-ink">All clear</p>
          <p className="max-w-60 text-xs text-dim">No quality drop, no model you use is being shut down, and no usage limit is about to run out.</p>
        </div>
      ) : (
        <ul className="flex flex-col gap-2">
          {items.slice(0, 6).map((it, i) => (
            <motion.li key={it.key} initial={{ opacity: 0, x: 10 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: 0.05 + i * 0.06 }}>
              <Link to={it.to} className="flex items-start gap-3 rounded-[12px] border border-rule bg-surface-2/50 p-3 transition-colors hover:border-rule-strong">
                <span className={cx("mt-0.5", it.tone === "bad" ? "text-bad" : "text-warn")}>{it.icon}</span>
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium leading-snug text-ink">{it.title}</span>
                  <span className="mt-0.5 block truncate font-mono text-xs text-muted">{it.sub}</span>
                </span>
                <IconArrowRight size={15} className="mt-1 shrink-0 text-muted" />
              </Link>
            </motion.li>
          ))}
        </ul>
      )}
    </Shell>
  );
}

export function SpendByJob({ ctx, shell }: { ctx: Ctx; shell: ShellProps }) {
  const byJob = pivot(ctx.cur, "job", "spend_usd", ctx.days);
  const colors = colorMap((ctx.jobs ?? []).map((j) => j.name).concat(byJob.names));
  return (
    <Shell shell={shell} hint={`What you paid each day for the last ${ctx.days} days, stacked by AI task`}>
      {ctx.dailyPending ? (
        <Skeleton className="h-64" />
      ) : byJob.names.length === 0 ? (
        <EmptyState title="No spend yet" hint="Spending appears here as soon as AI calls to models with a known price are recorded." />
      ) : (
        <ChartFrame
          title=""
          legend={byJob.names.map((n) => ({ name: n, color: colors.get(n)! }))}
          table={{
            columns: ["Day", ...byJob.names, "Total"],
            rows: byJob.rows
              .filter((r) => byJob.names.some((n) => (r[n] as number) > 0))
              .map((r) => [r.day, ...byJob.names.map((n) => usd(r[n] as number)), usd(byJob.names.reduce((s, n) => s + (r[n] as number), 0))]),
          }}
        >
          <SpendArea rows={byJob.rows} names={byJob.names} colors={colors} height={240} />
        </ChartFrame>
      )}
    </Shell>
  );
}

const STEPS = [
  { key: "recorded", title: "Record", text: "Every AI call your app makes: the prompt, the model, tokens used and cost" },
  { key: "checked", title: "Check", text: "Each answer marked correct or wrong" },
  { key: "learned", title: "Remember", text: "Recent checked answers count more than old ones" },
  { key: "advised", title: "Advise", text: "The cheapest model that still gives correct answers" },
] as const;

export function Pipeline({ ctx, shell }: { ctx: Ctx; shell: ShellProps }) {
  const jobs = ctx.jobs ?? [];
  const recorded = jobs.reduce((s, j) => s + j.run_count, 0);
  const state = (name: string) => jobs.reduce((s, j) => s + (j.runs_by_state?.[name] ?? 0), 0);
  const checked = recorded - state("CAPTURED") - state("INGESTION_FAILED");
  const learned = state("INDEXED") + state("CONSOLIDATED") + state("ARCHIVED");
  const verdicts = [...ctx.byJob.values()].filter((r) => r && r.verdict !== "INSUFFICIENT_EVIDENCE").length;
  const values: Record<string, string> = { recorded: count(recorded), checked: count(Math.max(0, checked)), learned: count(learned), advised: `${verdicts} of ${jobs.length}` };
  return (
    <Shell shell={shell} hint="The four steps every AI call goes through, from your first recorded call until now">
      <ol className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {STEPS.map((s, i) => (
          <motion.li key={s.key} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.1 + i * 0.08 }} className="rounded-[14px] border border-rule bg-surface-2/60 p-4">
            <div className="flex items-center justify-between">
              <span className="grid h-7 w-7 place-items-center rounded-full bg-accent-soft text-xs font-bold text-accent-ink">{i + 1}</span>
              <span className="text-lg font-semibold text-ink tabular">{values[s.key]}</span>
            </div>
            <p className="mt-3 text-sm font-semibold text-ink">{s.title}</p>
            <p className="mt-0.5 text-xs text-dim">{s.text}</p>
          </motion.li>
        ))}
      </ol>
    </Shell>
  );
}

export function News({ shell }: { shell: ShellProps }) {
  return (
    <Shell shell={shell} hint="Recent news about the AI models you use, such as price changes and shutdowns">
      <RelatedNews title="" filters={{ mine: true }} limit={4} emptyText="No recent story is about a model you use. News about your models will show up here." />
    </Shell>
  );
}
