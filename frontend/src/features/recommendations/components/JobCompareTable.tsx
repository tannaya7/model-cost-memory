import type { ModelEvidence, Recommendation } from "../../../shared/api/types";
import { Badge } from "../../../shared/components/Badge";
import { Table, type Column } from "../../../shared/components/Table";
import { STATUS_LABELS, percent, range, ruleSentence } from "../evidence";

function getStatusBadge(status: ModelEvidence["catalog_status"]) {
  switch (status) {
    case "ACTIVE":
      return <Badge tone="ok">ACTIVE</Badge>;
    case "DEPRECATED":
      return <Badge tone="warn">DEPRECATED</Badge>;
    case "RETIRED":
      return <Badge tone="neutral">RETIRED</Badge>;
    default:
      return <Badge tone="neutral">Not in catalog</Badge>;
  }
}

export function JobCompareTable({
  recommendation,
}: {
  recommendation: Recommendation;
}) {
  const { models, rules, recommended, current, verdict } = recommendation;
  const evidenceFloor = rules.evidence_floor;

  // Sort by pass rate high to low; models without checked runs last
  const rows = [...models].sort(
    (a, b) => (b.weighted_pass_rate ?? -1) - (a.weighted_pass_rate ?? -1),
  );

  const columns: Column<ModelEvidence>[] = [
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
            {current?.model === row.model && (
              <Badge tone="neutral">Current</Badge>
            )}
          </div>
          <span className="font-mono text-xs text-dim">{row.model_version}</span>
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
        <div className="flex flex-col">
          <span className="font-mono text-ink">{percent(row.weighted_pass_rate)}</span>
          {range(row) && <span className="font-mono text-[11px] text-dim">{range(row)}</span>}
        </div>
      ),
    },
    {
      key: "cost_per_success",
      header: "Cost per success",
      render: (row) => (
        <span className="font-mono text-ink">
          {row.cost_per_success_usd !== null ? `$${row.cost_per_success_usd.toFixed(4)}` : "-"}
        </span>
      ),
    },
    {
      key: "judgement",
      header: "Judgement",
      render: (row) => (
        <div className="flex flex-col gap-1">
          <div>
            <Badge tone={STATUS_LABELS[row.status].tone}>{STATUS_LABELS[row.status].label}</Badge>
          </div>
          <span className="text-xs text-dim">{row.why}</span>
        </div>
      ),
    },
  ];

  return (
    <div className="space-y-3">
      {verdict === "INSUFFICIENT_EVIDENCE" && (
        <div className="rounded-md border border-rule bg-surface p-3 text-xs text-dim">
          <span className="font-semibold text-ink">Gathering evidence: </span>
          No model can be judged yet because none has reached the evidence floor of {evidenceFloor} weighted runs.
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
        {ruleSentence(recommendation)} The range under each pass rate is where the true rate
        likely lies.
      </p>
    </div>
  );
}
