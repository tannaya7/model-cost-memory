/** The overview's widgets. Each takes the same context (the period, its points and the jobs) and
 * shows one thing about it. */
import { jobTitle } from "../../features/jobs/jobTitle";
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Link } from "react-router-dom";
import { useP } from "../../app/project";
import { newKindView } from "../../features/alerts/newKinds";
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
import { Help } from "../../ui/Help";
import { NoCallsYet, NoneChecked, NotEnoughData } from "../../ui/NotEnoughData";
import { MIN_CHECKED_ANSWERS } from "../compare/wilson";
import { ButtonLink, cx, EmptyState, ModelName, Panel, Pill, Skeleton } from "../../ui/primitives";
import { monthlySaving, VerdictPill } from "../shared";
import { passRateInUse, savingVolume } from "../forecastText";
import { useBillingMode, type BillingMode } from "../../features/projects/hooks/useBillingMode";
import { MONEY_ALERT_FALLBACK, serverText } from "../../features/projects/moneyWording";
import { totals } from "./tokenMetrics";
import { useAllowanceWays } from "./useAllowanceWays";
import { MIN_CALLS } from "./agentView";
import { retiringView } from "./retiring";
import { WIDGETS, type WidgetId } from "./layout";
import { byWeekday, compareSeries, delta, passRate, splitBy, sum, unpricedRuns, WEEKDAYS } from "./metrics";

/** The one product floor, from the recommendation rules when we have them. */
export function floorOf(byJob: Map<string, Recommendation | null>): number {
  for (const r of byJob.values()) if (r?.rules?.evidence_floor) return r.rules.evidence_floor;
  return MIN_CHECKED_ANSWERS;
}

export interface Ctx {
  days: number;
  points: DayPoint[];
  cur: DayPoint[];
  prev: DayPoint[];
  /** Completed UTC days only, for percent changes (today is partial). Left out = same as cur and prev. */
  curDone?: DayPoint[];
  prevDone?: DayPoint[];
  dailyPending: boolean;
  jobs: Job[] | undefined;
  jobsPending: boolean;
  byJob: Map<string, Recommendation | null>;
  recsPending: boolean;
  /** How the project pays for AI. Left out means per use, exactly as before. */
  billing?: BillingMode;
  /** The one widget on screen that says "N AI calls not counted". Left out = every card may say it. */
  unpricedOwner?: WidgetId;
}

/** True when this widget is the one that says how many AI calls have no known price. */
export const ownsUnpriced = (ctx: Pick<Ctx, "unpricedOwner">, id: WidgetId) => ctx.unpricedOwner === undefined || ctx.unpricedOwner === id;

/** The heading level for a card: 3 under a section heading, 2 otherwise (so the page never skips a level). */
export const CardLevel = createContext<2 | 3>(2);

/* ----------------------------------------------------------------------------------------------- */
/* Pieces                                                                                           */

/** A small muted note shown beside a spend figure when some runs could not be priced. */
export function UnpricedChip({ count: n }: { count: number }) {
  if (n <= 0) return null;
  return (
    <span className="inline-flex rounded-full bg-surface-3 px-2 py-0.5 text-[11px] font-medium text-muted" title="These AI calls are on models with no known price, so their cost is not in the total.">
      {n.toLocaleString("en")} {n === 1 ? "AI call" : "AI calls"} not counted: no known price
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
export function Shell({ shell, title, hint, help, controls, children, className, noMenu }: { shell: ShellProps; title?: ReactNode; hint?: ReactNode; help?: ReactNode; controls?: ReactNode; children: ReactNode; className?: string; noMenu?: boolean }) {
  const H = useContext(CardLevel) === 3 ? "h3" : "h2";
  return (
    <Panel fill className={cx("flex h-full flex-col p-5", className)}>
      <header className="mb-4 flex flex-wrap items-start justify-between gap-x-3 gap-y-2">
        <div className="min-w-0 flex-1 basis-[11rem]">
          <H className="flex items-center gap-1.5 text-[15px] font-semibold tracking-tight text-ink">{title ?? WIDGETS[shell.id].title}{help && <Help>{help}</Help>}</H>
          {hint && <p className="mt-0.5 text-[13px] text-dim">{hint}</p>}
        </div>
        <div className="ml-auto flex shrink-0 flex-wrap items-center justify-end gap-1.5">
          {controls}
          {!noMenu && <WidgetMenu id={shell.id} first={shell.first} last={shell.last} onMove={shell.onMove} onRemove={shell.onRemove} />}
        </div>
      </header>
      <div className="flex min-h-0 flex-1 flex-col">{children}</div>
    </Panel>
  );
}

const periodWord = (days: number) => `${days} days`;

/* ----------------------------------------------------------------------------------------------- */
/* Key numbers                                                                                      */

function Kpi({ label, icon, tint, value, render, change, upIsGood, note, index, help }: {
  help?: ReactNode;
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
        <p className="flex items-center gap-1.5 text-[14px] font-semibold text-ink">{label}{help && <Help>{help}</Help>}</p>
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
  const curDone = ctx.curDone ?? cur;
  const prevDone = ctx.prevDone ?? prev;
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
  if (ctx.billing === "subscription" || ctx.billing === "both") return <AllowanceKpis ctx={ctx} />;
  return (
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
      <Kpi index={0} label="Spend" icon={<IconDollar size={16} />} tint="var(--series-1)" value={spend} render={(v) => <CountUp value={v} prefix="$" decimals={v < 100 ? 2 : 0} />} change={delta(sum(curDone, "spend_usd"), sum(prevDone, "spend_usd"))} upIsGood={false} help="This is what your AI calls cost, added up from the list price of each model. Calls to a model with no known price are left out, and we tell you how many." note={<>{`What your calls cost at list prices, vs. ${usd(spendPrev)} the ${periodWord(days)} before`}{unpriced > 0 && ownsUnpriced(ctx, "kpis") && <><br /><UnpricedChip count={unpriced} /></>}</>} />
      <Kpi index={1} label="Correct answers" icon={<IconCheck size={16} />} tint="var(--series-3)" value={rate} render={(v) => <CountUp value={v * 100} suffix="%" decimals={1} />} change={passRate(curDone) !== null && passRate(prevDone) !== null ? passRate(curDone)! - passRate(prevDone)! : null} upIsGood help="We check an answer against the right answer or a rule you set. Out of every 100 answers we checked, this is how many were right. Answers nobody checked are not counted." note={rate === null ? (runs === 0 ? "No AI calls yet. They will show here once your app sends one." : "None of your AI calls are checked yet, so we cannot say how many are correct.") : <>{`Out of every 100 answers we checked, about ${Math.round(rate * 100)} were right`}{ratePrev !== null ? `, vs. ${pct(ratePrev)} the ${periodWord(days)} before` : ""}</>} />
      <Kpi index={2} label="AI calls recorded" icon={<IconJobs size={16} />} tint="var(--series-7)" value={runs} render={(v) => <CountUp value={v} />} change={delta(sum(curDone, "runs"), sum(prevDone, "runs"))} upIsGood note={`Times your app asked an AI, vs. ${count(runsPrev)} the ${periodWord(days)} before`} />
      <Kpi index={3} label="Saving available" icon={<IconSpark size={16} />} tint="var(--color-ok)" value={ctx.recsPending ? null : saving} render={(v) => <CountUp value={v} prefix="$" decimals={v < 100 ? 2 : 0} suffix="/mo" />} change={undefined} upIsGood help="This is what you would save each month by moving an AI task to a cheaper AI model that still gives about as many correct answers. It is an estimate from your own past calls. Nothing changes unless you decide." note={movable ? `Each month, if ${movable} ${movable === 1 ? "AI task moves" : "AI tasks move"} to a cheaper AI model, based on ${savingVolume(recs).toLocaleString("en")} calls a month on the models in use` : ctx.recsPending ? "Working it out..." : "No cheaper AI model is proven yet, or we need more checked answers"} />
    </div>
  );
}

/** Subscription and both: the same numbers, but usage instead of a bill and ways to make an allowance last. */
function AllowanceKpis({ ctx }: { ctx: Ctx }) {
  const { cur, prev, days } = ctx;
  const curDone = ctx.curDone ?? cur;
  const prevDone = ctx.prevDone ?? prev;
  const both = ctx.billing === "both";
  const spend = sum(cur, "spend_usd");
  const unpriced = unpricedRuns(cur);
  const t = totals(cur);
  const runs = sum(cur, "runs");
  const runsPrev = sum(prev, "runs");
  const rate = passRate(cur);
  const a = useAllowanceWays(days, cur, ctx.byJob);
  const recs = [...ctx.byJob.values()];
  const saving = recs.reduce((s, r) => s + monthlySaving(r), 0);
  const movable = recs.filter((r) => monthlySaving(r) > 0).length;
  return (
    <div className="flex flex-col gap-3">
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Kpi index={0} label="Usage" icon={<IconBolt size={16} />} tint="var(--series-1)" value={t.all} render={(v) => <CountUp value={v} />} change={delta(totals(curDone).all, totals(prevDone).all)} upIsGood={false} help="How much AI your app used in this period, counted in tokens (the small pieces of text AI is billed by) and AI calls. This is measured from your recorded calls." note={<>{`tokens in ${count(runs)} AI calls`}<br />{`Worth about ${usd(spend)} at list prices. You pay a flat fee, so this is not your bill.`}{unpriced > 0 && ownsUnpriced(ctx, "kpis") && <><br /><UnpricedChip count={unpriced} /></>}</>} />
        <Kpi index={1} label="Correct answers" icon={<IconCheck size={16} />} tint="var(--series-3)" value={rate} render={(v) => <CountUp value={v * 100} suffix="%" decimals={1} />} change={passRate(curDone) !== null && passRate(prevDone) !== null ? passRate(curDone)! - passRate(prevDone)! : null} upIsGood help="We check an answer against the right answer or a rule you set. Out of every 100 answers we checked, this is how many were right. Answers nobody checked are not counted." note={rate === null ? (runs === 0 ? "No AI calls yet. They will show here once your app sends one." : "None of your AI calls are checked yet, so we cannot say how many are correct.") : `Out of every 100 answers we checked, about ${Math.round(rate * 100)} were right`} />
        <Kpi index={2} label="AI calls recorded" icon={<IconJobs size={16} />} tint="var(--series-7)" value={runs} render={(v) => <CountUp value={v} />} change={delta(sum(curDone, "runs"), sum(prevDone, "runs"))} upIsGood note={`Times your app asked an AI, vs. ${count(runsPrev)} the ${days} days before`} />
        <Kpi index={3} label="Ways to make your allowance last longer" icon={<IconSpark size={16} />} tint="var(--color-ok)" value={a.pending ? null : a.ways.length} render={(v) => <CountUp value={v} />} change={undefined} upIsGood help="Things we measured in your own calls that may use less of your allowance, such as text repeated at the start of every prompt or a large tool list. They are ideas, not promises, and none is a dollar saving." note={a.pending ? "Working it out..." : a.ways.length > 0 ? "Measured in your own calls. See the card below." : a.calls < MIN_CALLS ? "We need more AI calls before we can say" : "Nothing stands out in your calls"} />
      </div>
      {both && (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <Kpi index={4} label="Spend if paid per use" icon={<IconDollar size={16} />} tint="var(--series-1)" value={spend} render={(v) => <CountUp value={v} prefix="$" decimals={v < 100 ? 2 : 0} />} change={delta(sum(curDone, "spend_usd"), sum(prevDone, "spend_usd"))} upIsGood={false} help="What these calls would cost at list prices if every one were paid per use." note="At list prices, for all calls" />
          <Kpi index={5} label="Saving available if paid per use" icon={<IconSpark size={16} />} tint="var(--color-ok)" value={ctx.recsPending ? null : saving} render={(v) => <CountUp value={v} prefix="$" decimals={v < 100 ? 2 : 0} suffix="/mo" />} change={undefined} upIsGood help="What you would save each month on calls paid per use by moving an AI task to a cheaper model that still gives about as many correct answers. An estimate from your own past calls." note={movable ? `Each month, if ${movable} ${movable === 1 ? "AI task moves" : "AI tasks move"} to a cheaper AI model, based on ${savingVolume(recs).toLocaleString("en")} calls a month on the models in use` : ctx.recsPending ? "Working it out..." : "No cheaper AI model is proven yet"} />
        </div>
      )}
    </div>
  );
}

/** The measured ways, as a list. Never blank: thin data gets a plain explanation. Shows the top two; the rest on request. */
function AllowanceList({ ctx, compact }: { ctx: Ctx; compact?: boolean }) {
  const a = useAllowanceWays(ctx.days, ctx.cur, ctx.byJob);
  const [all, setAll] = useState(false);
  if (a.pending) return <Skeleton className="mt-4 h-24 w-full" />;
  if (a.calls === 0) return <div className="mt-4"><NoCallsYet /></div>;
  if (a.calls < MIN_CALLS) return <div className="mt-4"><NotEnoughData n={a.calls} min={MIN_CALLS} what="AI calls">Next step: keep using your app. Once there are enough calls we show what is using your allowance.</NotEnoughData></div>;
  if (a.ways.length === 0) return <p className="mt-4 text-[15px] text-dim">Nothing in your calls stands out as using your allowance without need. We keep measuring as new calls arrive.</p>;
  const shown = all ? a.ways : a.ways.slice(0, 2);
  return (
    <>
      <ul className={cx("mt-4 grid gap-3", !compact && "md:grid-cols-2")}>
        {shown.map((w) => (
          <li key={w.id} className="rounded-[12px] border border-rule bg-surface-2 p-4 text-[13px]">
            <p className="font-semibold text-ink">{w.title}</p>
            <p className="mt-1 text-dim">{w.text}</p>
            {!w.measured && <p className="mt-1.5 text-[11px] text-muted">An idea, not a measured saving.</p>}
          </li>
        ))}
      </ul>
      {a.ways.length > 2 && (
        <button type="button" onClick={() => setAll((v) => !v)} className="mt-3 self-start text-sm font-semibold text-accent-ink hover:underline">
          {all ? "Show fewer ideas" : `Show ${a.ways.length - 2} more ${a.ways.length - 2 === 1 ? "idea" : "ideas"}`}
        </button>
      )}
    </>
  );
}

/** Subscription: the recommendation card becomes ways to make the allowance last, built only from measured facts. */
function AllowancePanel({ ctx, labelled, compact }: { ctx: Ctx; labelled?: string; compact?: boolean }) {
  const p = useP();
  const H = useContext(CardLevel) === 3 ? "h3" : "h2";
  return (
    <Panel glow fill className="relative flex flex-col overflow-hidden p-5 md:p-6">
      <div aria-hidden className="pointer-events-none absolute -right-16 -top-24 h-72 w-72 rounded-full bg-accent-2/15 blur-3xl" />
      <div className={cx("relative flex flex-col gap-2", !compact && "lg:flex-row lg:items-end lg:justify-between")}>
        <div className="min-w-0">
          <p className="flex items-center gap-2 text-[12px] font-semibold uppercase tracking-[0.18em] text-muted"><IconSpark size={14} className="text-accent" /> {labelled ?? "Our ideas"}</p>
          <H className={cx("mt-2 flex flex-wrap items-center gap-x-2 font-semibold leading-[1.1] tracking-tight", compact ? "text-[24px]" : "text-[24px] md:text-[30px]")}>
            <span>Ways to make your <span className="text-gradient">allowance last longer</span></span>
            <Help>You pay a flat fee, so these are about using less of your allowance, not about saving money. Each one is measured in your own calls and shown as a share or a number of tokens.</Help>
          </H>
          <p className="mt-2 max-w-2xl text-[14px] text-dim">These save allowance, not money. Ideas, not promises.</p>
        </div>
        {!compact && <ButtonLink to={p("/jobs")} variant="primary" className="shrink-0">See every AI task <IconArrowRight size={16} /></ButtonLink>}
      </div>
      <AllowanceList ctx={ctx} compact={compact} />
      {compact && <div className="relative mt-auto pt-5"><ButtonLink to={p("/jobs")} variant="primary">See every AI task <IconArrowRight size={16} /></ButtonLink></div>}
    </Panel>
  );
}

/* ----------------------------------------------------------------------------------------------- */
/* What you could save                                                                              */

/** The "next step" banner: what you could save per month (ways to use less of the allowance for a subscription). */
export function Savings({ ctx }: { ctx: Ctx }) {
  if (ctx.billing === "subscription") return <AllowancePanel ctx={ctx} />;
  if (ctx.billing === "both") {
    return (
      <div className="grid gap-4 lg:grid-cols-2">
        <SavingsPanel ctx={ctx} label="If you pay per use" compact />
        <AllowancePanel ctx={ctx} labelled="If you pay a subscription" compact />
      </div>
    );
  }
  return <SavingsPanel ctx={ctx} />;
}

function SavingsPanel({ ctx, label, compact }: { ctx: Ctx; label?: string; compact?: boolean }) {
  const p = useP();
  const H = useContext(CardLevel) === 3 ? "h3" : "h2";
  const recs = [...ctx.byJob.values()];
  const saving = recs.reduce((s, r) => s + monthlySaving(r), 0);
  const movable = recs.filter((r) => r && (r.verdict === "DOWNGRADE" || r.verdict === "SWITCH")).length;
  const jobs = ctx.jobs?.length ?? 0;
  const volume = savingVolume(recs);
  const someone = movable === 1 ? "One AI task" : `${movable} AI tasks`;
  return (
    <Panel glow fill className="relative flex flex-col overflow-hidden p-5 md:p-6">
      <div aria-hidden className="pointer-events-none absolute -right-16 -top-24 h-72 w-72 rounded-full bg-accent-2/15 blur-3xl" />
      <div className={cx("relative flex flex-col gap-4", !compact && "lg:flex-row lg:items-end lg:justify-between")}>
        <div className="min-w-0">
          <p className="flex items-center gap-2 text-[12px] font-semibold uppercase tracking-[0.18em] text-muted"><IconSpark size={14} className="text-accent" /> {label ?? "Our recommendation"}</p>
          {ctx.jobsPending || ctx.recsPending ? (
            <Skeleton className="mt-4 h-12 w-80" />
          ) : (
            <>
              <H className={cx("mt-2 flex flex-wrap items-center gap-x-2 font-semibold leading-[1.1] tracking-tight", compact ? "text-[24px]" : "text-[28px] md:text-[36px]")}>
                <span>
                  {saving > 0 ? (
                    <>You could save about <span className="text-gradient"><CountUp value={saving} prefix="$" decimals={saving < 100 ? 2 : 0} /></span><span className="text-dim"> a month (an estimate)</span></>
                  ) : movable > 0 ? (
                    <>{someone} can run on <span className="text-gradient">a cheaper model</span></>
                  ) : jobs === 0 ? (
                    "Start recording AI calls"
                  ) : (
                    <>Every AI task is on <span className="text-gradient">the right model</span></>
                  )}
                </span>
                {movable > 0 && <Help>{`${someone} can move to a cheaper model that gives about as many correct answers (within 3 points), checked on your own past AI calls.${saving > 0 ? ` The saving is worked out from ${volume.toLocaleString("en")} calls a month on the models in use now.` : ""} An AI task is one kind of work your app asks an AI to do, like reading invoices or sorting support tickets.`}</Help>}
              </H>
              <p className="mt-2 max-w-2xl text-[14px] text-dim">
                {movable > 0
                  ? `${someone} can move to a cheaper model. Nothing changes unless you decide.`
                  : jobs === 0
                    ? "Send each AI call through our SDK. We check every answer and tell you the cheapest model that still does the job."
                    : "No cheaper model has been shown to do these AI tasks as well yet. We keep checking."}
              </p>
              {movable > 0 && saving > 0 && volume > 0 && <p className="mt-2"><span className="inline-flex rounded-full bg-surface-3 px-2 py-0.5 text-[11px] font-medium text-muted">Based on {volume.toLocaleString("en")} calls a month</span></p>}
            </>
          )}
        </div>
        {!compact && <ButtonLink to={p("/jobs")} variant="primary" className="shrink-0">See every AI task <IconArrowRight size={16} /></ButtonLink>}
      </div>
      {compact && <div className="relative mt-auto pt-5"><ButtonLink to={p("/jobs")} variant="primary">See every AI task <IconArrowRight size={16} /></ButtonLink></div>}
    </Panel>
  );
}

/* ----------------------------------------------------------------------------------------------- */
/* This period against the last                                                                     */

export function SpendTrend({ ctx, shell }: { ctx: Ctx; shell: ShellProps }) {
  const sub = ctx.billing === "subscription";
  const [metric, setMetric] = useState<"spend_usd" | "runs">(sub ? "runs" : "spend_usd");
  const rows = compareSeries(ctx.points, ctx.days, metric);
  const total = sum(ctx.cur, metric);
  const before = sum(ctx.prev, metric);
  const fmt = metric === "spend_usd" ? (v: number) => usd(v, { compact: true }) : (v: number) => count(Math.round(v));
  return (
    <Shell
      shell={shell}
      title={metric === "spend_usd" ? (sub ? "Worth at list prices" : "Spend") : "AI calls"}
      hint={`${metric === "spend_usd" ? (sub ? "What your calls are worth at list prices each day. You pay a flat fee, so this is not your bill" : "What your calls cost each day at list prices") : "How many times your app asked an AI each day"}, last ${ctx.days} days. The dashed line is the ${ctx.days} days before.`}
      controls={<Toggle label="Measure" value={metric} onChange={setMetric} options={[["spend_usd", sub ? "List price" : "Spend"], ["runs", "AI calls"]]} />}
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
              <DeltaPill value={delta(sum(ctx.curDone ?? ctx.cur, metric), sum(ctx.prevDone ?? ctx.prev, metric))} upIsGood={metric === "runs"} /> vs. {metric === "spend_usd" ? usd(before) : count(before)}
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

export const TARGETS = [0.8, 0.9, 0.95, 0.99];
export const TARGET_KEY = "mcm_pass_target";

export function readTarget(): number {
  try {
    const v = Number(localStorage.getItem(TARGET_KEY));
    return TARGETS.includes(v) ? v : 0.9;
  } catch {
    return 0.9;
  }
}

export function Gauge({ rate, target }: { rate: number; target: number }) {
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
  const calls = sum(ctx.cur, "runs");
  const floor = floorOf(ctx.byJob);
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
      hint={checked === 0 ? "No checked answers yet. Once some are checked, this shows how many were right. The target is your own goal." : `Out of every 100 answers we checked, about ${rate === null ? "..." : Math.round(rate * 100)} were right (${count(checked)} checked in the last ${ctx.days} days). The target is your own goal.`}
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
      ) : calls === 0 ? (
        <NoCallsYet to={p("/jobs")} />
      ) : checked === 0 ? (
        <NoneChecked to={p("/jobs")} />
      ) : rate === null || checked < floor ? (
        <NotEnoughData n={checked} min={floor} />
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
  const sub = ctx.billing === "subscription";
  const [metric, setMetric] = useState<"spend_usd" | "runs">(sub ? "runs" : "spend_usd");
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
      title={sub || metric === "runs" ? "Where your usage goes" : undefined}
      hint={`Biggest ${by === "job" ? "AI tasks" : "models"} by ${metric === "spend_usd" ? (sub ? "list price (not your bill)" : "spending") : "AI calls"}, last ${ctx.days} days`}
      controls={
        <>
          <Toggle label="Split by" value={by} onChange={setBy} options={[["job", "AI task"], ["model", "Model"]]} />
          <Toggle label="Measure" value={metric} onChange={setMetric} options={[["spend_usd", ctx.billing === "subscription" || ctx.billing === "both" ? "List price" : "$"], ["runs", "AI calls"]]} />
        </>
      }
    >
      {ctx.dailyPending ? (
        <Skeleton className="h-28" />
      ) : total === 0 ? (
        <EmptyState title={metric === "spend_usd" ? "No spend in this period" : "No AI calls in this period"} hint="It appears here as soon as your app makes AI calls through our SDK." />
      ) : (
        <div className="flex flex-1 flex-col justify-center rounded-[14px] border border-rule p-4">
          <div className="flex flex-wrap gap-y-4 lg:flex-nowrap">
            {parts.map((part, i) => {
              const color = "other" in part ? "var(--series-other)" : colors.get(part.name) ?? SERIES[i];
              return (
                <div key={part.name} className="flex min-w-[110px] flex-col" style={{ flexGrow: Math.max(part.value / total, 0.12), flexBasis: 0 }}>
                  <div className="flex flex-1 flex-col border-l-2 pl-3 pr-2" style={{ borderColor: color }}>
                    <p className="flex items-center gap-1.5 text-[22px] font-semibold leading-tight text-ink tabular">
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
      const mineDone = (ctx.curDone ?? ctx.cur).filter((x) => x.job === job.name);
      const before = (ctx.prevDone ?? ctx.prev).filter((x) => x.job === job.name);
      const spend = sum(mine, "spend_usd");
      return { job, runs: sum(mine, "runs"), spend, change: delta(sum(mineDone, "spend_usd"), sum(before, "spend_usd")), rec: ctx.byJob.get(job.name) ?? null };
    })
    .map((r) => ({ ...r, rate: passRateInUse(r.rec) }))
    .sort((a, b) => b.spend - a.spend || b.runs - a.runs);
  return (
    <Shell shell={shell} hint={`${ctx.billing === "subscription" ? "List price (not your bill)" : "Spend"} and our advice for each AI task, last ${ctx.days} days`} controls={<Link to={p("/jobs")} className="text-[13px] font-semibold text-accent-ink hover:underline">All AI tasks →</Link>}>
      {ctx.jobsPending ? (
        <Skeleton className="h-48" />
      ) : jobs.length === 0 ? (
        <EmptyState icon={<IconJobs size={18} />} title="No AI tasks yet" hint="An AI task is one kind of work your app asks an AI to do. Create one, then send its calls through our SDK." action={<ButtonLink to={p("/jobs")} variant="primary">Create an AI task</ButtonLink>} />
      ) : (
        <div className="-mx-5 overflow-x-auto">
          <table className="w-full min-w-[780px] text-sm">
            <thead>
              <tr className="whitespace-nowrap text-left text-[11px] font-semibold uppercase tracking-wider text-muted">
                <th className="min-w-[230px] px-5 pb-2 font-semibold">AI task</th>
                <th className="pb-2 pl-4 text-right font-semibold">AI calls</th>
                <th className="pb-2 pl-4 text-right font-semibold">{ctx.billing === "subscription" ? "List price" : "Spend"}</th>
                <th className="pb-2 pl-4 font-semibold">{ctx.billing === "subscription" ? "List price change" : "Spend change"}</th>
                <th className="pb-2 pl-4 text-right font-semibold" title="Share of checked answers that were right, for the model this AI task uses now">Correct answers</th>
                <th className="pb-2 pl-4 pr-5 text-right font-semibold">Our recommendation</th>
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
                      <span className="ml-2 inline-block whitespace-nowrap rounded bg-surface-3 px-1.5 py-0.5 align-middle font-mono text-[10.5px] text-muted" title="The name used in your code">{r.job.name}</span>
                      {r.rec?.current?.model && <p className="mt-0.5 text-xs text-muted"><ModelName className="text-muted">{r.rec.current.model}</ModelName></p>}
                    </td>
                    <td className="py-3 pl-4 text-right text-dim tabular">{count(r.runs)}</td>
                    <td className="whitespace-nowrap py-3 pl-4 text-right font-semibold text-ink tabular">{usd(r.spend)}</td>
                    <td className="whitespace-nowrap py-3 pl-4">
                      <span className={cx("inline-flex items-center gap-1.5 text-xs font-semibold tabular", up ? "text-bad" : down ? "text-ok" : "text-muted")}>
                        <span className={cx("grid h-4 w-4 place-items-center rounded-full border text-[9px]", up ? "border-bad" : down ? "border-ok" : "border-rule-strong")}>{up ? "↑" : down ? "↓" : "–"}</span>
                        {r.change === null ? "new" : `${Math.abs(r.change * 100).toFixed(0)}%`}
                      </span>
                    </td>
                    <td className="py-3 pl-4 text-right text-dim tabular">{pct(r.rate)}</td>
                    <td className="whitespace-nowrap py-3 pl-4 pr-5 text-right">{r.rec ? <VerdictPill verdict={r.rec.verdict as Verdict} rec={r.rec} /> : <Pill tone="neutral">Still learning</Pill>}</td>
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
  const { mode } = useBillingMode();
  const regressions = useAllRegressions();
  const deprecated = useDeprecatedModels();
  const limits = useLimits();
  const items = [
    ...(regressions.data ?? [])
      .filter((a) => a.resolved_at === null)
      .filter((a) => a.kind !== "MODEL_RETIRING" || !(deprecated.data ?? []).some((m) => m.model === a.detail?.model))
      .map((a) => {
        const nk = newKindView(a);
        if (nk) return { key: a.alert_id, tone: nk.tone, icon: nk.icon, title: nk.title, sub: [serverText(a.summary, mode, MONEY_ALERT_FALLBACK), serverText(nk.numbers, mode, null)].filter(Boolean).join(" "), to: p(nk.to) };
        return { key: a.alert_id, tone: "bad" as const, icon: <IconAlert size={16} />, title: serverText(a.summary, mode, MONEY_ALERT_FALLBACK), sub: a.job, to: p(`/jobs/${encodeURIComponent(a.job)}?tab=quality`) };
      }),
    ...(deprecated.data ?? []).map((m) => ({
      key: m.model,
      tone: "warn" as const,
      icon: <IconClock size={16} />,
      ...retiringView(m),
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
    <Shell shell={shell} controls={items.length > 3 ? <Link to={p("/activity")} className="text-[13px] font-semibold text-accent-ink hover:underline">See all {items.length} →</Link> : undefined}>
      {items.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 py-6 text-center">
          <span className="grid h-11 w-11 place-items-center rounded-full bg-ok-soft text-ok"><IconShield size={20} /></span>
          <p className="text-sm font-semibold text-ink">All clear</p>
          <p className="max-w-60 text-xs text-dim">Nothing needs you right now.</p>
        </div>
      ) : (
        <ul className="flex flex-col gap-2">
          {items.slice(0, 3).map((it, i) => (
            <motion.li key={it.key} initial={{ opacity: 0, x: 10 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: 0.05 + i * 0.06 }}>
              <Link to={it.to} className="flex items-start gap-3 rounded-[12px] border border-rule bg-surface-2/50 p-3 transition-colors hover:border-rule-strong">
                <span className={cx("mt-0.5", it.tone === "bad" ? "text-bad" : "text-warn")}>{it.icon}</span>
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium leading-snug text-ink">{it.title}</span>
                  <span className="mt-0.5 line-clamp-2 break-words font-mono text-xs text-muted">{it.sub}</span>
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
