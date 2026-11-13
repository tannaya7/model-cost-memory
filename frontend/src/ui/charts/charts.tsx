/** The charts. Thin marks, hairline grids, one y-axis each, hover on every mark, a table twin. */
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  ErrorBar,
  Line,
  LineChart,
  ReferenceArea,
  ReferenceLine,
  ResponsiveContainer,
  Scatter,
  ScatterChart,
  Tooltip,
  XAxis,
  YAxis,
  ZAxis,
} from "recharts";
import { useReducedMotion } from "framer-motion";
import type { ModelEvidence } from "../../shared/api/types";
import { pct, shortDate, usd } from "../format";
import { CHART } from "./series";
import { TooltipCard } from "./ChartFrame";
import type { Row } from "./data";

const tickDay = (d: string) => shortDate(`${d}T00:00:00Z`);

/** Pass-rate ticks on round steps (5 points, or 10 when the range is wide) from `lower` to 100%. */
function evenTicks(lower: number): number[] {
  const step = 1 - lower > 0.3 ? 0.1 : 0.05;
  const out: number[] = [];
  for (let v = 1; v >= lower - 1e-9; v -= step) out.push(Math.round(v * 100) / 100);
  return out.reverse();
}

function useAnimate() {
  return !useReducedMotion();
}

/** Stacked spend per day, one band per job (or model). */
export function SpendArea({
  rows,
  names,
  colors,
  height = 260,
}: {
  rows: Row[];
  names: string[];
  colors: Map<string, string>;
  height?: number;
}) {
  const animate = useAnimate();
  return (
    <div style={{ height }} className="w-full">
      <ResponsiveContainer>
        <AreaChart data={rows} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
          <defs>
            {names.map((n, i) => (
              <linearGradient key={n} id={`spend-${i}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={colors.get(n)} stopOpacity={0.7} />
                <stop offset="100%" stopColor={colors.get(n)} stopOpacity={0.35} />
              </linearGradient>
            ))}
          </defs>
          <CartesianGrid stroke={CHART.grid} vertical={false} />
          <XAxis dataKey="day" tickFormatter={tickDay} tick={CHART.tickFont} axisLine={{ stroke: CHART.axis }} tickLine={false} minTickGap={28} />
          <YAxis tickFormatter={(v: number) => usd(v, { compact: true })} tick={CHART.tickFont} axisLine={false} tickLine={false} width={56} />
          <Tooltip
            cursor={{ stroke: "rgba(255,255,255,0.25)", strokeWidth: 1 }}
            content={({ active, payload, label }) =>
              active && payload?.length ? (
                <TooltipCard
                  title={tickDay(String(label))}
                  rows={[
                    ...payload
                      .filter((p) => Number(p.value) > 0)
                      .map((p) => ({ color: String(p.color), label: String(p.name), value: usd(Number(p.value)) })),
                    { label: "Total", value: usd(payload.reduce((s, p) => s + Number(p.value), 0)) },
                  ]}
                />
              ) : null
            }
          />
          {names.map((n, i) => (
            <Area
              key={n}
              type="monotone"
              dataKey={n}
              name={n}
              stackId="spend"
              stroke={colors.get(n)}
              strokeWidth={2}
              fill={`url(#spend-${i})`}
              isAnimationActive={animate}
              animationDuration={900}
            />
          ))}
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

export interface Marker {
  day: string;
  label: string;
  tone: "bad" | "info";
}

/** Pass rate per model over time (a trailing 7-day rate), with alerts and version changes marked. */
export function QualityLines({
  rows,
  names,
  colors,
  markers = [],
  floor,
  height = 280,
}: {
  rows: Row[];
  names: string[];
  colors: Map<string, string>;
  markers?: Marker[];
  floor?: number;
  height?: number;
}) {
  const animate = useAnimate();
  const values = rows.flatMap((r) => names.map((n) => r[n])).filter((v): v is number => typeof v === "number");
  const min = values.length ? Math.min(...values) : 0.8;
  const lower = Math.max(0, Math.floor((Math.min(min, floor ?? 1) - 0.03) * 20) / 20);
  return (
    <div style={{ height }} className="w-full">
      <ResponsiveContainer>
        <LineChart data={rows} margin={{ top: 18, right: 12, bottom: 0, left: 0 }}>
          <CartesianGrid stroke={CHART.grid} vertical={false} />
          <XAxis dataKey="day" tickFormatter={tickDay} tick={CHART.tickFont} axisLine={{ stroke: CHART.axis }} tickLine={false} minTickGap={28} />
          <YAxis
            domain={[lower, 1]}
            ticks={evenTicks(lower)}
            tickFormatter={(v: number) => pct(v, 0)}
            tick={CHART.tickFont}
            axisLine={false}
            tickLine={false}
            width={48}
          />
          {floor !== undefined && (
            <ReferenceLine y={floor} stroke="rgba(255,255,255,0.22)" strokeWidth={1} label={{ value: "good-enough line", position: "insideBottomLeft", fill: "#7d83a6", fontSize: 10 }} />
          )}
          {markers.map((m, i) => (
            <ReferenceLine
              key={`${m.day}-${i}`}
              x={m.day}
              stroke={m.tone === "bad" ? "var(--color-bad)" : "var(--color-accent)"}
              strokeWidth={1.5}
              strokeOpacity={0.8}
              label={{ value: m.label, position: "top", fill: m.tone === "bad" ? "#ff8f8f" : "#b4aaff", fontSize: 10 }}
            />
          ))}
          <Tooltip
            cursor={{ stroke: "rgba(255,255,255,0.25)", strokeWidth: 1 }}
            content={({ active, payload, label }) =>
              active && payload?.length ? (
                <TooltipCard
                  title={`${tickDay(String(label))} · last 7 days`}
                  rows={payload
                    .filter((p) => p.value !== null && p.value !== undefined)
                    .map((p) => ({ color: String(p.color), label: String(p.name), value: pct(Number(p.value)) }))}
                />
              ) : null
            }
          />
          {names.map((n) => (
            <Line
              key={n}
              type="monotone"
              dataKey={n}
              name={n}
              stroke={colors.get(n)}
              strokeWidth={2}
              dot={false}
              activeDot={{ r: 4, strokeWidth: 2, stroke: "var(--color-surface)" }}
              connectNulls
              isAnimationActive={animate}
              animationDuration={1000}
            />
          ))}
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

interface MapPoint {
  model: string;
  x: number;
  y: number;
  err: [number, number];
  runs: number;
  role: "recommended" | "current" | "both" | "other";
  status: string;
}

/** Each model at its cost per successful run (x) and pass rate (y), with its likely range. The shaded
 * band is "good enough": within the tolerance of the best model. Cheapest point inside it wins. */
export function CostQualityMap({
  models,
  colors,
  recommended,
  current,
  floor,
  height = 320,
}: {
  models: ModelEvidence[];
  colors: Map<string, string>;
  recommended?: string | null;
  current?: string | null;
  floor?: number | null;
  height?: number;
}) {
  const animate = useAnimate();
  const points: MapPoint[] = models
    .filter((m) => m.cost_per_success_usd && m.weighted_pass_rate !== null)
    .map((m) => {
      const y = m.weighted_pass_rate as number;
      const isRec = m.model === recommended;
      const isCur = m.model === current;
      return {
        model: m.model,
        x: m.cost_per_success_usd as number,
        y,
        err: [Math.max(0, y - (m.pass_rate_low ?? y)), Math.max(0, (m.pass_rate_high ?? y) - y)],
        runs: m.n_runs,
        role: isRec && isCur ? "both" : isRec ? "recommended" : isCur ? "current" : "other",
        status: m.status,
      };
    });
  if (points.length === 0) return null;
  const xs = points.map((p) => p.x);
  const spread = Math.max(...xs) / Math.min(...xs);
  const lows = points.map((p) => p.y - p.err[0]);
  const lower = Math.max(0, Math.floor((Math.min(...lows, floor ?? 1) - 0.02) * 20) / 20);
  const xDomain: [number, number] = [Math.min(...xs) / 1.6, Math.max(...xs) * 1.6];

  const Dot = (props: { cx?: number; cy?: number; payload?: MapPoint }) => {
    const { cx = 0, cy = 0, payload } = props;
    if (!payload) return null;
    const color = colors.get(payload.model) ?? "#888";
    const highlighted = payload.role === "recommended" || payload.role === "both";
    return (
      <g>
        {highlighted && (
          <circle cx={cx} cy={cy} r={14} fill="none" stroke="var(--color-accent)" strokeWidth={2} strokeOpacity={0.9}>
            {animate && <animate attributeName="r" values="12;16;12" dur="2.4s" repeatCount="indefinite" />}
          </circle>
        )}
        <circle cx={cx} cy={cy} r={7} fill={color} stroke="var(--color-surface)" strokeWidth={2} />
        <text x={cx + 13} y={cy - 9} fill="#eef0fa" fontSize={11} fontFamily="var(--font-mono)">
          {payload.model}
        </text>
        {payload.role !== "other" && (
          <text x={cx + 13} y={cy + 5} fill={highlighted ? "#b4aaff" : "#a3a9c7"} fontSize={10} fontWeight={600}>
            {payload.role === "both" ? "in use · recommended" : payload.role === "recommended" ? "recommended" : "in use now"}
          </text>
        )}
      </g>
    );
  };

  return (
    <div style={{ height }} className="w-full">
      <ResponsiveContainer>
        <ScatterChart margin={{ top: 36, right: 120, bottom: 18, left: 0 }}>
          <CartesianGrid stroke={CHART.grid} />
          {floor !== null && floor !== undefined && (
            <ReferenceArea y1={floor} y2={1} x1={xDomain[0]} x2={xDomain[1]} fill="var(--color-ok)" fillOpacity={0.06} stroke="none" />
          )}
          {floor !== null && floor !== undefined && (
            <ReferenceLine y={floor} stroke="var(--color-ok)" strokeOpacity={0.45} label={{ value: "good enough above this line", position: "insideTopRight", fill: "#6fdc9c", fontSize: 10 }} />
          )}
          <XAxis
            type="number"
            dataKey="x"
            name="Cost per successful run"
            scale={spread > 8 ? "log" : "linear"}
            domain={xDomain}
            tickFormatter={(v: number) => usd(v)}
            tick={CHART.tickFont}
            axisLine={{ stroke: CHART.axis }}
            tickLine={false}
            label={{ value: "cost per successful run →  (cheaper to the left)", position: "insideBottom", offset: -12, fill: "#7d83a6", fontSize: 11 }}
          />
          <YAxis
            type="number"
            dataKey="y"
            name="Pass rate"
            domain={[lower, 1]}
            ticks={evenTicks(lower)}
            tickFormatter={(v: number) => pct(v, 0)}
            tick={CHART.tickFont}
            axisLine={false}
            tickLine={false}
            width={48}
          />
          <ZAxis range={[200, 200]} />
          <Tooltip
            cursor={false}
            content={({ active, payload }) => {
              const p = active && payload?.[0]?.payload as MapPoint | undefined;
              return p ? (
                <TooltipCard
                  title={p.model}
                  rows={[
                    { label: "Pass rate", value: pct(p.y) },
                    { label: "Likely range", value: `${pct(p.y - p.err[0])} – ${pct(p.y + p.err[1])}` },
                    { label: "Cost per success", value: usd(p.x) },
                    { label: "Checked runs", value: p.runs.toLocaleString("en") },
                  ]}
                />
              ) : null;
            }}
          />
          <Scatter data={points} shape={<Dot />} isAnimationActive={animate} animationDuration={700}>
            <ErrorBar dataKey="err" direction="y" width={6} strokeWidth={1.5} stroke="rgba(238,240,250,0.45)" />
          </Scatter>
        </ScatterChart>
      </ResponsiveContainer>
    </div>
  );
}

/** A small trend line for a stat tile. */
export function Sparkline({ values, color = "var(--color-accent)", height = 36 }: { values: number[]; color?: string; height?: number }) {
  const animate = useAnimate();
  if (values.length < 2) return <div style={{ height }} />;
  const data = values.map((v, i) => ({ i, v }));
  const id = `spark-${color.replace(/[^a-z0-9]/gi, "")}`;
  return (
    <div style={{ height }} className="w-full" aria-hidden>
      <ResponsiveContainer>
        <AreaChart data={data} margin={{ top: 2, right: 0, bottom: 0, left: 0 }}>
          <YAxis hide domain={["dataMin", "dataMax"]} />
          <defs>
            <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={color} stopOpacity={0.4} />
              <stop offset="100%" stopColor={color} stopOpacity={0} />
            </linearGradient>
          </defs>
          <Area type="monotone" dataKey="v" stroke={color} strokeWidth={2} fill={`url(#${id})`} isAnimationActive={animate} animationDuration={900} />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

/** Pass rate per model within each group (input size, prompt version): grouped bars. */
export function GroupBars({
  rows,
  names,
  colors,
  height = 240,
}: {
  rows: Array<Record<string, string | number | null>>;
  names: string[];
  colors: Map<string, string>;
  height?: number;
}) {
  const animate = useAnimate();
  const values = rows.flatMap((r) => names.map((n) => r[n])).filter((v): v is number => typeof v === "number");
  const lower = values.length ? Math.max(0, Math.floor((Math.min(...values) - 0.05) * 10) / 10) : 0;
  return (
    <div style={{ height }} className="w-full">
      <ResponsiveContainer>
        <BarChart data={rows} margin={{ top: 8, right: 8, bottom: 0, left: 0 }} barGap={2} barCategoryGap="28%">
          <CartesianGrid stroke={CHART.grid} vertical={false} />
          <XAxis dataKey="group" tick={{ ...CHART.tickFont, fontFamily: "var(--font-sans)" }} axisLine={{ stroke: CHART.axis }} tickLine={false} />
          <YAxis domain={[lower, 1]} tickFormatter={(v: number) => pct(v, 0)} tick={CHART.tickFont} axisLine={false} tickLine={false} width={48} />
          <Tooltip
            cursor={{ fill: "rgba(255,255,255,0.04)" }}
            content={({ active, payload, label }) =>
              active && payload?.length ? (
                <TooltipCard
                  title={String(label)}
                  rows={payload
                    .filter((p) => p.value !== null && p.value !== undefined)
                    .map((p) => ({ color: String(p.color), label: String(p.name), value: pct(Number(p.value)) }))}
                />
              ) : null
            }
          />
          {names.map((n) => (
            <Bar key={n} dataKey={n} name={n} fill={colors.get(n)} radius={[4, 4, 0, 0]} maxBarSize={26} isAnimationActive={animate} animationDuration={800} />
          ))}
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

/** A ring showing how much of a limit is used. */
export function Ring({ share, size = 64, tone }: { share: number; size?: number; tone: "good" | "warn" | "bad" | "neutral" }) {
  const r = (size - 8) / 2;
  const c = 2 * Math.PI * r;
  const clamped = Math.max(0, Math.min(1, share));
  const color = { good: "var(--color-ok)", warn: "var(--color-warn)", bad: "var(--color-bad)", neutral: "var(--color-muted)" }[tone];
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-label={`${Math.round(clamped * 100)}% used`}>
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--color-surface-3)" strokeWidth={6} />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        stroke={color}
        strokeWidth={6}
        strokeLinecap="round"
        strokeDasharray={c}
        strokeDashoffset={c * (1 - clamped)}
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
        style={{ transition: "stroke-dashoffset 900ms cubic-bezier(.22,1,.36,1)" }}
      />
      <text x="50%" y="50%" dominantBaseline="central" textAnchor="middle" fill="#eef0fa" fontSize={size / 4.6} fontWeight={700}>
        {Math.round(clamped * 100)}%
      </text>
    </svg>
  );
}
