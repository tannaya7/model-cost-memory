/** "What changed": the last period against the same number of days before it, as measured on the project's own calls.
 *
 * Three things are kept apart on purpose, in this order:
 *   1. what changed (measured, with the coverage behind it and what is missing),
 *   2. how that adds up (exact arithmetic: more calls, a different mix of models, or a call costing more),
 *   3. what else was recorded at the same time (a new prompt version, a new model, a list-price change).
 * Nothing here says why. A recorded event can coincide with a change without causing it, and the card says so.
 * No AI writes any of it: every sentence is built from the numbers the server sent. */
import { useState } from "react";
import { Link } from "react-router-dom";
import { useP } from "../../app/project";
import { CHANGE_DAYS, isChanges, useChanges, type ChangeObservation, type Changes } from "../../features/insights/api/changesApi";
import { count, usd } from "../../ui/format";
import { cx, ErrorState, Segmented, Skeleton } from "../../ui/primitives";
import { Shell, type ShellProps } from "./widgets";

const day = (iso: string) => new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
const dayYear = (iso: string) => new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
const sign = (x: number) => (x < 0 ? "−" : "+");
const lastDay = (endExclusive: string) => new Date(Date.parse(`${endExclusive}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);

/** A value in its own unit, or "not known" (never 0) when it could not be measured. */
export function valueText(o: Pick<ChangeObservation, "unit">, v: number | null): string {
  if (v === null) return "not known";
  if (o.unit === "usd") return usd(v);
  if (o.unit === "share") return `${v.toFixed(1)}%`;
  return count(Math.round(v));
}

/** How far it moved: a percentage for amounts, points for shares, and a plain reason when it cannot be said. */
export function changeText(o: ChangeObservation): string {
  if (o.size === "unknown") return "too few calls to say how much";
  if (o.change === null) return "not known";
  if (o.unit === "share") return `${sign(o.change)}${Math.abs(o.change).toFixed(1)} points`;
  if (o.change_pct === null) return `${sign(o.change)}${valueText(o, Math.abs(o.change))}`;
  return `${sign(o.change_pct)}${Math.abs(o.change_pct).toFixed(0)}%`;
}

const money = (v: number) => `${sign(v)}${usd(Math.abs(v))}`;
const tokens = (v: number) => `${sign(v)}${count(Math.round(Math.abs(v)))}`;

/** One sentence per split. It is arithmetic on the calls, and says so, not a reason. */
export function splitSentence(s: Changes["splits"][number]): string {
  const fmt = s.what === "spend_usd" ? money : tokens;
  const what = s.what === "spend_usd" ? "Spend" : "Tokens";
  const dir = s.total_change < 0 ? "fell" : "rose";
  const total = s.what === "spend_usd" ? usd(Math.abs(s.total_change)) : count(Math.round(Math.abs(s.total_change)));
  const per = s.what === "spend_usd" ? "what a call costs on a model used in both periods" : "how many tokens a call carries on a model used in both periods";
  return `${what} ${dir} by ${total}: ${fmt(s.from_calls)} from the number of calls, ${fmt(s.from_mix)} from calls moving between models, ${fmt(s.from_per_call)} from ${per}.`;
}

function Row({ o }: { o: ChangeObservation }) {
  return (
    <li className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5 border-t border-rule py-2 first:border-t-0 first:pt-0">
      <span className="min-w-0 text-sm text-ink">{o.label}</span>
      <span className="tabular text-sm text-dim">
        {valueText(o, o.before)} → {valueText(o, o.after)}{" "}
        <span className={cx("font-semibold", o.size === "notable" ? "text-ink" : "text-muted")}>({changeText(o)})</span>
      </span>
      {o.note && <span className="basis-full text-xs text-muted">{o.note}</span>}
    </li>
  );
}

export function ChangesBody({ days }: { days: number }) {
  const p = useP();
  const q = useChanges(days);
  const [more, setMore] = useState(false);
  if (q.isPending) return <Skeleton className="h-40" />;
  if (q.isError || !isChanges(q.data)) return <ErrorState error={q.error ?? new Error("Could not load the changes")} onRetry={() => void q.refetch()} />;
  const c = q.data;
  const notable = c.observations.filter((o) => o.size === "notable");
  const rest = c.observations.filter((o) => o.size !== "notable");
  const nothingYet = c.current.calls === 0 && c.previous.calls === 0;
  return (
    <div className="flex flex-col gap-4" data-testid="what-changed">
      <p className="text-sm text-dim" data-testid="changes-periods">
        {dayYear(c.current.start)} to {dayYear(lastDay(c.current.end))} ({count(c.current.calls)} calls) compared with {day(c.previous.start)} to {dayYear(lastDay(c.previous.end))} ({count(c.previous.calls)} calls). Whole UTC days only.
      </p>

      {nothingYet ? (
        <p className="text-sm text-dim">No AI calls in either period yet, so there is nothing to compare. This fills in once your app has made calls.</p>
      ) : (
        <>
          <section aria-label="What changed">
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted">What changed</h3>
            {notable.length === 0 ? (
              <p className="text-sm text-dim" data-testid="nothing-notable">
                {c.comparable ? "Nothing moved by 20% or more (or 5 points for a share). Smaller changes are below." : "Too few calls in one of the periods to call any change notable. The figures are below."}
              </p>
            ) : (
              <ul>{notable.map((o) => <Row key={o.key} o={o} />)}</ul>
            )}
            {rest.length > 0 && (
              <details className="mt-2" open={more} onToggle={(e) => setMore((e.currentTarget as HTMLDetailsElement).open)}>
                <summary className="cursor-pointer text-xs font-semibold text-accent">Smaller or unclear changes ({rest.length})</summary>
                <ul className="mt-2">{rest.map((o) => <Row key={o.key} o={o} />)}</ul>
              </details>
            )}
          </section>

          {(c.model_mix.length > 0 || c.task_mix.length > 0) && (
            <section aria-label="Who made the calls">
              <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted">Share of calls</h3>
              <ul className="space-y-1 text-sm text-dim">
                {c.model_mix.map((r) => (
                  <li key={`m-${r.name}`} data-testid="mix-row">
                    <span className="font-mono text-xs text-ink">{r.name}</span>: {r.before_share === null ? "not used" : `${r.before_share.toFixed(0)}%`} → {r.after_share === null ? "not used" : `${r.after_share.toFixed(0)}%`} of calls
                    {r.change_points !== null && <span className="text-muted"> ({sign(r.change_points)}{Math.abs(r.change_points).toFixed(0)} points)</span>}
                  </li>
                ))}
                {c.task_mix.map((r) => (
                  <li key={`t-${r.name}`} data-testid="mix-row">
                    <Link to={p(`/jobs/${encodeURIComponent(r.name)}`)} className="font-semibold text-accent hover:underline">{r.name}</Link>: {r.before_share === null ? "no calls" : `${r.before_share.toFixed(0)}%`} → {r.after_share === null ? "no calls" : `${r.after_share.toFixed(0)}%`} of calls
                    {r.change_points !== null && <span className="text-muted"> ({sign(r.change_points)}{Math.abs(r.change_points).toFixed(0)} points)</span>}
                  </li>
                ))}
              </ul>
            </section>
          )}

          {c.splits.length > 0 && (
            <section aria-label="How the change adds up">
              <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted">How it adds up</h3>
              <ul className="space-y-1 text-sm text-dim">{c.splits.map((s) => <li key={s.what}>{splitSentence(s)}</li>)}</ul>
              <p className="mt-1 text-xs text-muted">This is arithmetic on your own calls. It shows where the change sits, not the reason for it.</p>
            </section>
          )}

          {c.events.length > 0 && (
            <section aria-label="Recorded at the same time">
              <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted">Recorded at the same time</h3>
              <ul className="space-y-2 text-sm">
                {c.events.map((e) => (
                  <li key={`${e.kind}-${e.on}-${e.label}`} data-testid="event">
                    <span className="text-ink">{day(e.on)}: {e.label}.</span>{" "}
                    <span className="text-xs text-muted">{e.link === "concentrated" && e.evidence ? e.evidence : "It happened in the same period. That does not show it affected the numbers above."}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </>
      )}

      {c.notes.length > 0 && (
        <section aria-label="What is missing" data-testid="coverage-notes">
          <h3 className="mb-1 text-xs font-semibold uppercase tracking-wider text-muted">What is missing</h3>
          <ul className="list-disc space-y-0.5 pl-5 text-xs text-muted">{c.notes.map((n) => <li key={n}>{n}</li>)}</ul>
        </section>
      )}
      <details className="text-xs text-muted">
        <summary className="cursor-pointer font-semibold text-dim">What this can and cannot tell you</summary>
        <p className="mt-1">{c.basis}</p>
        <ul className="mt-1 list-disc space-y-0.5 pl-5">{c.not_recorded.map((n) => <li key={n}>{n}</li>)}</ul>
      </details>
    </div>
  );
}

export function WhatChanged({ shell }: { shell: ShellProps }) {
  const [days, setDays] = useState("7");
  return (
    <Shell
      shell={shell}
      title="What changed"
      hint="Against the same number of days before. It shows what changed and what else was recorded at the same time, never why."
      controls={<Segmented label="Compare the last" value={days} options={CHANGE_DAYS.map((d) => ({ value: String(d), label: `${d} days` }))} onChange={setDays} />}
    >
      <ChangesBody days={Number(days)} />
    </Shell>
  );
}
