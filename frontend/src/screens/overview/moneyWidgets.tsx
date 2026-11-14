/** Three widgets about what the money is doing: where the month will end against a budget, how much went
 * on wrong answers, and what a good answer costs. All figures are estimates from recorded runs at list
 * prices, and each widget says so. */
import { useEffect, useState, type FormEvent } from "react";
import { motion } from "framer-motion";
import { useProject } from "../../app/project";
import { useDaily } from "../../features/insights/api/dailyApi";
import { CountUp } from "../../shared/motion/CountUp";
import { pct, usd } from "../../ui/format";
import { Button, cx, EmptyState, Skeleton } from "../../ui/primitives";
import { readBudget, writeBudget } from "./budget";
import { monthProjection, unitCosts, wastedSpend } from "./metrics";
import { DeltaPill, Shell, UnpricedChip, type Ctx, type ShellProps } from "./widgets";

const dollars = (v: number) => <CountUp value={v} prefix="$" decimals={v < 100 ? 2 : 0} />;

/* ----------------------------------------------------------------------------------------------- */
/* 1. Month-end projection, with an optional budget                                                 */

const STATUS = {
  ok: { text: "On track", cls: "bg-ok-soft text-ok" },
  close: { text: "Close to your monthly budget", cls: "bg-warn-soft text-warn" },
  over: { text: "Over your monthly budget", cls: "bg-bad-soft text-bad" },
} as const;

export function MonthProjection({ shell }: { shell: ShellProps }) {
  const { id: project } = useProject();
  const daily = useDaily({ days: 40 }); // the month so far, and the 7 days before today
  const [budget, setBudget] = useState<number | null>(() => readBudget(project));
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  useEffect(() => setBudget(readBudget(project)), [project]);

  const p = monthProjection(daily.data ?? [], new Date(), budget);
  const scale = Math.max(budget ?? 0, p.projected, p.mtd, 0.01) * 1.08;
  const save = (e: FormEvent) => {
    e.preventDefault();
    const v = Number(draft);
    if (!Number.isFinite(v) || v <= 0) return;
    writeBudget(project, v);
    setBudget(v);
    setEditing(false);
  };
  const clear = () => {
    writeBudget(project, null);
    setBudget(null);
    setEditing(false);
  };
  const status = p.status === "none" ? null : STATUS[p.status];
  const used80 = p.usedShare !== null && p.usedShare >= 0.8;

  return (
    <Shell shell={shell} title="Where this month's spending is heading" hint={`${p.monthLabel}. An estimate of what you will have spent by month end if the pace holds, so a surprise bill does not catch you out.`}>
      {daily.isPending ? (
        <Skeleton className="h-48" />
      ) : p.mtd === 0 && p.dailyRate === 0 ? (
        <EmptyState title="No spend this month yet" hint="The estimate appears once your app has made AI calls to models with a known price." />
      ) : (
        <div className="flex flex-1 flex-col gap-4">
          <div>
            {p.learning ? (
              <>
                <p className="text-lg font-semibold leading-tight text-ink">Still learning your pace</p>
                <p className="mt-1.5 text-xs text-muted">
                  The month-end estimate appears once there are 7 full days of history. So far this month: {usd(p.mtd)} (day {p.day} of {p.daysInMonth}).
                </p>
              </>
            ) : (
              <>
                <p className="text-[34px] font-semibold leading-none tracking-tight text-ink tabular">{dollars(p.projected)}</p>
                <p className="mt-1.5 text-xs text-muted">
                  likely between {usd(p.low)} and {usd(p.high)} by {p.lastDayLabel} · {usd(p.mtd)} so far (day {p.day} of {p.daysInMonth})
                </p>
              </>
            )}
            {p.unpriced > 0 && <div className="mt-2"><UnpricedChip count={p.unpriced} /></div>}
          </div>

          <div>
            <div className="relative h-3 rounded-full bg-surface-3" role="img" aria-label={`${usd(p.mtd)} spent so far, ${usd(p.projected)} expected by month end${budget ? `, budget ${usd(budget)}` : ""}`}>
              <motion.div className="absolute inset-y-0 left-0 rounded-full bg-accent/30" initial={{ width: 0 }} animate={{ width: `${(p.projected / scale) * 100}%` }} transition={{ duration: 0.9, ease: [0.22, 1, 0.36, 1] }} />
              <motion.div className="absolute inset-y-0 left-0 rounded-full bg-gradient-to-r from-accent to-accent-2" initial={{ width: 0 }} animate={{ width: `${(p.mtd / scale) * 100}%` }} transition={{ duration: 0.9, delay: 0.1, ease: [0.22, 1, 0.36, 1] }} />
              {budget && <span aria-hidden className="absolute -bottom-1.5 -top-1.5 w-0.5 rounded bg-ink" style={{ left: `${(budget / scale) * 100}%` }} />}
            </div>
            <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-muted">
              <li className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-accent" /> Spent so far</li>
              <li className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-accent/30" /> Expected by month end</li>
              {budget && <li className="flex items-center gap-1.5"><span className="h-2.5 w-0.5 rounded bg-ink" /> Budget {usd(budget)}</li>}
            </ul>
          </div>

          {status && (
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <span className={cx("rounded-full px-2.5 py-1 text-[11px] font-semibold", status.cls)}>{status.text}</span>
              <span className="text-dim">
                {p.status === "over"
                  ? `About ${usd(p.overBy)} above ${usd(budget!)} at this pace.`
                  : used80
                    ? `${pct(p.usedShare!, 0)} of your monthly budget is already used.`
                    : `About ${pct(p.projected / budget!, 0)} of your ${usd(budget!)} budget by month end.`}
              </span>
            </div>
          )}

          <div className="mt-auto flex flex-col gap-2 border-t border-rule pt-3">
            {editing || !budget ? (
              <form onSubmit={save} className="flex flex-wrap items-center gap-2">
                <label htmlFor={`budget-${shell.id}`} className="text-xs text-dim">{budget ? "Monthly budget" : "Set a monthly budget"}</label>
                <span className="flex items-center rounded-[9px] border border-rule bg-surface-2 px-2 focus-within:border-accent">
                  <span className="text-sm text-muted">$</span>
                  <input id={`budget-${shell.id}`} inputMode="decimal" value={draft} onChange={(e) => setDraft(e.target.value)} placeholder={budget ? String(budget) : "e.g. 500"} className="w-24 bg-transparent px-1.5 py-1.5 text-sm text-ink outline-none placeholder:text-muted" />
                </span>
                <Button size="sm" variant="primary" type="submit" disabled={!(Number(draft) > 0)}>Save</Button>
                {budget && <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>Cancel</Button>}
              </form>
            ) : (
              <div className="flex items-center gap-3 text-xs text-dim">
                <span>Budget {usd(budget)} a month</span>
                <button type="button" onClick={() => { setDraft(String(budget)); setEditing(true); }} className="font-semibold text-accent-ink hover:underline">Change</button>
                <button type="button" onClick={clear} className="font-semibold text-muted hover:text-bad hover:underline">Remove</button>
              </div>
            )}
            <p className="text-[11px] leading-snug text-muted">
              Days are counted in UTC. How it is worked out: what you have spent this month, plus your average daily spending of the last 7 days for each day left, at list prices. The range uses your cheapest and dearest of those 7 days. Your monthly budget is a note to yourself, kept in this browser. It does not send alerts or stop any spending.
            </p>
          </div>
        </div>
      )}
    </Shell>
  );
}

/* ----------------------------------------------------------------------------------------------- */
/* 2. Paid for wrong answers                                                                        */

export function WastedSpend({ ctx, shell }: { ctx: Ctx; shell: ShellProps }) {
  const w = wastedSpend(ctx.cur);
  const worst = w.byJob[0]?.wasted ?? 0;
  return (
    <Shell shell={shell} title="Money spent on wrong answers" hint={`Last ${ctx.days} days${w.estimated ? ", estimated" : ""}. An AI call still costs money when its answer turns out wrong, so this is money that bought you nothing.`}>
      {ctx.dailyPending ? (
        <Skeleton className="h-44" />
      ) : w.spend === 0 ? (
        <EmptyState title="No spend in this period" hint="It appears here as soon as AI calls to models with a known price are recorded." />
      ) : (
        <div className="flex flex-1 flex-col gap-4">
          <div>
            <p className={cx("text-[34px] font-semibold leading-none tracking-tight tabular", w.wasted > 0 ? "text-ink" : "text-ok")}>{dollars(w.wasted)}</p>
            <p className="mt-1.5 flex flex-wrap items-center gap-1.5 text-xs text-muted">
              {w.share !== null && (
                <span className={cx("rounded-full px-2 py-0.5 text-[11px] font-semibold tabular", w.share > 0.05 ? "bg-warn-soft text-warn" : "bg-surface-3 text-muted")}>{pct(w.share)}</span>
              )}
              of {usd(w.spend)} went on {w.failedRuns.toLocaleString("en")} answers that were checked and found wrong
            </p>
            {w.unpriced > 0 && <div className="mt-2"><UnpricedChip count={w.unpriced} /></div>}
          </div>
          {w.byJob.length === 0 ? (
            <p className="text-sm text-ok">Nothing wasted: every checked answer in this period was correct.</p>
          ) : (
            <ul className="flex flex-col gap-2.5">
              {w.byJob.slice(0, 4).map((j, i) => (
                <li key={j.name}>
                  <div className="flex items-baseline justify-between gap-3 text-sm">
                    <span className="truncate font-mono text-[13px] text-ink" title={j.name}>{j.name}</span>
                    <span className="shrink-0 font-semibold text-ink tabular">{usd(j.wasted)}</span>
                  </div>
                  <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-surface-3">
                    <motion.div className="h-full rounded-full bg-warn" initial={{ width: 0 }} animate={{ width: `${(j.wasted / worst) * 100}%` }} transition={{ delay: 0.1 + i * 0.08, duration: 0.7, ease: [0.22, 1, 0.36, 1] }} />
                  </div>
                </li>
              ))}
            </ul>
          )}
          <p className="mt-auto border-t border-rule pt-3 text-[11px] leading-snug text-muted">
            {w.estimated
              ? "How it is estimated: each AI task's spend for a day is split by its share of wrong answers, so a wrong answer is counted at the average cost of that task's AI calls that day."
              : "Added up from what each wrong answer actually cost. A wrong answer may still have been a useful call, for example while testing a model."}
          </p>
        </div>
      )}
    </Shell>
  );
}

/* ----------------------------------------------------------------------------------------------- */
/* 4. What 1,000 good answers cost                                                                  */

export function UnitCost({ ctx, shell }: { ctx: Ctx; shell: ShellProps }) {
  const { all, jobs } = unitCosts(ctx.cur, ctx.prev);
  const max = Math.max(...jobs.map((j) => j.per1k ?? 0), 0.0001);
  return (
    <Shell shell={shell} title="What 1,000 correct answers cost you" hint={`Spending divided by correct answers, last ${ctx.days} days. A cheap model that is often wrong can cost more per correct answer, so this is the fair way to compare.`}>
      {ctx.dailyPending ? (
        <Skeleton className="h-44" />
      ) : jobs.length === 0 ? (
        <EmptyState title="No AI calls in this period" hint="The cost of each AI task appears once its AI calls are recorded and their answers checked." />
      ) : (
        <div className="flex flex-1 flex-col gap-4">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <p className="text-[34px] font-semibold leading-none tracking-tight text-ink tabular">{all.per1k === null ? "–" : dollars(all.per1k)}</p>
              <p className="mt-1.5 text-xs text-muted">across all AI tasks, per 1,000 correct answers</p>
              {all.unpriced > 0 && <div className="mt-2"><UnpricedChip count={all.unpriced} /></div>}
            </div>
            {all.change !== null && <DeltaPill value={all.change} upIsGood={false} />}
          </div>
          <ul className="flex flex-col gap-3">
            {jobs.map((j, i) => (
              <li key={j.job} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-1">
                <span className="truncate font-mono text-[13px] text-ink" title={j.job}>{j.job}</span>
                <span className="flex items-center justify-end gap-2 text-sm font-semibold text-ink tabular">
                  {j.per1k === null ? <span className="text-bad">No correct answers</span> : usd(j.per1k)}
                  {j.change !== null && <DeltaPill value={j.change} upIsGood={false} />}
                </span>
                <div className="col-span-2 h-1.5 overflow-hidden rounded-full bg-surface-3">
                  <motion.div className="h-full rounded-full bg-gradient-to-r from-accent to-accent-2" initial={{ width: 0 }} animate={{ width: `${j.per1k === null ? 0 : (j.per1k / max) * 100}%` }} transition={{ delay: 0.1 + i * 0.08, duration: 0.7, ease: [0.22, 1, 0.36, 1] }} />
                </div>
              </li>
            ))}
          </ul>
          <p className="mt-auto border-t border-rule pt-3 text-[11px] leading-snug text-muted">
            Spending includes calls that were never checked. Wrong answers count against a model: one that is cheap per call but often wrong costs more per correct answer. The change is against the period before.
          </p>
        </div>
      )}
    </Shell>
  );
}
