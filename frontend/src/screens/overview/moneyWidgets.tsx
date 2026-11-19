/** Three widgets about what the money is doing: where the month will end against a budget, how much went
 * on wrong answers, and what a good answer costs. All figures are estimates from recorded runs at list
 * prices, and each widget says so. */
import { useState, type ReactNode } from "react";
import { motion } from "framer-motion";
import { useMonthlyBudget } from "../../features/projects/hooks/useBudget";
import { isProjection, useProjection, type Projection } from "../../features/insights/api/projectionApi";
import { CountUp } from "../../shared/motion/CountUp";
import { pct, timeAgo, usd } from "../../ui/format";
import { Button, cx, EmptyState, Skeleton } from "../../ui/primitives";
import { useToast } from "../../ui/Toast";
import { BudgetEditor } from "./BudgetEditor";
import { exactUsd } from "./budgetAnalysis";
import { clearBrowserBudget, readBrowserBudget } from "./budget";
import { BUDGET_FIRST_ALERT, sum, unitCosts, wastedSpend } from "./metrics";
import { DeltaPill, ownsUnpriced, Shell, UnpricedChip, type Ctx, type ShellProps } from "./widgets";

const dollars = (v: number) => <CountUp value={v} prefix="$" decimals={v < 100 ? 2 : 0} />;

/* ----------------------------------------------------------------------------------------------- */
/* 1. Month-end projection, with an optional budget                                                 */

/** How the month-end estimate is worked out: shown behind a "?" wherever the estimate appears. */
export const FORECAST_HELP = "Spent so far is a fact: recorded calls at list prices, in US dollars. The forecast adds, for each day left, your spend per day over the last 7 full days; the range uses your lowest and highest of those days. There is no forecast until 7 full days have passed since your first priced call and at least 5 of the last 7 days had spend, and it pauses if no call is recorded for 48 hours. Days are counted in your project's timezone. Calls with no known price are not counted, and the newest calls or provider billing delays can be missing.";

/** "1 Nov" or "30 Nov 2026" for an ISO date that is already in the project's own timezone. */
const dayLabel = (iso: string, year = false) =>
  new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", ...(year ? { year: "numeric" } : {}), timeZone: "UTC" });

const NO_FORECAST: Record<string, (p: Projection) => string> = {
  too_new: (p) => `Needs 7 full days since your first priced call. You have ${p.history_days}.`,
  sparse: (p) => `Spend on only ${p.active_days} of the last 7 days. It needs at least 5, so the pace is not reliable yet.`,
  no_recent_calls: (p) => `No call has been recorded since ${p.data_through ? timeAgo(p.data_through) : "a while"}, so the recent pace would be wrong.`,
};

/** How the forecast range sits against the monthly limit. The rule is the server's: "over" needs even the LOW end above it. */
function limitStatus(p: Projection, budget: number | null) {
  if (!budget) return null;
  const used = p.actual_usd / budget;
  if (used >= 1) return { cls: "bg-bad-soft text-bad", chip: "Over your monthly limit", text: `${usd(p.actual_usd)} is already spent against your ${usd(budget)} limit.` };
  if (p.state === "ok" && p.projected_low_usd! > budget) return { cls: "bg-bad-soft text-bad", chip: "Forecast over your limit", text: `Even the low end of the forecast (${usd(p.projected_low_usd!)}) is above ${usd(budget)}.` };
  if (p.state === "ok" && p.projected_high_usd! > budget) return { cls: "bg-warn-soft text-warn", chip: "Forecast may go over", text: `The high end (${usd(p.projected_high_usd!)}) is above your ${usd(budget)} limit. The low end is not.` };
  if (used >= BUDGET_FIRST_ALERT) return { cls: "bg-warn-soft text-warn", chip: "Close to your monthly limit", text: `${pct(used, 0)} of your limit is already spent${used >= 0.95 ? ", past our 95% warning" : ""}.` };
  if (p.state === "ok") return { cls: "bg-ok-soft text-ok", chip: "On track", text: `The whole forecast range is below your ${usd(budget)} limit.` };
  return { cls: "bg-surface-3 text-muted", chip: "No forecast yet", text: `So we cannot say yet whether you will stay within ${usd(budget)}.` };
}

/** This month's spend so far and its forecast, kept apart, with the optional budget. `embedded` gives just the content, for use inside another card. */
export function MonthProjection({ shell, ctx, embedded }: { shell: ShellProps; ctx?: Pick<Ctx, "unpricedOwner">; embedded?: boolean }) {
  const account = useMonthlyBudget();
  const { projectId } = account;
  const query = useProjection();
  const p = isProjection(query.data) ? query.data : null;
  const budget = account.budget;
  const toast = useToast();
  const [problem, setProblem] = useState<string | null>(null);
  const [moved, setMoved] = useState(false);
  // A limit an earlier version kept in this browser: offered once if the account has none.
  const browserBudget = account.canEdit && account.ready && budget === null && !moved ? readBrowserBudget(projectId) : null;

  const scale = Math.max(budget ?? 0, p?.projected_likely_usd ?? 0, p?.actual_usd ?? 0, 0.01) * 1.08;
  const moveToAccount = async () => {
    if (browserBudget === null) return;
    setProblem(null);
    const err = await account.save(browserBudget);
    if (err) return setProblem(err);
    clearBrowserBudget(projectId);
    setMoved(true);
    toast({ message: `Limit set to ${exactUsd(browserBudget)}` });
  };
  const status = p ? limitStatus(p, budget) : null;

  const wrap = (children: ReactNode) =>
    embedded ? (
      <div className="flex flex-col gap-3">{children}</div>
    ) : (
      <Shell shell={shell} help={FORECAST_HELP} title="Where this month's spending is heading" hint={p ? `${dayLabel(p.first_day)} to ${dayLabel(p.last_day, true)} (${p.timezone})` : "This month"}>
        {children}
      </Shell>
    );
  return wrap(
    <>
      {query.isPending ? (
        <Skeleton className={embedded ? "h-16" : "h-48"} />
      ) : !p ? (
        <p className="text-sm text-dim" role="alert">Could not load this month's figures. Try again in a moment.</p>
      ) : p.state === "no_spend" ? (
        <EmptyState title="No spend this month yet" hint="The forecast appears after your app sends AI calls to a model with a known price. Start by creating an AI task and sending a call." />
      ) : (
        <div className="flex flex-1 flex-col gap-3">
          <div data-testid="actual">
            <p className="text-xs font-medium text-muted">Spent so far this month</p>
            <p className={cx("font-semibold leading-none tracking-tight text-ink tabular", embedded ? "mt-1 text-[22px]" : "mt-1 text-[34px]")}>{dollars(p.actual_usd)}</p>
            <p className="mt-1.5 text-xs text-muted">
              recorded calls at list prices, in US dollars · day {p.day_of_month} of {p.days_in_month} · counted in {p.timezone}
            </p>
            {p.unpriced_runs > 0 && (!ctx || ownsUnpriced(ctx, "projection")) && <div className="mt-2"><UnpricedChip count={p.unpriced_runs} /></div>}
          </div>

          <div className="rounded-[10px] border border-rule bg-surface-2/50 p-3" data-testid="forecast">
            {p.state === "ok" ? (
              <>
                <p className="flex flex-wrap items-baseline gap-x-2 text-xs font-medium text-muted">
                  Forecast for {dayLabel(p.last_day)}
                  <span className="rounded-full bg-surface-3 px-2 py-0.5 text-[11px] font-medium text-muted">estimate</span>
                </p>
                <p className="mt-1 text-lg font-semibold leading-tight text-ink tabular">{usd(p.projected_low_usd)} to {usd(p.projected_high_usd)}</p>
                <p className="mt-0.5 text-xs text-muted">likely {usd(p.projected_likely_usd)}, from your last 7 full days. Not spend that has happened.</p>
              </>
            ) : (
              <>
                <p className="text-sm font-semibold text-ink">{p.state === "paused" ? "Forecast paused" : "No forecast yet"}</p>
                <p className="mt-0.5 text-xs text-muted" data-testid="why-no-forecast">{p.reason ? NO_FORECAST[p.reason](p) : ""}</p>
              </>
            )}
          </div>

          <div>
            <div className="relative h-3 rounded-full bg-surface-3" role="img" aria-label={`${usd(p.actual_usd)} spent so far${p.state === "ok" ? `, ${usd(p.projected_low_usd)} to ${usd(p.projected_high_usd)} forecast by month end` : ", no forecast yet"}${budget ? `, limit ${usd(budget)}` : ""}`}>
              {p.state === "ok" && (
                <motion.div className="absolute inset-y-0 left-0 rounded-full bg-accent/30" initial={{ width: 0 }} animate={{ width: `${(p.projected_likely_usd! / scale) * 100}%` }} transition={{ duration: 0.9, ease: [0.22, 1, 0.36, 1] }} />
              )}
              <motion.div className="absolute inset-y-0 left-0 rounded-full bg-gradient-to-r from-accent to-accent-2" initial={{ width: 0 }} animate={{ width: `${(p.actual_usd / scale) * 100}%` }} transition={{ duration: 0.9, delay: 0.1, ease: [0.22, 1, 0.36, 1] }} />
              {budget && <span aria-hidden className="absolute -bottom-1.5 -top-1.5 w-0.5 rounded bg-ink" style={{ left: `${(budget / scale) * 100}%` }} />}
            </div>
          </div>

          {status && (
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <span className={cx("rounded-full px-2.5 py-1 text-[11px] font-semibold", status.cls)}>{status.chip}</span>
              <span className="text-dim">{status.text}</span>
            </div>
          )}

          <p className="text-[11px] text-muted" data-testid="data-through">
            {p.data_through ? `Data through ${timeAgo(p.data_through)}. ` : ""}The newest calls, and any delay on your provider's own billing, can be missing.
          </p>

          <div className="mt-auto flex flex-col gap-2 border-t border-rule pt-3">
            {!account.canEdit ? (
              budget ? <p className="text-xs text-dim">Limit {usd(budget)} a month</p> : null
            ) : browserBudget !== null ? (
              <div className="flex flex-wrap items-center gap-2 text-xs text-dim">
                <span>Saved in this browser only. Save it to your account?</span>
                <span className="font-semibold text-ink">{usd(browserBudget)} a month</span>
                <Button size="sm" variant="primary" onClick={moveToAccount} disabled={account.saving}>Save to my account</Button>
                {problem && <span role="alert" className="basis-full text-[11px] text-bad">{problem}</span>}
              </div>
            ) : (
              <BudgetEditor id={`budget-${shell.id}`} />
            )}
          </div>
        </div>
      )}
    </>,
  );
}

/* ----------------------------------------------------------------------------------------------- */
/* 2. Paid for wrong answers                                                                        */

export function WastedSpend({ ctx, shell }: { ctx: Ctx; shell: ShellProps }) {
  const w = wastedSpend(ctx.cur);
  const worst = w.byJob[0]?.wasted ?? 0;
  const how = w.estimated
    ? "How it is estimated: each AI task's spend for a day is split by its share of wrong answers, so a wrong answer is counted at the average cost of that task's AI calls that day."
    : "Added up from what each wrong answer actually cost. A wrong answer may still have been a useful call, for example while testing a model.";
  return (
    <Shell shell={shell} help={`When an answer fails its check you still pay for the call. We add up those costs. A failed check can be a deliberate test, so this is not called wasted. ${how}`} title="Spend on answers that failed their check" hint={`Last ${ctx.days} days${w.estimated ? ", estimated" : ""}`}>
      {ctx.dailyPending ? (
        <Skeleton className="h-44" />
      ) : w.spend === 0 ? (
        <EmptyState title="No spend yet" hint="This fills in when your app sends AI calls to a model with a known price. Start by creating an AI task and sending a call from your code." />
      ) : (
        <div className="flex flex-1 flex-col gap-4">
          <div>
            <p className={cx("text-[34px] font-semibold leading-none tracking-tight tabular", w.wasted > 0 ? "text-ink" : "text-ok")}>{dollars(w.wasted)}</p>
            <p className="mt-1.5 flex flex-wrap items-center gap-1.5 text-xs text-muted">
              {w.share !== null && (
                <span className={cx("rounded-full px-2 py-0.5 text-[11px] font-semibold tabular", w.share > 0.05 ? "bg-warn-soft text-warn" : "bg-surface-3 text-muted")}>{pct(w.share)}</span>
              )}
              of {usd(w.spend)} went on {w.failedRuns.toLocaleString("en")} answers whose check failed
            </p>
            {w.unpriced > 0 && ownsUnpriced(ctx, "wasted-spend") && <div className="mt-2"><UnpricedChip count={w.unpriced} /></div>}
          </div>
          {w.byJob.length === 0 ? (
            <p className="text-sm text-ok">No failed checks: every checked answer in this period was correct.</p>
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
        </div>
      )}
    </Shell>
  );
}

/* ----------------------------------------------------------------------------------------------- */
/* 4. What 1,000 good answers cost                                                                  */

export function UnitCost({ ctx, shell }: { ctx: Ctx; shell: ShellProps }) {
  const { all, jobs } = unitCosts(ctx.cur, ctx.prev, ctx.curDone, ctx.prevDone);
  const max = Math.max(...jobs.map((j) => j.per1k ?? 0), 0.0001);
  return (
    <Shell shell={shell} help="An estimate: the average cost of a call, divided by the share of checked calls that passed, times 1,000. It assumes calls that were not checked cost about what the checked ones did. Calls with no known price are left out. A cheap model that is often wrong costs more per correct answer, so this is the fair way to compare. The change is against the period before. Open 'How this is worked out' under Spend for the exact version." title="What 1,000 correct answers cost you" hint={`Last ${ctx.days} days`}>
      {ctx.dailyPending ? (
        <Skeleton className="h-44" />
      ) : jobs.length === 0 ? (
        <EmptyState title="No AI calls yet" hint="When your app sends its first call, this fills in. Start by creating an AI task and sending a call from your code." />
      ) : (
        <div className="flex flex-1 flex-col gap-4">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <p className="text-[34px] font-semibold leading-none tracking-tight text-ink tabular">{all.per1k === null ? "–" : dollars(all.per1k)}</p>
              <p className="mt-1.5 text-xs text-muted">across all AI tasks · estimate at list prices</p>
              {(() => {
                const unchecked = Math.max(0, sum(ctx.cur, "runs") - sum(ctx.cur, "passed") - sum(ctx.cur, "failed"));
                return unchecked > 0 ? <p className="mt-0.5 text-[11px] text-muted">{unchecked.toLocaleString("en")} AI calls not checked yet: assumed to cost like the checked ones</p> : null;
              })()}
              {all.unpriced > 0 && ownsUnpriced(ctx, "unit-cost") && <div className="mt-2"><UnpricedChip count={all.unpriced} /></div>}
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
        </div>
      )}
    </Shell>
  );
}
