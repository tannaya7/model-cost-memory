/** Smart budget: where this month is heading, what a monthly limit would mean, and a what-if for a key other people use too.
 *  Everything is an estimate from recorded calls at list prices, never a bill, and a limit only warns, it never blocks. */
import { useId, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useP } from "../app/project";
import { useDaily } from "../features/insights/api/dailyApi";
import { jobTitle } from "../features/jobs/jobTitle";
import { useJobs } from "../features/jobs/hooks/useJobs";
import { useBillingMode } from "../features/projects/hooks/useBillingMode";
import { useMonthlyBudget } from "../features/projects/hooks/useBudget";
import { count, usd } from "../ui/format";
import { EmptyState, ErrorState, Panel, PanelHeader, Reveal, Segmented, Skeleton } from "../ui/primitives";
import { BudgetEditor } from "./overview/BudgetEditor";
import { ESTIMATE_LABEL, HISTORY_DAYS } from "./overview/budgetAnalysis";
import { monthProjection } from "./overview/metrics";
import { LEAN_WORDS, MAX_OTHERS, sharedKeyScenario, type Lean } from "./overview/sharedKey";

const whole = (v: number) => `$${Math.round(v).toLocaleString("en-US")}`;
const dayLabel = (d: Date) => d.toLocaleDateString("en-GB", { day: "numeric", month: "long", timeZone: "UTC" });

function Heading() {
  return (
    <div>
      <h1 className="text-3xl font-semibold tracking-tight">Smart budget</h1>
      <p className="mt-1 max-w-2xl text-sm text-dim">What this month will cost, what a monthly limit would mean, and what changes if other people use your key. {ESTIMATE_LABEL}</p>
    </div>
  );
}

function MonthCard({ task }: { task: string }) {
  const daily = useDaily({ days: HISTORY_DAYS, job: task || undefined });
  const { budget } = useMonthlyBudget();
  const month = useMemo(() => (daily.data ? monthProjection(daily.data, new Date(), budget) : null), [daily.data, budget]);
  if (daily.isPending) return <Skeleton className="h-28" />;
  if (daily.isError) return <ErrorState error={daily.error} onRetry={() => daily.refetch()} />;
  if (!month || (month.mtd === 0 && month.learning)) {
    return <EmptyState title="Nothing to forecast yet" hint="Once your app has sent a week of AI calls, the month's forecast appears here. Until then we show no numbers, so nothing is guessed." />;
  }
  return (
    <div className="grid gap-3 sm:grid-cols-3">
      <div className="rounded-[12px] border border-rule bg-surface-2/50 p-3.5">
        <p className="text-xs text-muted">Spent so far in {month.monthLabel}</p>
        <p className="tabular mt-1 text-2xl font-semibold">{usd(month.mtd)}</p>
      </div>
      <div className="rounded-[12px] border border-rule bg-surface-2/50 p-3.5">
        <p className="text-xs text-muted">Likely by {month.lastDayLabel}</p>
        {month.learning ? (
          <p className="mt-1 text-sm text-dim">Not enough days yet. We need 7 full days of calls before we show a range.</p>
        ) : (
          <p className="tabular mt-1 text-2xl font-semibold">{whole(month.low)} to {whole(month.high)}</p>
        )}
        <p className="mt-1 text-[11px] text-muted">An estimate, from your last 7 days.</p>
      </div>
      <div className="rounded-[12px] border border-rule bg-surface-2/50 p-3.5">
        <p className="text-xs text-muted">Against your limit</p>
        {budget === null ? (
          <p className="mt-1 text-sm text-dim">No limit set. Set one below.</p>
        ) : (
          <p className="tabular mt-1 text-2xl font-semibold">{Math.round((month.usedShare ?? 0) * 100)}% used</p>
        )}
        {budget !== null && !month.learning && (
          <p className="mt-1 text-[11px] text-muted">{month.status === "over" ? "Likely over your limit." : month.status === "close" ? "Close to your limit." : "Likely under your limit."}</p>
        )}
      </div>
    </div>
  );
}

/** "If other people use my key": a scenario, so every input is a plain choice and every result says it is a guess. */
function SharedKey({ task, onTask }: { task: string; onTask: (t: string) => void }) {
  const jobs = useJobs();
  const daily = useDaily({ days: HISTORY_DAYS, job: task || undefined });
  const { budget } = useMonthlyBudget();
  const [others, setOthers] = useState(2);
  const [lean, setLean] = useState<Lean>("same");
  const taskId = useId();
  const othersId = useId();
  const month = useMemo(() => (daily.data ? monthProjection(daily.data, new Date(), budget) : null), [daily.data, budget]);
  const result = month ? sharedKeyScenario(month, others, lean, budget) : null;
  return (
    <Panel className="p-5 md:p-6" id="shared-key">
      <PanelHeader title="If other people use your key" hint="Planning only: say how many people would use it and how much, and we show what that would do to this month." />
      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <label className="block" htmlFor={taskId}>
          <span className="text-xs font-semibold text-dim">What the key is used for</span>
          <select id={taskId} value={task} onChange={(e) => onTask(e.target.value)} className="mt-1.5 block w-full rounded-[10px] border border-rule bg-surface-2 px-3 py-2 text-sm text-ink outline-none focus:border-accent">
            <option value="">All my AI tasks</option>
            {(jobs.data ?? []).map((j) => <option key={j.name} value={j.name}>{jobTitle(j.name)}</option>)}
          </select>
        </label>
        <label className="block" htmlFor={othersId}>
          <span className="text-xs font-semibold text-dim">How many other people use it (0 to {MAX_OTHERS})</span>
          <input id={othersId} type="number" min={0} max={MAX_OTHERS} value={others} onChange={(e) => setOthers(Number(e.target.value) || 0)} className="mt-1.5 block w-28 rounded-[10px] border border-rule bg-surface-2 px-3 py-2 text-sm text-ink outline-none focus:border-accent" />
        </label>
      </div>
      <div className="mt-4">
        <p className="mb-1.5 text-xs font-semibold text-dim">Each of them would use it</p>
        <Segmented<Lean>
          label="How much each other person uses the key"
          value={lean}
          onChange={setLean}
          options={[{ value: "lighter", label: "Less than you" }, { value: "same", label: "About like you" }, { value: "heavier", label: "More than you" }]}
        />
      </div>
      <div className="mt-4" aria-live="polite">
        {daily.isPending ? (
          <Skeleton className="h-20" />
        ) : others <= 0 ? (
          <p className="text-sm text-dim">Add at least one other person to see the what-if.</p>
        ) : !result ? (
          <p className="text-sm text-dim">We need 7 full days of recorded calls before we can work this out. Until then we show no numbers.</p>
        ) : (
          <div className="rounded-[12px] border border-rule bg-surface-2/50 p-4">
            <p className="text-sm text-ink">
              If {others === 1 ? "1 other person uses" : `${count(others)} other people use`} this key {LEAN_WORDS[lean]}, this month could end around{" "}
              <span className="tabular font-semibold">{whole(result.low)} to {whole(result.high)}</span>, instead of about {whole(result.yours)} on your own.
            </p>
            <p className="mt-2 text-sm text-dim">Roughly <span className="tabular font-semibold text-ink">{whole(result.extra)}</span> more than your own use, and your share would be about {Math.round(100 / result.multiplier)}% of the key's use from now on.</p>
            {budget !== null && (
              <p className="mt-2 text-sm text-dim">
                {result.alreadyPassed
                  ? `Your limit of ${usd(budget)} is already used up this month.`
                  : result.runsOutOn
                    ? `At that pace a limit of ${usd(budget)} would be used up around ${dayLabel(result.runsOutOn)}.`
                    : result.lastsToMonthEnd
                      ? `At that pace a limit of ${usd(budget)} would last to the end of the month.`
                      : "We cannot say when your limit would be used up, because there is no recent pace to go on."}
              </p>
            )}
            <p className="mt-3 text-[11px] text-muted">
              This is a guess, not a measurement: we cannot see what other people use. It scales only the days still to come. If they already send their calls to this project, those calls are in your figures and this would count them twice. {ESTIMATE_LABEL}
            </p>
          </div>
        )}
      </div>
    </Panel>
  );
}

export default function SmartBudget() {
  const { mode } = useBillingMode();
  const p = useP();
  const [task, setTask] = useState("");
  if (mode === "subscription") {
    return (
      <div className="flex flex-col gap-6">
        <Heading />
        <Panel className="p-5 md:p-6">
          <PanelHeader title="You pay a flat fee" hint="There is no dollar bill to forecast, so there is no dollar limit here. What matters is your plan's allowance." />
          <p className="mt-3 text-sm text-dim">Add your allowance on the <Link to={p("/settings#limits")} className="font-semibold text-accent hover:underline">Usage limits</Link> page and we will tell you whether it lasts until it resets.</p>
        </Panel>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-6">
      <Reveal><Heading /></Reveal>
      <Reveal delay={0.05}>
        <Panel className="p-5 md:p-6">
          <PanelHeader title="Where this month is heading" hint={mode === "both" ? "Includes calls a subscription may cover, at list price, so it can be higher than what you are charged." : undefined} />
          <div className="mt-4"><MonthCard task={task} /></div>
        </Panel>
      </Reveal>
      <Reveal delay={0.1}>
        <Panel className="p-5 md:p-6" id="limit">
          <PanelHeader title="Your monthly limit" hint="It only warns you. It never stops anything." />
          <div className="mt-4"><BudgetEditor id="smart-budget-limit" alwaysOpen /></div>
        </Panel>
      </Reveal>
      <Reveal delay={0.15}><SharedKey task={task} onTask={setTask} /></Reveal>
    </div>
  );
}
