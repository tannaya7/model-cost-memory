/** Cost against pass rate for one job. Models the job has run are filled points at their measured cost per
 * 1,000 good answers. Catalog models it has not run are hollow points on the bottom axis, at an estimated
 * cost per 1,000 answers, because their quality has not been tested. */
import { CartesianGrid, ReferenceLine, ResponsiveContainer, Scatter, ScatterChart, Tooltip, XAxis, YAxis } from "recharts";
import type { Model, Recommendation } from "../../shared/api/types";
import { ChartFrame, TooltipCard } from "../../ui/charts/ChartFrame";
import { pct, usd } from "../../ui/format";
import { estimateRunCost, untestedModels } from "./suggest";
import { rangeOf, tooFewFor, TOO_FEW_LABEL, UNTESTED_LABEL, type ApiEvidence } from "./wilson";

interface Pt {
  model: string;
  x: number;
  y: number;
  tested: boolean;
  runs?: number;
  api?: ApiEvidence;
}


function Dot(props: { cx?: number; cy?: number; payload?: Pt }) {
  const { cx = 0, cy = 0, payload } = props;
  if (!payload) return null;
  return payload.tested ? (
    <circle cx={cx} cy={cy} r={7} fill="var(--color-accent)" stroke="var(--color-surface)" strokeWidth={2} />
  ) : (
    <circle cx={cx} cy={cy} r={6} fill="var(--color-surface)" stroke="var(--color-dim)" strokeWidth={2} strokeDasharray="3 2" />
  );
}

/** "81.0% (72% to 88%)", or the plain too-few label when under about 30 checked answers. */
function rateWithRange(rate: number, n: number | undefined, api?: ApiEvidence): string {
  if (tooFewFor(n, api)) return `${pct(rate)}. ${TOO_FEW_LABEL}`;
  const ci = rangeOf(rate, n, api);
  return ci ? `${pct(rate)} (${pct(ci.low, 0)} to ${pct(ci.high, 0)})` : pct(rate);
}

export function CompareChart({
  rec,
  catalog,
  avgTokens,
  providers,
  listPrice = false,
}: {
  listPrice?: boolean;
  rec: Recommendation;
  catalog: Model[];
  avgTokens: { in: number; out: number } | null;
  providers: string[];
}) {
  const okProvider = (p: string | null | undefined) => providers.length === 0 || (!!p && providers.includes(p));
  const providerOf = (model: string) => catalog.find((c) => c.model === model || c.model.startsWith(model))?.provider;
  const tested: Pt[] = rec.models
    .filter((m) => m.cost_per_success_usd && m.weighted_pass_rate !== null && okProvider(providerOf(m.model)))
    .map((m) => ({ model: m.model, x: (m.cost_per_success_usd as number) * 1000, y: m.weighted_pass_rate as number, tested: true, runs: m.n_runs, api: m }));
  const reference = rec.models.find((m) => m.model === rec.reference);
  const floor = reference?.weighted_pass_rate != null ? reference.weighted_pass_rate - rec.rules.margin : null;
  const lower = Math.max(0, Math.floor((Math.min(...tested.map((p) => p.y), floor ?? 1) - 0.06) * 20) / 20);
  const untested: Pt[] = untestedModels(rec, catalog)
    .filter((m) => okProvider(m.provider))
    .flatMap((m) => {
      const c = estimateRunCost(m, avgTokens);
      return c == null ? [] : [{ model: m.model, x: c * 1000, y: lower, tested: false }];
    });
  if (tested.length + untested.length === 0) return null;
  // x is already the cost of 1,000 answers. A model that costs nothing to call (one you run yourself) sits at
  // zero, which a log scale cannot draw, so the scale is only logarithmic when every point is above zero.
  const xs = [...tested, ...untested].map((p) => p.x);
  const positive = xs.filter((v) => v > 0);
  const allPositive = positive.length === xs.length;
  const xMax = (positive.length ? Math.max(...positive) : 1) * 1.15;
  const xMin = allPositive ? Math.min(...positive) / 1.3 : 0;
  const useLog = allPositive && xMax / xMin > 8;

  const rows = [
    ...tested.map((p) => [p.model, "Measured", usd(p.x), rateWithRange(p.y, p.runs, p.api), `${p.runs?.toLocaleString("en")} checked answers`]),
    ...untested.map((p) => [p.model, "Estimate", usd(p.x), UNTESTED_LABEL, "none yet"]),
  ];

  return (
    <ChartFrame
      title="Cost against quality"
      hint="Left is cheaper, higher is more correct answers. Filled dots were measured; hollow dots are estimates from list prices, not tested."
      legend={[
        { name: "Measured on this AI task", color: "var(--color-accent)" },
        { name: "Not tested (estimated cost)", color: "var(--color-dim)", dashed: true },
      ]}
      table={{ columns: ["Model", "Source", listPrice ? "List price per 1,000 answers" : "Cost per 1,000 answers", "Correct answers", "Checked answers"], rows }}
    >
      <div style={{ height: 320 }} className="w-full">
        <ResponsiveContainer>
          <ScatterChart margin={{ top: 16, right: 24, bottom: 28, left: 0 }}>
            <CartesianGrid stroke="var(--chart-grid)" />
            <XAxis
              type="number"
              dataKey="x"
              name="Cost"
              domain={[xMin, xMax]}
              scale={useLog ? "log" : "linear"}
              allowDataOverflow
              tickFormatter={(v: number) => usd(v)}
              tick={{ fill: "var(--chart-tick)", fontSize: 11 }}
              axisLine={{ stroke: "var(--chart-axis)" }}
              tickLine={false}
              label={{ value: listPrice ? "list price per 1,000 answers, not your bill (further left uses less)" : "cost per 1,000 answers (cheaper to the left)", position: "insideBottom", offset: -16, fill: "var(--chart-tick)", fontSize: 11 }}
            />
            <YAxis
              type="number"
              dataKey="y"
              name="Correct answers"
              domain={[lower, 1]}
              tickFormatter={(v: number) => `${Math.round(v * 100)}%`}
              tick={{ fill: "var(--chart-tick)", fontSize: 11 }}
              axisLine={false}
              tickLine={false}
              width={44}
            />
            {floor !== null && (
              <ReferenceLine y={floor} stroke="var(--color-ok)" strokeOpacity={0.5} label={{ value: "good enough above this line", position: "insideTopRight", fill: "var(--color-ok)", fontSize: 10 }} />
            )}
            <Tooltip
              cursor={{ stroke: "var(--chart-cursor)" }}
              content={({ payload }) => {
                const p = payload?.[0]?.payload as Pt | undefined;
                if (!p) return null;
                return (
                  <TooltipCard
                    title={<span className="font-mono">{p.model}</span>}
                    rows={
                      p.tested
                        ? [
                            { label: listPrice ? "List price per 1,000 good answers" : "Cost per 1,000 good answers", value: usd(p.x) },
                            { label: "Correct answers", value: rateWithRange(p.y, p.runs, p.api) },
                            { label: "Checked answers", value: p.runs?.toLocaleString("en") ?? "–" },
                          ]
                        : [
                            { label: listPrice ? "Estimated list price per 1,000 answers" : "Estimated cost per 1,000 answers", value: usd(p.x) },
                            { label: "Correct answers", value: UNTESTED_LABEL },
                          ]
                    }
                  />
                );
              }}
            />
            <Scatter name="Measured" data={tested} shape={<Dot />} isAnimationActive={false} />
            <Scatter name="Not tested" data={untested} shape={<Dot />} isAnimationActive={false} />
          </ScatterChart>
        </ResponsiveContainer>
      </div>
      <div className="scroll-hint-x overflow-auto rounded-[12px] border border-rule">
        <table className="w-full border-collapse text-left text-xs">
          <thead className="bg-surface-2">
            <tr>
              {["Model", "Source", listPrice ? "List price per 1,000 answers" : "Cost per 1,000 answers", "Correct answers", "Checked answers"].map((c) => (
                <th key={c} className={`${c === "Source" ? "hidden sm:table-cell " : ""}whitespace-nowrap px-3 py-2 font-semibold uppercase tracking-wider text-muted${c.includes("per 1,000") ? " text-right" : ""}`}>{c}</th>
              ))}
            </tr>
          </thead>
          <tbody className="tabular">
            {rows.map((r, i) => (
              <tr key={i} className="border-t border-rule">
                {r.map((cell, j) => (
                  <td key={j} className={j === 0 ? "whitespace-nowrap px-3 py-1.5 font-mono text-ink" : j === 1 ? "hidden px-3 py-1.5 text-dim sm:table-cell" : j === 2 ? "whitespace-nowrap px-3 py-1.5 text-right text-dim" : "px-3 py-1.5 text-dim"}>{cell}{j === 0 && <span className="block font-sans text-[10px] text-muted sm:hidden">{r[1]}</span>}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </ChartFrame>
  );
}
