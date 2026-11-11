import { Link } from "react-router-dom";
import { PageHeader } from "../shared/components/PageHeader";
import { Card } from "../shared/components/Card";
import { QueryState } from "../shared/components/QueryState";
import { Table, type Column } from "../shared/components/Table";
import type { SpendInsight } from "../shared/api/types";
import { useSpendInsights } from "../features/insights/hooks/useSpendInsights";
import { SpendBarChart } from "../features/insights/components/SpendBarChart";

const columns: Column<SpendInsight>[] = [
  {
    key: "job",
    header: "Job",
    render: (row) => (
      <Link
        to={`/jobs/${encodeURIComponent(row.job)}`}
        className="font-semibold text-accent hover:underline"
      >
        {row.job}
      </Link>
    ),
  },
  {
    key: "runs",
    header: "Runs",
    render: (row) => (
      <span className="font-mono text-ink">{row.runs.toLocaleString()}</span>
    ),
  },
  {
    key: "spend",
    header: "Spend",
    render: (row) => (
      <div className="flex flex-col">
        <span className="font-mono text-ink">${row.spend_usd.toFixed(2)}</span>
        {row.unpriced_runs > 0 && (
          <span className="text-[11px] text-warn">
            + {row.unpriced_runs.toLocaleString()} {row.unpriced_runs === 1 ? "run" : "runs"} with no known price
          </span>
        )}
      </div>
    ),
  },
  {
    key: "share",
    header: "Share",
    render: (row) => (
      <span className="font-mono text-ink">
        {(row.share * 100).toFixed(1)}%
      </span>
    ),
  },
];

export default function SpendPage() {
  const query = useSpendInsights();

  return (
    <>
      <PageHeader
        title="Spend"
        subtitle="Spend breakdown across registered jobs."
        actions={
          <Link
            to="/jobs"
            className="rounded-md border border-rule bg-surface px-3 py-1.5 text-xs font-semibold text-ink hover:bg-bg"
          >
            Manage jobs →
          </Link>
        }
      />

      <QueryState
        query={query}
        emptyTitle="No spend data available"
        emptyHint="Record production runs to start measuring spend across jobs."
      >
        {(data) => (
          <div className="space-y-6">
            {/* Chart Card */}
            <Card className="space-y-3">
              <div className="flex items-center justify-between">
                <h3 className="text-base font-bold tracking-tight text-ink">
                  Spend by Job
                </h3>
                <span className="text-xs text-dim">
                  Total: $
                  {data
                    .reduce((sum, item) => sum + item.spend_usd, 0)
                    .toFixed(2)}
                </span>
              </div>
              <SpendBarChart data={data} />
            </Card>

            {/* Breakdown Table */}
            <div className="space-y-2">
              <h3 className="text-sm font-bold tracking-tight text-ink">
                Breakdown
              </h3>
              <Table
                columns={columns}
                rows={data}
                rowKey={(row) => row.job}
              />
            </div>
          </div>
        )}
      </QueryState>
    </>
  );
}
