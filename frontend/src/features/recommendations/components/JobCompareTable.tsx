import type { ModelStat, Recommendation } from "../../../shared/api/types";
import { Badge } from "../../../shared/components/Badge";
import { Table, type Column } from "../../../shared/components/Table";

interface ModelRow extends ModelStat {
  why?: string;
}

function getStatusBadge(status: ModelStat["catalog_status"]) {
  switch (status) {
    case "ACTIVE":
      return <Badge tone="ok">ACTIVE</Badge>;
    case "DEPRECATED":
      return <Badge tone="warn">DEPRECATED</Badge>;
    case "RETIRED":
      return <Badge tone="neutral">RETIRED</Badge>;
    default:
      return <Badge tone="neutral">{status}</Badge>;
  }
}

export function JobCompareTable({
  recommendation,
}: {
  recommendation: Recommendation;
}) {
  const { candidates = [], excluded = [], rules, recommended, current_model, verdict } = recommendation;
  const tolerancePoints = Math.round((rules?.tolerance ?? 0.02) * 100);
  const evidenceFloor = rules?.evidence_floor ?? 25;

  // Combine candidates and excluded with no duplicate models
  const modelMap = new Map<string, ModelRow>();
  for (const c of candidates) {
    modelMap.set(c.model, { ...c });
  }
  for (const e of excluded) {
    if (modelMap.has(e.model)) {
      modelMap.set(e.model, { ...modelMap.get(e.model)!, ...e });
    } else {
      modelMap.set(e.model, { ...e });
    }
  }

  // Sort by pass rate high to low
  const rows = Array.from(modelMap.values()).sort(
    (a, b) => (b.weighted_pass_rate ?? 0) - (a.weighted_pass_rate ?? 0),
  );

  const columns: Column<ModelRow>[] = [
    {
      key: "model",
      header: "Model",
      render: (row) => (
        <div className="flex flex-col gap-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="font-mono font-semibold text-ink">{row.model}</span>
            {recommended?.model === row.model && (
              <Badge tone="accent">Recommended</Badge>
            )}
            {current_model === row.model && (
              <Badge tone="neutral">Current</Badge>
            )}
          </div>
          {row.latest_version && (
            <span className="font-mono text-xs text-dim">
              v: {row.latest_version}
            </span>
          )}
        </div>
      ),
    },
    {
      key: "status",
      header: "Status",
      render: (row) => getStatusBadge(row.catalog_status),
    },
    {
      key: "runs",
      header: "Runs",
      render: (row) => (
        <span className="font-mono text-ink">{row.n_runs.toLocaleString()}</span>
      ),
    },
    {
      key: "evidence",
      header: "Evidence",
      render: (row) => {
        const pct = Math.min(
          100,
          Math.max(0, Math.round((row.evidence_weight / evidenceFloor) * 100)),
        );
        return (
          <div className="space-y-1 min-w-[120px]">
            <div className="flex justify-between text-xs font-mono">
              <span className="text-ink">{row.evidence_weight.toFixed(1)}</span>
              <span className="text-dim">of {evidenceFloor}</span>
            </div>
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-skeleton">
              <div
                className="h-full rounded-full bg-accent transition-all duration-300"
                style={{ width: `${pct}%` }}
              />
            </div>
          </div>
        );
      },
    },
    {
      key: "pass_rate",
      header: "Pass rate",
      render: (row) => (
        <span className="font-mono text-ink">
          {(row.weighted_pass_rate * 100).toFixed(1)}%
        </span>
      ),
    },
    {
      key: "cost_per_success",
      header: "Cost per success",
      render: (row) => (
        <span className="font-mono text-ink">
          {row.cost_per_success_usd !== null && row.cost_per_success_usd !== undefined
            ? `$${row.cost_per_success_usd.toFixed(4)}`
            : "-"}
        </span>
      ),
    },
    {
      key: "eligible",
      header: "Eligible",
      render: (row) => {
        if (verdict === "INSUFFICIENT_EVIDENCE") {
          return (
            <div className="flex flex-wrap items-center gap-1.5">
              <Badge tone="neutral">No</Badge>
              <span className="text-xs text-dim">
                {row.why || "Not enough evidence yet"}
              </span>
            </div>
          );
        }

        if (row.eligible) {
          return <Badge tone="ok">Yes</Badge>;
        }

        const reason =
          row.why ||
          `More than ${tolerancePoints} points below the best pass rate`;

        return (
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge tone="neutral">No</Badge>
            <span className="text-xs text-dim">{reason}</span>
          </div>
        );
      },
    },
  ];

  return (
    <div className="space-y-3">
      {verdict === "INSUFFICIENT_EVIDENCE" && (
        <div className="rounded-md border border-rule bg-surface p-3 text-xs text-dim">
          <span className="font-semibold text-ink">Gathering evidence: </span>
          No model is eligible yet because none have reached the evidence floor of {evidenceFloor} weighted runs.
        </div>
      )}

      <Table
        columns={columns}
        rows={rows}
        rowKey={(row) => row.model}
        rowClassName={(row) =>
          recommended?.model === row.model ? "bg-accent-soft/40" : ""
        }
      />

      <p className="text-xs text-dim">
        A model is eligible if it has at least {evidenceFloor} weighted runs and is
        within {tolerancePoints} points of the best pass rate. The cheapest
        eligible model per successful run is recommended.
      </p>
    </div>
  );
}
