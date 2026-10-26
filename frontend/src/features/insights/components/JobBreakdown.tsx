import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { Breakdown } from "../../../shared/api/types";
import { Card } from "../../../shared/components/Card";
import { QueryState } from "../../../shared/components/QueryState";
import { Table, type Column } from "../../../shared/components/Table";
import { useJobInsights } from "../hooks/useSpendInsights";

const SERIES = ["var(--color-accent)", "var(--color-ok)", "var(--color-warn)", "var(--color-bad)", "var(--color-dim)"];
const BAND_ORDER = ["under 8k", "8k to 32k", "over 32k"];

/** One row per group, one column per model: the shape a grouped bar chart wants. */
function pivot(rows: Breakdown[], order?: string[]) {
  const models = [...new Set(rows.map((r) => r.model))];
  const groups = [...new Set(rows.map((r) => r.group))].sort(
    (a, b) => (order ? order.indexOf(a) - order.indexOf(b) : a.localeCompare(b)),
  );
  const data = groups.map((group) => {
    const row: Record<string, string | number> = { group };
    for (const model of models) {
      const hit = rows.find((r) => r.model === model && r.group === group);
      if (hit) {
        row[model] = Math.round(hit.pass_rate * 1000) / 10;
        row[`${model} runs`] = hit.runs;
      }
    }
    return row;
  });
  return { models, data };
}

function PassRateChart({ title, rows, order }: { title: string; rows: Breakdown[]; order?: string[] }) {
  const { models, data } = pivot(rows, order);
  return (
    <Card className="space-y-3">
      <h3 className="text-base font-bold tracking-tight text-ink">{title}</h3>
      {data.length === 0 ? (
        <p className="text-xs text-dim">No checked runs yet.</p>
      ) : (
        <div className="h-64 w-full">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--color-rule)" vertical={false} />
              <XAxis dataKey="group" stroke="var(--color-dim)" tick={{ fill: "var(--color-dim)", fontSize: 12 }} />
              <YAxis domain={[0, 100]} unit="%" stroke="var(--color-dim)" tick={{ fill: "var(--color-dim)", fontSize: 12 }} />
              <Tooltip
                cursor={{ fill: "var(--color-accent-soft)", opacity: 0.3 }}
                contentStyle={{ background: "var(--color-surface)", border: "1px solid var(--color-rule)", fontSize: 12 }}
                formatter={(value, name, item) => [
                  `${value}% of ${(item.payload as Record<string, number>)[`${name} runs`]} runs`,
                  name,
                ]}
              />
              <Legend wrapperStyle={{ fontSize: 12 }} />
              {models.map((model, i) => (
                <Bar key={model} dataKey={model} fill={SERIES[i % SERIES.length]} radius={[3, 3, 0, 0]} />
              ))}
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}
    </Card>
  );
}

const columns: Column<Breakdown>[] = [
  { key: "model", header: "Model", render: (r) => <span className="font-mono font-semibold text-ink">{r.model}</span> },
  { key: "runs", header: "Runs", render: (r) => <span className="font-mono">{r.runs.toLocaleString()}</span> },
  {
    key: "pass",
    header: "Pass rate",
    render: (r) => (
      <span className="font-mono">
        {(r.pass_rate * 100).toFixed(1)}%{" "}
        <span className="text-[11px] text-dim">
          ({(r.pass_rate_low * 100).toFixed(1)}–{(r.pass_rate_high * 100).toFixed(1)}%)
        </span>
      </span>
    ),
  },
  { key: "cost", header: "Mean cost", render: (r) => <span className="font-mono">${r.mean_cost_usd.toFixed(4)}</span> },
  {
    key: "cps",
    header: "Cost per success",
    render: (r) => (
      <span className="font-mono">{r.cost_per_success_usd !== null ? `$${r.cost_per_success_usd.toFixed(4)}` : "-"}</span>
    ),
  },
];

/** Where each model is strong or weak: a cheap model may be fine for short documents only. */
export default function JobBreakdown({ jobName }: { jobName: string }) {
  const query = useJobInsights(jobName);
  return (
    <QueryState query={query} emptyTitle="No checked runs in the last 90 days.">
      {(insights) => (
        <div className="space-y-6">
          <Card className="space-y-3">
            <h3 className="text-base font-bold tracking-tight text-ink">Cost per successful run, by model</h3>
            <Table columns={columns} rows={insights.overall} rowKey={(r) => r.model} />
          </Card>
          <PassRateChart title="Pass rate by input size" rows={insights.by_input_size} order={BAND_ORDER} />
          <PassRateChart title="Pass rate by prompt version" rows={insights.by_prompt_version} />
          <p className="text-xs text-dim">
            Last {insights.days} days of checked runs. Every figure is a count or a rate over recorded runs, with the
            range where the true rate likely lies; a group with few runs is shown, but should not decide anything.
          </p>
        </div>
      )}
    </QueryState>
  );
}
