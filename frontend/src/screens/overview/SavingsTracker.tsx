/** "Savings since you switched": what happened to a task's cost per correct answer after YOU changed its model.
 *
 * Two things are kept apart on purpose:
 *   1. the observed change (cost per correct answer before and after, with a range; it can be negative), and
 *   2. an estimate of cost avoided (a counterfactual, labelled as one, with its assumptions), which is never added to the first.
 * Nothing is shown as a saving unless even the cautious end of the range is above zero, and only when the data is comparable.
 * Recommendations, "promising" labels and trials are never counted. It never changes a model or a prompt. */
import { Link } from "react-router-dom";
import { useP } from "../../app/project";
import { isSavings, useSavings, type SavingsEntry } from "../../features/insights/api/savingsApi";
import { jobTitle } from "../../features/jobs/jobTitle";
import { count, pct, usd } from "../../ui/format";
import { cx, ErrorState, Pill, Skeleton } from "../../ui/primitives";
import { Shell, type ShellProps } from "./widgets";

const dayYear = (iso: string) => new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
const sign = (x: number) => (x < 0 ? "−" : "+");

/** A value in its unit: dollars, or tokens on a flat plan. */
export function amount(unit: "usd" | "tokens", v: number | null | undefined, opts: { signed?: boolean } = {}): string {
  if (v === null || v === undefined) return "not known";
  const abs = Math.abs(v);
  // Cost per answer is often a fraction of a cent: two significant figures under a dollar, so $0.011 is not shown as $0.01.
  const dollars = abs > 0 && abs < 1 ? `$${abs.toPrecision(2).replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "")}` : usd(abs);
  const body = unit === "usd" ? dollars : `${count(Math.round(abs))} tokens`;
  return opts.signed ? `${sign(v)}${body}` : v < 0 ? `−${body}` : body;
}

const STATUS_PILL: Record<SavingsEntry["status"], { tone: "good" | "neutral" | "bad" | "warn"; text: string }> = {
  saving: { tone: "good", text: "Cheaper per correct answer" },
  no_clear_change: { tone: "neutral", text: "No clear change" },
  cost_up: { tone: "bad", text: "Costs more per correct answer" },
  less_correct: { tone: "warn", text: "Cheaper, but less correct" },
  not_enough_data: { tone: "neutral", text: "Not enough comparable data" },
  waiting: { tone: "neutral", text: "Waiting for more days" },
};

/** The observed change, as one plain sentence. Never "you saved". */
export function observedSentence(e: SavingsEntry): string | null {
  const r = e.realized;
  if (!r) return null;
  const u = r.unit;
  const head = `Observed: cost per correct answer went from ${amount(u, r.before)} to ${amount(u, r.after)} after you switched on ${dayYear(e.switch_date)}.`;
  if (e.status === "saving") return `${head} That is ${amount(u, r.range_low)} to ${amount(u, r.range_high)} less for each correct answer (90% range).`;
  if (e.status === "cost_up") return `${head} That is ${amount(u, Math.abs(r.range_high ?? 0))} to ${amount(u, Math.abs(r.range_low ?? 0))} more for each correct answer (90% range).`;
  if (e.status === "less_correct") return `${head} Fewer answers were correct, so this is not counted as a saving.`;
  return `${head} The change is within what chance could explain: between ${amount(u, r.range_low, { signed: true })} and ${amount(u, r.range_high, { signed: true })} per correct answer (90% range).`;
}

function Entry({ e }: { e: SavingsEntry }) {
  const p = useP();
  const pill = STATUS_PILL[e.status];
  const r = e.realized;
  const est = e.estimated_avoided;
  const sentence = observedSentence(e);
  return (
    <li className="rounded-[12px] border border-rule p-4" data-testid="savings-entry" data-status={e.status}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <Link to={p(`/jobs/${encodeURIComponent(e.job)}`)} className="text-sm font-semibold text-accent hover:underline">{jobTitle(e.job)}</Link>
          <p className="mt-0.5 text-xs text-muted">
            <span className="font-mono">{e.from_model}</span> → <span className="font-mono">{e.to_model}</span>, switched on {dayYear(e.switch_date)}
          </p>
        </div>
        <Pill tone={pill.tone} icon={false}>{pill.text}</Pill>
      </div>

      {e.status === "waiting" && <p className="mt-2 text-sm text-dim">{e.reason}</p>}
      {e.status === "not_enough_data" && (
        <div className="mt-2 text-sm text-dim">
          <p className="font-semibold text-ink">Not enough comparable data, so no figure is shown.</p>
          <ul className="mt-1 list-disc pl-5">{(e.reasons.length ? e.reasons : [e.reason ?? ""]).map((x) => <li key={x}>{x}</li>)}</ul>
        </div>
      )}

      {r && sentence && (
        <div className="mt-2 text-sm text-ink" data-testid="observed">
          <p>{sentence}</p>
          <p className="mt-1 text-xs text-muted">
            Correct answers: {pct(r.pass_rate_before, 0)} before, {pct(r.pass_rate_after, 0)} after ({count(r.checked_before)} and {count(r.checked_after)} checked calls). {r.mix_compared}.
            Prices: {r.price_basis}. {r.unit_words}.
          </p>
        </div>
      )}

      {est && (
        <div className="mt-3 rounded-[10px] bg-surface-2 p-3 text-sm" data-testid="estimated">
          <p className="text-xs font-semibold uppercase tracking-wider text-muted">{est.label}</p>
          <p className="mt-1 text-dim">
            {est.what} About <strong className="text-ink">{amount(est.unit, est.low)} to {amount(est.unit, est.high)}</strong> over {count(est.correct_answers)} correct answers (best guess {amount(est.unit, est.point)}).
          </p>
          <details className="mt-1.5">
            <summary className="cursor-pointer text-xs font-semibold text-accent">Assumptions</summary>
            <ul className="mt-1 list-disc pl-5 text-xs text-muted">{est.assumptions.map((a) => <li key={a}>{a}</li>)}</ul>
          </details>
        </div>
      )}

      {e.data_notes.length > 0 && (
        <ul className="mt-2 list-disc pl-5 text-xs text-muted" data-testid="data-notes">{e.data_notes.map((n) => <li key={n}>{n}</li>)}</ul>
      )}
    </li>
  );
}

export function SavingsBody() {
  const q = useSavings();
  if (q.isPending) return <Skeleton className="h-40" />;
  if (q.isError || !isSavings(q.data)) return <ErrorState error={q.error ?? new Error("Could not load the savings tracker")} onRetry={() => void q.refetch()} />;
  const s = q.data;
  const total = s.estimated_avoided_total;
  return (
    <div className="flex flex-col gap-4" data-testid="savings-tracker">
      <p className="text-sm text-dim">
        This only looks at changes <strong className="text-ink">you</strong> made: it notices when a task starts running on another model and compares the same task before and after.
        It never counts our recommendations, &ldquo;promising&rdquo; models or trials, and it never changes a model for you.
      </p>

      {s.entries.length === 0 ? (
        <div className="rounded-[12px] border border-dashed border-rule p-4 text-sm text-dim" data-testid="savings-empty">
          <p className="font-semibold text-ink">No model change found yet.</p>
          <p className="mt-1">
            When one of your tasks starts running on a different model, this shows what happened to its cost per correct answer, once there are 14 comparable days on each side.
            {s.jobs_checked === 0 ? " Add an AI task first." : ""}
          </p>
        </div>
      ) : (
        <ul className="flex flex-col gap-3">{s.entries.map((e) => <Entry key={`${e.job}-${e.switch_date}-${e.to_model}`} e={e} />)}</ul>
      )}

      {total && (
        <div className="rounded-[12px] border border-rule p-3 text-sm" data-testid="estimated-total">
          <p className="text-xs font-semibold uppercase tracking-wider text-muted">Estimated, all changes together</p>
          <p className="mt-1 text-dim">{total.label}.</p>
          <p className={cx("mt-1 font-semibold text-ink")}>About {amount(total.unit, total.low)} to {amount(total.unit, total.high)} across {total.entries} {total.entries === 1 ? "change" : "changes"}.</p>
        </div>
      )}

      <details>
        <summary className="cursor-pointer text-xs font-semibold text-accent">How this is measured</summary>
        <ul className="mt-2 list-disc space-y-1 pl-5 text-xs text-muted">
          {s.method.map((m) => <li key={m}>{m}</li>)}
          {s.notes.map((n) => <li key={n}>{n}</li>)}
        </ul>
      </details>
    </div>
  );
}

export function SavingsTracker({ shell }: { shell: ShellProps }) {
  return (
    <Shell shell={shell} hint="Cost per correct answer before and after you changed a task's model. It can go down, up, or not move.">
      <SavingsBody />
    </Shell>
  );
}
