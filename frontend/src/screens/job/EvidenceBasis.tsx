/** What a verdict rests on, in plain words: the evidence state, how answers were checked (a fixed rule or a label the app
 * reports), the window, the paired comparison when re-tests made one, and what the evidence cannot tell you.
 * Collapsed by default. Never a verdict and never a saving. */
import type { Recommendation } from "../../shared/api/types";

const STATE: Record<NonNullable<Recommendation["evidence"]["state"]>, string> = {
  enough: "Enough evidence",
  not_enough: "Not enough evidence yet",
  not_comparable: "Not comparable",
  no_recommendation: "No recommendation",
};

const day = (iso: string) => new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
const pts = (x: number) => `${x >= 0 ? "+" : "−"}${Math.abs(x).toFixed(1)}`;

/** A gap in words that never calls an unproven gap a tie: a range that includes zero is "no clear difference yet". */
export function gapWords(low: number, high: number): string {
  if (low > 0) return "the cheaper model is ahead, and the range is above zero";
  if (high < 0) return "the cheaper model is behind, and the range is below zero";
  return "no clear difference yet. A range that includes zero is not proof they are the same";
}

export function EvidenceBasis({ rec }: { rec: Recommendation }) {
  const e = rec.evidence;
  if (!e || !e.state) return null;
  const p = e.paired;
  return (
    <details data-testid="evidence-basis" className="mt-3 text-xs text-muted">
      <summary className="cursor-pointer font-semibold text-dim">What this rests on · {STATE[e.state]}</summary>
      <ul className="mt-2 list-disc space-y-1.5 pl-5">
        {e.state_note && <li>{e.state_note}</li>}
        {e.check && (
          <li>
            <span className="font-semibold text-dim">How answers were checked:</span> {e.check.label}.{" "}
            {e.check.kind === "deterministic" ? "A fixed rule decided." : "Reported by your app."} {e.check.text}
          </li>
        )}
        {e.window_from && e.window_to && (
          <li>
            Checked answers from {day(e.window_from)} to {day(e.window_to)}: {e.n_runs.toLocaleString("en")} in all.
          </li>
        )}
        {p && (
          <li data-testid="paired">
            Same prompts through both models: {p.n_prompts} prompts, {p.candidate} compared with {p.current}. Gap {pts(p.gap_points)} points
            (range {pts(p.low_points)} to {pts(p.high_points)}): {gapWords(p.low_points, p.high_points)}. Shown for information; the
            recommendation above does not depend on it.
          </li>
        )}
        {(e.limitations ?? []).map((l) => (
          <li key={l}>{l}</li>
        ))}
      </ul>
    </details>
  );
}
