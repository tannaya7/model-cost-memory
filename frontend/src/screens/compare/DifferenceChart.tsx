/** How much better or worse each model is than the model in use, as the engine measured it: the gap, its range, and the
 * most it may be worse and still qualify. The numbers are the engine's (`vs_current`); the chart only draws them.
 * Meaning is carried by position, a marker shape AND words, never by colour alone. A range that touches zero is
 * drawn as "not sure yet", never as "the same". Untested models have no row: they have nothing to draw. */
import type { Recommendation } from "../../shared/api/types";
import { ChartFrame } from "../../ui/charts/ChartFrame";
import { cx } from "../../ui/primitives";
import { buildRows, DIFF_WORDS, diffRange, diffSentence, signed, type Difference } from "./compareModel";

const SHAPE: Record<Difference["status"], string> = {
  GOOD_ENOUGH: "rounded-full bg-ok", // circle
  UNSURE: "rotate-45 rounded-[2px] bg-warn", // diamond
  CLEARLY_WORSE: "rounded-[2px] bg-bad", // square
};
const TEXT: Record<Difference["status"], string> = { GOOD_ENOUGH: "text-ok", UNSURE: "text-warn", CLEARLY_WORSE: "text-bad" };

export function DifferenceChart({ rec, allowed }: { rec: Recommendation; allowed?: (model: string) => boolean }) {
  const current = rec.current?.model;
  const rows = buildRows(rec, allowed).filter((r) => r.diff != null && !r.isCurrent);
  const range = diffRange(rows);

  if (!current) {
    return <p className="text-sm text-dim" data-testid="diff-empty">We do not know which model this task uses yet, so there is nothing to compare the others with.</p>;
  }
  if (!range || rows.length === 0) {
    return <p className="text-sm text-dim" data-testid="diff-empty">No other model has checked answers on this task yet, so there is no difference to show. Try one on your own past prompts.</p>;
  }
  const margin = rows[0].diff!.margin_points;
  const conf = Math.round(rows[0].diff!.confidence * 100);
  const at = (x: number) => `${((x - range.min) / (range.max - range.min)) * 100}%`;
  const table = {
    columns: ["Model", "Difference from the model in use", `${conf}% range`, "Verdict of the rule"],
    rows: rows.map((r) => [r.model, `${signed(r.diff!.gap_points)} points`, `${signed(r.diff!.low_points)} to ${signed(r.diff!.high_points)}`, DIFF_WORDS[r.diff!.status]]),
  };

  return (
    <ChartFrame
      title={`Difference from ${current}`}
      hint={`Each bar is the ${conf}% range for how much better or worse a model's correct answers are than ${current}'s. To the right of the middle line is better. A model qualifies when the whole bar sits to the right of the dashed line (at most ${margin} points worse).`}
      table={table}
    >
      <div role="group" aria-label={`Difference from ${current}, in percentage points`} className="flex flex-col gap-3" data-testid="difference-chart">
        {rows.map((r) => {
          const d = r.diff!;
          return (
            <div key={r.model} role="img" aria-label={`${r.model}: ${diffSentence(d)} ${DIFF_WORDS[d.status]}.`} className="grid gap-1 sm:grid-cols-[11rem_minmax(0,1fr)] sm:items-center sm:gap-3">
              <p className="truncate font-mono text-xs text-ink" title={r.model}>{r.model}</p>
              <div>
                <div className="relative h-8" aria-hidden>
                  <div className="absolute inset-y-0 w-px bg-ink/50" style={{ left: at(0) }} />
                  <div className="absolute inset-y-0 border-l border-dashed border-muted" style={{ left: at(-margin) }} />
                  <div className="absolute top-1/2 h-[3px] -translate-y-1/2 rounded-full bg-muted/70" style={{ left: at(d.low_points), width: `calc(${at(d.high_points)} - ${at(d.low_points)})`, minWidth: 3 }} />
                  <div className={cx("absolute top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 ring-2 ring-surface", SHAPE[d.status])} style={{ left: at(d.gap_points) }} />
                </div>
                <p className={cx("text-[11px] font-semibold", TEXT[d.status])}>
                  {DIFF_WORDS[d.status]} <span className="font-normal text-muted tabular">· {signed(d.gap_points)} points ({signed(d.low_points)} to {signed(d.high_points)})</span>
                </p>
              </div>
            </div>
          );
        })}
        <div className="grid sm:grid-cols-[11rem_minmax(0,1fr)] sm:gap-3" aria-hidden>
          <span />
          <div className="relative h-9 text-[10px] text-muted">
            <span className="absolute -translate-x-1/2 whitespace-nowrap" style={{ left: at(-margin) }}>{signed(-margin, 0)} (the most we accept)</span>
            <span className="absolute top-4 -translate-x-1/2 whitespace-nowrap" style={{ left: at(0) }}>0 = {current}</span>
          </div>
        </div>
      </div>
      <p className="text-xs text-muted">
        A bar that touches the middle line is not proof the models are the same, only that the evidence cannot tell yet. The models answered different requests, so they are compared as two separate groups. The confidence is the level a switch needs, stricter than the ranges elsewhere on this page.
      </p>
    </ChartFrame>
  );
}
