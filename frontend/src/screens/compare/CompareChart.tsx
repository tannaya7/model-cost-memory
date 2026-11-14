/** Cost against pass rate for one job. Models the job has run are filled points at their measured cost per
 * 1,000 good answers. Catalog models it has not run are hollow points on the bottom axis, at an estimated
 * cost per 1,000 answers, because their quality has not been tested. */
import { CartesianGrid, ReferenceLine, ResponsiveContainer, Scatter, ScatterChart, Tooltip, XAxis, YAxis } from "recharts";
import type { Model, Recommendation } from "../../shared/api/types";
import { ChartFrame, TooltipCard } from "../../ui/charts/ChartFrame";
import { pct, usd } from "../../ui/format";
import { estimateRunCost, untestedModels } from "./suggest";
import { isTooFew, TOO_FEW_LABEL, UNTESTED_LABEL, wilsonFromRate } from "./wilson";

interface Pt {
  model: string;
  x: number;
  y: number;
  tested: boolean;
  runs?: number;
}

const kilo = (v: number) => usd(v * 1000);

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
function rateWithRange(rate: number, n: number | undefined): string {
  if (isTooFew(n)) return `${pct(rate)}. ${TOO_FEW_LABEL}`;
  const ci = wilsonFromRate(rate, n);
  return ci ? `${pct(rate)} (${pct(ci.low, 0)} to ${pct(ci.high, 0)})` : pct(rate);
}

export function CompareChart({
  rec,
  catalog,
  avgTokens,
  providers,
}: {
  rec: Recommendation;
  catalog: Model[];
  avgTokens: { in: number; out: number } | null;
  providers: string[];
}) {
  const okProvider = (p: string | null | undefined) => providers.length === 0 || (!!p && providers.includes(p));
  const providerOf = (model: string) => catalog.find((c) => c.model === model || c.model.startsWith(model))?.provider;
  const tested: Pt[] = rec.models
    .filter((m) => m.cost_per_success_usd && m.weighted_pass_rate !== null && okProvider(providerOf(m.model)))
    .map((m) => ({ model: m.model, x: (m.cost_per_success_usd as number) * 1000, y: m.weighted_pass_rate as number, tested: true, runs: m.n_runs }));
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
  const xs = [...tested, ...untested].map((p) => p.x);
  const xMax = Math.max(...xs) * 1.15;
  const xMin = Math.min(...xs) / 1.3;

  const rows = [
    ...tested.map((p) => [p.model, "Measured", kilo(p.x), rateWithRange(p.y, p.runs), `${p.runs?.toLocaleString("en")} checked answers`]),
    ...untested.map((p) => [p.model, "Estimate", kilo(p.x), UNTESTED_LABEL, "none yet"]),
  ];

  return (
    <ChartFrame
      title="Cost against quality"
      hint="Each dot is a model. Further left is cheaper, higher is more correct answers. Filled dots were measured on this AI task. Hollow dots have not been used on it: their cost is an estimate from list prices and we have not tested how many answers they get right."
      legend={[
        { name: "Measured on this AI task", color: "var(--color-accent)" },
        { name: "Not tested (estimated cost)", color: "var(--color-dim)", dashed: true },
      ]}
      table={{ columns: ["Model", "Source", "Cost per 1,000 answers", "Correct answers", "Checked answers"], rows }}
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
              scale={xMax / xMin > 8 ? "log" : "linear"}
              allowDataOverflow
              tickFormatter={(v: number) => usd(v)}
              tick={{ fill: "var(--chart-tick)", fontSize: 11 }}
              axisLine={{ stroke: "var(--chart-axis)" }}
              tickLine={false}
              label={{ value: "cost per 1,000 answers (cheaper to the left)", position: "insideBottom", offset: -16, fill: "var(--chart-tick)", fontSize: 11 }}
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
                            { label: "Cost per 1,000 good answers", value: kilo(p.x / 1000) },
                            { label: "Correct answers", value: rateWithRange(p.y, p.runs) },
                            { label: "Checked answers", value: p.runs?.toLocaleString("en") ?? "–" },
                          ]
                        : [
                            { label: "Estimated cost per 1,000 answers", value: kilo(p.x / 1000) },
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
      <div className="overflow-auto rounded-[12px] border border-rule">
        <table className="w-full border-collapse text-left text-xs">
          <thead className="bg-surface-2">
            <tr>
              {["Model", "Source", "Cost per 1,000 answers", "Correct answers", "Checked answers"].map((c) => (
                <th key={c} className="px-3 py-2 font-semibold uppercase tracking-wider text-muted">{c}</th>
              ))}
            </tr>
          </thead>
          <tbody className="tabular">
            {rows.map((r, i) => (
              <tr key={i} className="border-t border-rule">
                {r.map((cell, j) => (
                  <td key={j} className={j === 0 ? "px-3 py-1.5 font-mono text-ink" : "px-3 py-1.5 text-dim"}>{cell}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </ChartFrame>
  );
}
