import {
  ResponsiveContainer,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
} from "recharts";
import type { SpendInsight } from "../../../shared/api/types";

interface CustomTooltipProps {
  active?: boolean;
  payload?: Array<{ payload: SpendInsight }>;
}

function SpendTooltip({ active, payload }: CustomTooltipProps) {
  if (!active || !payload || !payload.length) return null;
  const item = payload[0].payload;
  return (
    <div className="rounded-card border border-rule bg-surface p-3 text-xs shadow-md space-y-1">
      <p className="font-bold text-ink">{item.job}</p>
      <div className="flex justify-between gap-4 text-dim">
        <span>Spend:</span>
        <span className="font-mono font-semibold text-ink">
          ${item.spend_usd.toFixed(2)}
        </span>
      </div>
      <div className="flex justify-between gap-4 text-dim">
        <span>Runs:</span>
        <span className="font-mono font-semibold text-ink">
          {item.runs.toLocaleString()}
        </span>
      </div>
      <div className="flex justify-between gap-4 text-dim">
        <span>Share:</span>
        <span className="font-mono font-semibold text-ink">
          {(item.share * 100).toFixed(1)}%
        </span>
      </div>
    </div>
  );
}

export function SpendBarChart({ data }: { data: SpendInsight[] }) {
  // Height scales with data length to avoid cramped horizontal bars
  const chartHeight = Math.max(240, data.length * 60 + 50);

  return (
    <div className="w-full" style={{ height: `${chartHeight}px` }}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart
          layout="vertical"
          data={data}
          margin={{ top: 15, right: 30, left: 30, bottom: 15 }}
        >
          <CartesianGrid
            strokeDasharray="3 3"
            stroke="var(--color-rule)"
            horizontal={false}
            vertical={true}
          />
          <XAxis
            type="number"
            tickFormatter={(v: number) => `$${v}`}
            stroke="var(--color-dim)"
            tick={{ fill: "var(--color-dim)", fontSize: 12 }}
          />
          <YAxis
            dataKey="job"
            type="category"
            stroke="var(--color-dim)"
            tick={{ fill: "var(--color-dim)", fontSize: 12 }}
            width={120}
          />
          <Tooltip
            content={<SpendTooltip />}
            cursor={{ fill: "var(--color-accent-soft)", opacity: 0.3 }}
          />
          <Bar
            dataKey="spend_usd"
            fill="var(--color-accent)"
            radius={[0, 4, 4, 0]}
            maxBarSize={36}
          />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
