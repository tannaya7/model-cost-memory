/** Cost against quality for one task, measured on the user's own work only.
 *
 * Each dot is a model this task has run: its cost per 1,000 correct answers (across) and its share of correct answers
 * (up) with the engine's own range as a whisker, so a model with few checked answers is visibly less certain. The model
 * in use is a square, the others circles. Nothing is drawn for a model without a price or without checked answers: it is
 * listed under the chart with the reason, and models never tested on this task have no point at all (see UntestedList).
 * A model is chosen from the chips or the table (keyboard friendly), which opens its numbers and a link to its own AI calls. */
import { useId, useState } from "react";
import { CartesianGrid, ErrorBar, ReferenceLine, ResponsiveContainer, Scatter, ScatterChart, Tooltip, XAxis, YAxis } from "recharts";
import { Link } from "react-router-dom";
import { useP } from "../../app/project";
import type { Recommendation } from "../../shared/api/types";
import { ChartFrame, TooltipCard } from "../../ui/charts/ChartFrame";
import { pct, usd } from "../../ui/format";
import { cx } from "../../ui/primitives";
import { buildRows, diffSentence, notDrawn, plottable, STATUS_WORDS, yFloor, type Row } from "./compareModel";
import { TOO_FEW_LABEL } from "./wilson";

interface Pt {
  model: string;
  x: number;
  y: number;
  err: [number, number];
  current: boolean;
  selected: boolean;
  row: Row;
}

function Dot(props: { cx?: number; cy?: number; payload?: Pt }) {
  const { cx = 0, cy = 0, payload } = props;
  if (!payload) return null;
  const ring = payload.selected ? <circle cx={cx} cy={cy} r={12} fill="none" stroke="var(--color-ink)" strokeWidth={2} /> : null;
  return payload.current ? (
    <g>
      {ring}
      <rect x={cx - 6} y={cy - 6} width={12} height={12} fill="var(--color-accent)" stroke="var(--color-surface)" strokeWidth={2} />
    </g>
  ) : (
    <g>
      {ring}
      <circle cx={cx} cy={cy} r={7} fill="var(--color-accent-2, var(--color-accent))" stroke="var(--color-surface)" strokeWidth={2} />
    </g>
  );
}

/** "81% (72% to 88%)", or the plain too-few label with the count. */
export function rateText(r: Row): string {
  if (r.rate == null) return "No checked answers yet";
  if (r.tooFew || r.low == null || r.high == null) return `${pct(r.rate)}. ${TOO_FEW_LABEL}`;
  return `${pct(r.rate)} (${pct(r.low, 0)} to ${pct(r.high, 0)})`;
}

function costText(r: Row, listPrice: boolean): string {
  if (r.costState === "unpriced") return "No price known";
  if (r.costState === "undefined") return "Not worked out (none passed)";
  if (r.costState === "free") return "$0.00 (costs nothing to run)";
  return `${usd(r.cost1000 as number)}${listPrice ? " (list price)" : ""}`;
}

/** The typical call and the expensive tail, only when enough calls stand behind them. */
function callText(r: Row): string {
  if (r.p50 == null || r.p90 == null) return "Too few priced calls to say";
  return `${usd(r.p50)} typical · ${usd(r.p90)} for the dearest 1 in 10`;
}

function Detail({ r, job, notComparable }: { r: Row; job: string; notComparable: boolean }) {
  const p = useP();
  const base = r.model.split("@")[0];
  const runs = p(`/jobs/${encodeURIComponent(job)}?tab=runs&model=${encodeURIComponent(base)}`);
  const fails = `${runs}&outcome=FAIL`;
  return (
    <div className="rounded-[12px] border border-rule bg-surface-2/60 p-3 text-xs" data-testid="model-detail">
      <p className="font-mono text-sm font-semibold text-ink">{r.model}{r.isCurrent ? " (model in use)" : ""}</p>
      <dl className="mt-2 grid gap-x-6 gap-y-1 sm:grid-cols-2">
        <div><dt className="inline text-muted">Correct answers: </dt><dd className="inline font-semibold text-ink tabular">{rateText(r)}</dd></div>
        <div><dt className="inline text-muted">Checked answers: </dt><dd className="inline font-semibold text-ink tabular">{r.checked.toLocaleString("en")}{r.retests ? `, ${r.retests.toLocaleString("en")} of them trials on your own past prompts` : ""}</dd></div>
        <div><dt className="inline text-muted">Cost per 1,000 correct answers: </dt><dd className="inline font-semibold text-ink tabular">{costText(r, false)}</dd></div>
        <div><dt className="inline text-muted">One call: </dt><dd className="inline font-semibold text-ink tabular">{callText(r)}</dd></div>
        {r.unpriced ? <div className="sm:col-span-2"><dt className="inline text-muted">Missing cost: </dt><dd className="inline font-semibold text-warn tabular">{r.unpriced.toLocaleString("en")} of {r.checked.toLocaleString("en")} checked calls have no known price, so they are left out of the cost figures.</dd></div> : null}
        {r.spread ? <div className="sm:col-span-2"><dd className="text-dim">A few calls cost much more than a typical one, so the average cost hides them.</dd></div> : null}
        {!notComparable && r.diff ? <div className="sm:col-span-2"><dt className="inline text-muted">Against {r.diff.against}: </dt><dd className="inline text-dim">{diffSentence(r.diff)}</dd></div> : null}
      </dl>
      <p className="mt-2 flex flex-wrap gap-4">
        <Link to={runs} className="font-semibold text-accent hover:underline">See this model's AI calls</Link>
        <Link to={fails} className="font-semibold text-accent hover:underline">See its failed answers</Link>
      </p>
      <p className="mt-1 text-[11px] text-muted">You see only what your sign-in allows, and text removed by your retention setting stays removed.</p>
    </div>
  );
}

export function CompareChart({
  rec,
  job,
  providers,
  providerOf,
  listPrice = false,
}: {
  rec: Recommendation;
  job: string;
  providers: string[];
  providerOf: (model: string) => string | null | undefined;
  listPrice?: boolean;
}) {
  const [selected, setSelected] = useState<string | null>(null);
  const tableId = useId();
  const notComparable = rec.evidence?.state === "not_comparable";
  const allowed = (m: string) => providers.length === 0 || (!!providerOf(m) && providers.includes(providerOf(m) as string));
  const rows = buildRows(rec, allowed);
  const drawn = rows.filter(plottable);
  const missing = notDrawn(rows);
  if (rows.length === 0) return null;

  const reference = rows.find((r) => r.model === rec.reference);
  const goodLine = !notComparable && reference?.rate != null ? reference.rate - rec.rules.margin : null;
  const floor = yFloor(rows, goodLine);
  const pts: Pt[] = drawn.map((r) => ({
    model: r.model, x: r.cost1000 as number, y: r.rate as number, current: r.isCurrent, selected: r.model === selected, row: r,
    err: [(r.rate as number) - (r.low ?? (r.rate as number)), (r.high ?? (r.rate as number)) - (r.rate as number)],
  }));
  // A model that costs nothing sits at zero, which a log scale cannot draw: log only when every point is above zero.
  const xs = pts.map((p) => p.x);
  const positive = xs.filter((v) => v > 0);
  const allPositive = positive.length === xs.length && xs.length > 0;
  const xMax = (positive.length ? Math.max(...positive) : 1) * 1.15;
  const xMin = allPositive ? Math.min(...positive) / 1.3 : 0;
  const useLog = allPositive && xMax / xMin > 8;
  const chosen = rows.find((r) => r.model === selected) ?? null;

  const columns = ["Model", "Verdict of the rule", listPrice ? "List price per 1,000 correct" : "Cost per 1,000 correct", "Correct answers", "Checked answers", "One call"];
  const tableRows = rows.map((r) => [
    r.model + (r.isCurrent ? " (in use)" : ""),
    notComparable ? "Not compared" : STATUS_WORDS[r.status],
    costText(r, false),
    rateText(r),
    `${r.checked.toLocaleString("en")}${r.retests ? ` (${r.retests.toLocaleString("en")} from trials)` : ""}`,
    callText(r),
  ]);

  return (
    <ChartFrame
      title="Cost against quality, on your own work"
      hint={`Left is cheaper, higher is more correct answers. Whiskers show the engine's range, so a short whisker means more checked answers. The correct-answers axis starts at ${Math.round(floor * 100)}%, not zero${useLog ? ", and the cost axis is logarithmic (each step is a multiple)" : ""}.`}
      legend={[
        { name: "Model in use (square)", color: "var(--color-accent)" },
        { name: "Another model you have run (circle)", color: "var(--color-accent-2, var(--color-accent))" },
      ]}
      table={{ columns, rows: tableRows }}
    >
      {notComparable && (
        <p role="note" className="rounded-[10px] border border-warn/40 bg-warn-soft px-3 py-2 text-xs text-ink" data-testid="not-comparable">
          {rec.evidence.state_note || "These models were not tried on the same prompt version, so they are not compared."} Their numbers are shown, but nothing is ranked and no line marks "good enough".
        </p>
      )}
      {pts.length > 0 ? (
        <div style={{ height: 320 }} className="w-full" role="img" aria-label={`Cost against correct answers for ${pts.length} models. The same numbers are in the table below.`}>
          <ResponsiveContainer>
            <ScatterChart margin={{ top: 16, right: 24, bottom: 28, left: 0 }}>
              <CartesianGrid stroke="var(--chart-grid)" />
              <XAxis
                type="number" dataKey="x" name="Cost" domain={[xMin, xMax]} scale={useLog ? "log" : "linear"} allowDataOverflow
                tickFormatter={(v: number) => usd(v)} tick={{ fill: "var(--chart-tick)", fontSize: 11 }} axisLine={{ stroke: "var(--chart-axis)" }} tickLine={false}
                label={{ value: listPrice ? "list price per 1,000 correct answers, not your bill (cheaper to the left)" : "cost per 1,000 correct answers (cheaper to the left)", position: "insideBottom", offset: -16, fill: "var(--chart-tick)", fontSize: 11 }}
              />
              <YAxis type="number" dataKey="y" name="Correct answers" domain={[floor, 1]} tickFormatter={(v: number) => `${Math.round(v * 100)}%`} tick={{ fill: "var(--chart-tick)", fontSize: 11 }} axisLine={false} tickLine={false} width={44} />
              {goodLine !== null && <ReferenceLine y={goodLine} stroke="var(--color-ok)" strokeOpacity={0.5} label={{ value: "good enough above this line", position: "insideTopRight", fill: "var(--color-ok)", fontSize: 10 }} />}
              <Tooltip
                cursor={{ stroke: "var(--chart-cursor)" }}
                content={({ payload }) => {
                  const p = payload?.[0]?.payload as Pt | undefined;
                  if (!p) return null;
                  return (
                    <TooltipCard
                      title={<span className="font-mono">{p.model}{p.current ? " (in use)" : ""}</span>}
                      rows={[
                        { label: listPrice ? "List price per 1,000 correct" : "Cost per 1,000 correct", value: costText(p.row, false) },
                        { label: "Correct answers", value: rateText(p.row) },
                        { label: "Checked answers", value: p.row.checked.toLocaleString("en") },
                      ]}
                    />
                  );
                }}
              />
              <Scatter name="Measured" data={pts} shape={<Dot />} isAnimationActive={false} onClick={(d: unknown) => { const m = (d as { model?: string; payload?: { model?: string } }); const name = m.payload?.model ?? m.model; if (name) setSelected((s) => (s === name ? null : name)); }}>
                <ErrorBar dataKey="err" direction="y" width={7} stroke="var(--color-dim)" strokeWidth={2} isAnimationActive={false} />
              </Scatter>
            </ScatterChart>
          </ResponsiveContainer>
        </div>
      ) : (
        <p className="text-sm text-dim" data-testid="nothing-drawn">No model on this task has both a price and checked answers yet, so there is nothing to draw. The table lists each model and what is missing.</p>
      )}

      {missing.length > 0 && (
        <ul className="space-y-0.5 text-xs text-muted" data-testid="not-drawn" aria-label="Models not drawn">
          {missing.map((m) => (
            <li key={m.model}><span className="font-mono text-dim">{m.model}</span> is not drawn: {m.reason}.</li>
          ))}
        </ul>
      )}

      <div role="group" aria-label="Choose a model to see its numbers" className="flex flex-wrap gap-1.5">
        {rows.map((r) => (
          <button
            key={r.model} type="button" aria-pressed={selected === r.model} aria-controls={tableId}
            onClick={() => setSelected((s) => (s === r.model ? null : r.model))}
            className={cx("rounded-full border px-3 py-1 font-mono text-xs font-semibold transition-colors", selected === r.model ? "border-accent bg-accent-soft text-accent-ink" : "border-rule text-dim hover:bg-surface-2")}
          >
            {r.model}
          </button>
        ))}
      </div>
      <div id={tableId} aria-live="polite">{chosen ? <Detail r={chosen} job={job} notComparable={notComparable} /> : <p className="text-xs text-muted">Choose a model above, or a dot, to see its numbers and its AI calls.</p>}</div>

      <div className="scroll-hint-x overflow-auto rounded-[12px] border border-rule" tabIndex={0} role="region" aria-label="Table of every model this task has run">
        <table className="w-full border-collapse text-left text-xs">
          <caption className="sr-only">Every model this task has run, with its cost, correct answers and checked answers</caption>
          <thead className="bg-surface-2">
            <tr>{columns.map((c) => <th key={c} scope="col" className="whitespace-nowrap px-3 py-2 font-semibold uppercase tracking-wider text-muted">{c}</th>)}</tr>
          </thead>
          <tbody className="tabular">
            {tableRows.map((cells, i) => (
              <tr key={rows[i].model} className="border-t border-rule">
                {cells.map((cell, j) => (
                  <td key={j} className={j === 0 ? "whitespace-nowrap px-3 py-1.5 font-mono text-ink" : "px-3 py-1.5 text-dim"}>{cell}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-muted" data-testid="own-work">
        Everything on this page was measured on your own task: {rows.reduce((a, r) => a + r.checked, 0).toLocaleString("en")} checked answers in all. Nothing comes from public benchmarks.
      </p>
    </ChartFrame>
  );
}
