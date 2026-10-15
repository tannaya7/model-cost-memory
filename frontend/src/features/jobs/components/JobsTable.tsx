import type { Job } from "../../../shared/api/types";
import { Badge } from "../../../shared/components/Badge";
import { Table, type Column } from "../../../shared/components/Table";

const columns: Column<Job>[] = [
  { key: "name", header: "Name", render: (j) => <span className="font-semibold text-ink">{j.name}</span> },
  { key: "desc", header: "Description", render: (j) => j.description ?? "-" },
  {
    key: "check",
    header: "Check",
    render: (j) => {
      if (!j.check_kind) return "-";
      const label =
        j.check_kind === "ANSWER_KEY"
          ? "Answer key"
          : j.check_kind === "SCHEMA"
          ? "Schema"
          : j.check_kind;
      return <Badge tone="accent">{label}</Badge>;
    },
  },
  {
    key: "retest",
    header: "Re-test",
    render: (j) => <Badge tone={j.retest_consent ? "ok" : "neutral"}>{j.retest_consent ? "on" : "off"}</Badge>,
  },
  {
    key: "runs",
    header: "Runs",
    render: (j) => <span className="font-mono text-sm font-semibold text-ink">{j.run_count.toLocaleString()}</span>,
  },
  {
    key: "runs_by_state",
    header: "Runs by state",
    render: (j) => {
      const entries = Object.entries(j.runs_by_state ?? {}).filter(([_, count]) => count > 0);
      if (entries.length === 0) return <span className="text-dim">-</span>;
      return (
        <div className="flex flex-wrap gap-1.5">
          {entries.map(([state, count]) => (
            <span
              key={state}
              className="inline-flex items-center gap-1 rounded bg-bg px-1.5 py-0.5 text-xs font-mono text-dim border border-rule"
            >
              <span className="font-medium text-ink">{state}</span>
              <span className="font-bold text-accent">{count.toLocaleString()}</span>
            </span>
          ))}
        </div>
      );
    },
  },
];

export function JobsTable({ jobs }: { jobs: Job[] }) {
  return <Table columns={columns} rows={jobs} rowKey={(j) => j.job_id} />;
}
