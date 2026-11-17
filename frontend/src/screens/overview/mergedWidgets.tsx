/** The default overview's merged cards: one for spending (the spend figure, its trend, AI calls and the month-end
 * estimate), one for correct answers (the number and its gauge). Each shows every number the separate cards showed. */
import { useState } from "react";
import { Link } from "react-router-dom";
import { useP } from "../../app/project";
import { CountUp } from "../../shared/motion/CountUp";
import { CompareArea } from "../../ui/charts/charts";
import { count, usd } from "../../ui/format";
import { NoCallsYet, NoneChecked, NotEnoughData } from "../../ui/NotEnoughData";
import { cx, Skeleton } from "../../ui/primitives";
import { FORECAST_HELP, MonthProjection } from "./moneyWidgets";
import { compareSeries, delta, passRate, sum, unpricedRuns } from "./metrics";
import { totals } from "./tokenMetrics";
import { DeltaPill, floorOf, Gauge, ownsUnpriced, readTarget, Shell, TARGET_KEY, TARGETS, UnpricedChip, type Ctx, type ShellProps } from "./widgets";

const chip = "inline-flex rounded-full bg-surface-3 px-2 py-0.5 text-[11px] font-medium text-muted";

/** Spend: what you paid in the period against the one before, AI calls, and the month-end estimate with its budget. */
function SpendCard({ ctx, shell, noMenu, stacked }: { ctx: Ctx; shell: ShellProps; noMenu?: boolean; stacked?: boolean }) {
  const { cur, prev, days } = ctx;
  const spend = sum(cur, "spend_usd");
  const before = sum(prev, "spend_usd");
  const runs = sum(cur, "runs");
  const runsBefore = sum(prev, "runs");
  const unpriced = unpricedRuns(cur);
  const rows = compareSeries(ctx.points, days, "spend_usd");
  const change = delta(sum(ctx.curDone ?? cur, "spend_usd"), sum(ctx.prevDone ?? prev, "spend_usd"));
  const callsChange = delta(sum(ctx.curDone ?? cur, "runs"), sum(ctx.prevDone ?? prev, "runs"));
  return (
    <Shell
      shell={shell}
      noMenu={noMenu}
      title={`Spend, last ${days} days`}
      help={`What your AI calls cost, added up from the list price of each model. Calls to a model with no known price are left out. The dashed line is the ${days} days before. ${FORECAST_HELP}`}
    >
      {ctx.dailyPending ? (
        <Skeleton className="h-52" />
      ) : (
        <div className="flex flex-1 flex-col gap-4">
          <div className={cx("grid gap-5", !stacked && "md:grid-cols-[200px_1fr] md:items-end")}>
            <div>
              <p className="text-[34px] font-semibold leading-none tracking-tight text-ink tabular"><CountUp value={spend} prefix="$" decimals={spend < 100 ? 2 : 0} /></p>
              <p className="mt-2 flex flex-wrap items-center gap-1.5 text-xs text-muted"><DeltaPill value={change} upIsGood={false} /> vs. {usd(before)}</p>
              <p className="mt-3 flex flex-wrap items-center gap-1.5 text-xs text-muted">
                <span className="font-semibold text-ink tabular">{count(runs)}</span> AI calls <DeltaPill value={callsChange} upIsGood /> <span className="sr-only">compared with {count(runsBefore)} before</span>
              </p>
              {unpriced > 0 && ownsUnpriced(ctx, "spend-month") && <p className="mt-2"><UnpricedChip count={unpriced} /></p>}
            </div>
            <CompareArea rows={rows} format={(v) => usd(v, { compact: true })} height={150} />
          </div>
          <div className="border-t border-rule pt-3">
            <MonthProjection shell={shell} embedded />
          </div>
        </div>
      )}
    </Shell>
  );
}

/** A flat fee has no bill: usage in tokens and AI calls, with the list price shown as a worth, never a bill. */
function UsageCard({ ctx, shell, noMenu, stacked }: { ctx: Ctx; shell: ShellProps; noMenu?: boolean; stacked?: boolean }) {
  const { cur, prev, days } = ctx;
  const curDone = ctx.curDone ?? cur;
  const prevDone = ctx.prevDone ?? prev;
  const t = totals(cur);
  const runs = sum(cur, "runs");
  const unpriced = unpricedRuns(cur);
  const rows = compareSeries(ctx.points, days, "runs");
  return (
    <Shell shell={shell} noMenu={noMenu} title={`Usage, last ${days} days`} help="How much AI your app used, counted in tokens (the small pieces of text AI is billed by) and AI calls, measured from your recorded calls. You pay a flat fee, so the list price below is what it would cost per use, not your bill.">
      {ctx.dailyPending ? (
        <Skeleton className="h-40" />
      ) : (
        <div className={cx("grid flex-1 gap-5", stacked ? "grid-rows-[auto_1fr]" : "md:grid-cols-[200px_1fr] md:items-end")}>
          <div>
            <p className="text-[34px] font-semibold leading-none tracking-tight text-ink tabular"><CountUp value={t.all} /> <span className="text-base font-medium text-dim">tokens</span></p>
            <p className="mt-2 flex flex-wrap items-center gap-1.5 text-xs text-muted"><DeltaPill value={delta(totals(curDone).all, totals(prevDone).all)} upIsGood={false} /> vs. before</p>
            <p className="mt-3 flex flex-wrap items-center gap-1.5 text-xs text-muted">
              <span className="font-semibold text-ink tabular">{count(runs)}</span> AI calls <DeltaPill value={delta(sum(curDone, "runs"), sum(prevDone, "runs"))} upIsGood />
            </p>
            <p className="mt-2"><span className={chip}>List price {usd(sum(cur, "spend_usd"))}, not your bill</span></p>
            {unpriced > 0 && ctx.billing === "subscription" && ownsUnpriced(ctx, "spend-month") && <p className="mt-2"><UnpricedChip count={unpriced} /></p>}
          </div>
          {stacked ? <div className="relative min-h-[150px]"><div className="absolute inset-0"><CompareArea rows={rows} format={(v) => count(Math.round(v))} height="100%" /></div></div> : <CompareArea rows={rows} format={(v) => count(Math.round(v))} height={130} />}
        </div>
      )}
    </Shell>
  );
}

/** The spend card: per use shows spending, a subscription shows usage, and "both" shows the two one above the other. */
export function SpendMonth({ ctx, shell }: { ctx: Ctx; shell: ShellProps }) {
  if (ctx.billing === "subscription") return <UsageCard ctx={ctx} shell={shell} />;
  if (ctx.billing === "both") {
    return (
      <div className="grid gap-4 lg:grid-cols-2">
        <SpendCard ctx={ctx} shell={shell} stacked />
        <UsageCard ctx={ctx} shell={shell} noMenu stacked />
      </div>
    );
  }
  return <SpendCard ctx={ctx} shell={shell} />;
}

/** Correct answers: the share that were right, a gauge against your target, the change and how many were checked. */
export function CorrectAnswers({ ctx, shell }: { ctx: Ctx; shell: ShellProps }) {
  const p = useP();
  const [target, setTarget] = useState(readTarget);
  const rate = passRate(ctx.cur);
  const done = passRate(ctx.curDone ?? ctx.cur);
  const donePrev = passRate(ctx.prevDone ?? ctx.prev);
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
      help={`Out of every 100 answers we checked, this is how many were right${rate === null ? "" : ` (about ${Math.round(rate * 100)} in the last ${ctx.days} days)`}. Answers nobody checked are not counted. The target is your own goal.`}
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
        <Skeleton className="h-44" />
      ) : calls === 0 ? (
        <NoCallsYet to={p("/jobs")} />
      ) : checked === 0 ? (
        <NoneChecked to={p("/jobs")} />
      ) : rate === null || checked < floor ? (
        <NotEnoughData n={checked} min={floor} />
      ) : (
        <div className="flex flex-1 flex-col items-center justify-center gap-2">
          <div className="relative w-full max-w-[220px]">
            <Gauge rate={rate} target={target} />
            <p className="absolute inset-x-0 top-[40%] text-center text-[32px] font-semibold leading-none tracking-tight text-ink tabular"><CountUp value={rate * 100} decimals={1} suffix="%" /></p>
          </div>
          <p className="flex flex-wrap items-center justify-center gap-1.5 text-xs text-muted">
            {done !== null && donePrev !== null && <DeltaPill value={done - donePrev} upIsGood />}
            <span className={cx("font-medium", rate >= target ? "text-ok" : "text-warn")}>{rate >= target ? `On track for the ${Math.round(target * 100)}% target` : `${((target - rate) * 100).toFixed(1)} points under the ${Math.round(target * 100)}% target`}</span>
          </p>
          <p className="flex flex-wrap items-center justify-center gap-1.5 text-xs text-muted">
            <span className={chip}>{count(checked)} checked</span>
            <Link to={p("/jobs")} className="font-semibold text-accent-ink hover:underline">Show details</Link>
          </p>
        </div>
      )}
    </Shell>
  );
}
