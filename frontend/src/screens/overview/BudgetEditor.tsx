/** The one place a monthly spending limit is typed, used by the Settings card and the Overview card.
 * Typing changes only a draft. Apply sends it, a toast says "Limit set to $X", and an analysis card shows
 * what the limit means from the recorded spend. The limit only warns, it never blocks. */
import { useMemo, useState } from "react";
import { useDaily } from "../../features/insights/api/dailyApi";
import { jobTitle } from "../../features/jobs/jobTitle";
import { parseBudget, useMonthlyBudget } from "../../features/projects/hooks/useBudget";
import { ApplyBar } from "../../ui/ApplyBar";
import { pct, usd } from "../../ui/format";
import { Button } from "../../ui/primitives";
import { useToast } from "../../ui/Toast";
import { useDraftSection } from "../../ui/useDraftSection";
import { analyseBudget, ESTIMATE_LABEL, exactUsd, HISTORY_DAYS, type BudgetAnalysis, type Verdict } from "./budgetAnalysis";

const whole = (v: number) => `$${Math.round(v).toLocaleString("en-US")}`;
const sameAmount = (a: string, b: string) => {
  const x = parseBudget(a);
  const y = parseBudget(b);
  return "value" in x && "value" in y ? x.value === y.value : a.trim() === b.trim();
};
const VERDICT: Record<Verdict, string> = {
  under: "likely under your limit",
  close: "close to your limit, could go either way",
  over: "likely over your limit",
};

function Tag() {
  return <span className="ml-1.5 rounded-full bg-surface-3 px-2 py-0.5 text-[10px] font-medium text-muted">estimate</span>;
}

export function BudgetAnalysisCard({ a, onClose }: { a: BudgetAnalysis; onClose: () => void }) {
  const left85 = a.spent >= a.alert85;
  const left95 = a.spent >= a.alert95;
  return (
    <section aria-label="What this limit means" className="mt-4 rounded-[12px] border border-rule bg-surface-2/50 p-3.5 text-[13px] text-dim">
      <div className="flex items-start justify-between gap-2">
        <p className="text-sm font-semibold text-ink">Limit set to {exactUsd(a.limit)} a month</p>
        <Button size="sm" variant="ghost" onClick={onClose} aria-label="Close this summary">Close</Button>
      </div>
      <p className="text-[11px] text-muted">{ESTIMATE_LABEL}</p>
      {a.belowSpent && (
        <p className="mt-2 rounded-md border border-warn/40 bg-warn/10 p-2 text-ink">
          You have already used about {usd(a.spent)} (estimate), above this limit. A warning for this new limit will be raised at the next hourly check.
        </p>
      )}
      <p className="mt-2">
        Spent so far this month: <span className="font-semibold text-ink tabular">{usd(a.spent)}</span> ({pct(a.spentShare, 0)} of your limit)<Tag />
      </p>
      <p className="mt-1">
        {a.projection ? (
          <>
            Month-end estimate: <span className="font-semibold text-ink tabular">{whole(a.projection.low)} to {whole(a.projection.high)}</span>, {VERDICT[a.projection.verdict]}.<Tag />
          </>
        ) : (
          <>Still learning: we need 7 full days of history before we can estimate where the month will end.</>
        )}
      </p>
      <details className="mt-2">
        <summary className="cursor-pointer text-xs font-semibold text-accent-ink">More about this limit</summary>
        <ul className="mt-2 flex flex-col gap-2">
          {!a.belowSpent && (
            <li>
              Warnings fire once each, on actual spend: at {usd(a.alert85)} (85%){left85 ? ", already passed" : ""} and at {usd(a.alert95)} (95%){left95 ? ", already passed" : ""}. A separate warning fires when the month is on pace to go over.
            </li>
          )}
          {a.alreadyPassed ? (
            <li>You have already passed this limit this month.</li>
          ) : a.daysToLimit !== null ? (
            <li>{a.daysToLimit > 365 ? "If the pace stays the same, it would take more than a year to reach the limit." : `If the pace stays the same, you reach the limit in about ${a.daysToLimit} ${a.daysToLimit === 1 ? "day" : "days"}.`}</li>
          ) : null}
          <li>
            {a.backtest ? (
              <>
                Looking back: of the {a.backtest.months.length} complete {a.backtest.months.length === 1 ? "month" : "months"} we have recorded ({a.backtest.months.map((m) => `${m.label} ${whole(m.spend)}`).join(", ")}), {a.backtest.over === 0 ? "none" : a.backtest.over} would have gone over this limit. We only look back {HISTORY_DAYS} days.
              </>
            ) : (
              <>Not enough history yet to check past months.</>
            )}
          </li>
          {a.topTasks.length > 0 && (
            <li>
              Most spent this month:
              <ul className="mt-1 flex flex-col gap-0.5">
                {a.topTasks.map((t) => (
                  <li key={t.job} className="flex justify-between gap-3">
                    <span className="min-w-0 truncate" title={t.job}>{jobTitle(t.job)}</span>
                    <span className="shrink-0 tabular text-ink">{usd(t.spend)} · {pct(t.share, 0)}</span>
                  </li>
                ))}
              </ul>
            </li>
          )}
        </ul>
        <p className="mt-2 text-[11px] text-muted">{ESTIMATE_LABEL} Days are counted in UTC.</p>
      </details>
    </section>
  );
}

export function BudgetEditor({ id, alwaysOpen = false }: { id: string; alwaysOpen?: boolean }) {
  const account = useMonthlyBudget();
  const toast = useToast();
  const daily = useDaily({ days: HISTORY_DAYS });
  const points = daily.data;
  const budget = account.budget;
  const [editing, setEditing] = useState(false);
  const [removeError, setRemoveError] = useState<string | null>(null);

  const d = useDraftSection<string, number>({
    saved: budget === null ? "" : String(budget),
    equal: sameAmount,
    validate: (t) => {
      const r = parseBudget(t);
      return "error" in r ? r.error : null;
    },
    save: async (t) => {
      const r = parseBudget(t);
      if ("error" in r) throw new Error(r.error);
      const err = await account.save(r.value);
      if (err) throw new Error(err);
      return r.value;
    },
    success: (_text, limit) => `Limit set to ${exactUsd(limit)}`,
  });

  const suggestion = useMemo(() => (points ? analyseBudget(points, 1).suggestion : null), [points]);
  const typed = parseBudget(d.value);
  const preview = d.dirty && "value" in typed && points ? analyseBudget(points, typed.value) : null;
  const done = d.result !== null && points ? analyseBudget(points, d.result) : null;

  if (!account.canEdit) return budget ? <p className="text-xs text-dim">Limit {usd(budget)} a month</p> : null;

  const open = alwaysOpen || editing;
  const remove = async () => {
    setRemoveError(null);
    const previous = budget;
    const err = await account.save(null);
    if (err) return setRemoveError(err);
    d.discard();
    d.clearResult();
    setEditing(false);
    toast({
      message: "Limit removed. Warnings for it are off.",
      undo: previous === null ? undefined : {
        label: "Undo",
        onUndo: () => void account.save(previous).then((e) => toast(e ? { message: `Could not restore the limit: ${e}`, kind: "error" } : { message: `Limit set back to ${exactUsd(previous)}` })),
      },
    });
  };
  const apply = async () => {
    const ok = await d.apply();
    if (ok && !alwaysOpen) setEditing(false);
    return ok;
  };

  return (
    <div>
      {!open ? (
        budget === null ? (
          <button type="button" onClick={() => { d.change(""); setEditing(true); }} className="rounded-[9px] border border-rule bg-surface-2 px-3 py-1.5 text-[13px] font-semibold text-accent-ink transition-colors hover:border-accent hover:underline">Set a monthly limit</button>
        ) : (
          <div className="flex flex-wrap items-center gap-3 text-xs text-dim">
            <span>Limit {usd(budget)} a month</span>
            <button type="button" onClick={() => { d.change(String(budget)); setEditing(true); }} className="font-semibold text-accent-ink hover:underline">Change</button>
            <button type="button" onClick={() => void remove()} disabled={account.saving} className="font-semibold text-muted hover:text-bad hover:underline">Remove</button>
          </div>
        )
      ) : (
        <form onSubmit={(e) => { e.preventDefault(); void apply(); }}>
          <label htmlFor={id} className="block text-xs font-semibold text-dim">Monthly spending limit in US dollars</label>
          <div className="mt-1.5 flex flex-wrap items-center gap-2">
            <span className="flex items-center rounded-[10px] border border-rule bg-surface-2 px-3 focus-within:border-accent">
              <span aria-hidden className="text-sm text-muted">$</span>
              <input id={id} type="text" inputMode="decimal" autoComplete="off" className="w-32 bg-transparent px-1.5 py-2 text-sm text-ink outline-none placeholder:text-muted" value={d.value} onChange={(e) => d.change(e.target.value)} placeholder="e.g. 500" aria-invalid={d.error ? true : undefined} />
            </span>
            <span className="text-sm text-dim">a month</span>
            {budget !== null && <Button variant="ghost" size="sm" onClick={() => void remove()} disabled={account.saving || d.applying}>Remove limit</Button>}
            {!alwaysOpen && <Button variant="ghost" size="sm" onClick={() => { d.discard(); setEditing(false); }}>Cancel</Button>}
          </div>
          <p className="mt-1.5 text-[11px] text-muted">The limit only warns, it never blocks.</p>
          {suggestion !== null && (
            <button type="button" onClick={() => d.change(String(suggestion))} className="mt-2 rounded-full border border-rule px-3 py-1 text-xs text-dim hover:border-accent">
              Last full month's spend plus 20%: <span className="font-semibold text-ink">{whole(suggestion)}</span> <span className="text-muted">(a starting point, not a recommendation)</span>
            </button>
          )}
          {removeError && <p role="alert" className="mt-2 text-xs text-bad">{removeError}</p>}
          <ApplyBar
            dirty={d.dirty}
            applying={d.applying}
            error={d.error}
            onApply={apply}
            onDiscard={d.discard}
            review={
              preview?.belowSpent ? (
                <>You have already used about {usd(preview.spent)} (estimate), above this limit. A warning for this new limit will be raised at the next hourly check.</>
              ) : undefined
            }
          />
        </form>
      )}
      {done && <BudgetAnalysisCard a={done} onClose={d.clearResult} />}
    </div>
  );
}
