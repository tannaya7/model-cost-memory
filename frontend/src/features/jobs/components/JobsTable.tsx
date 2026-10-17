import { Link } from "react-router-dom";
import type { Job } from "../../../shared/api/types";
import { Badge } from "../../../shared/components/Badge";
import { Table, type Column } from "../../../shared/components/Table";

const RUN_STATES = [
  { key: "CAPTURED", label: "Captured", title: "Received, not yet checked" },
  { key: "CHECKED", label: "Checked", title: "Pass or fail decided" },
  { key: "INDEXED", label: "Indexed", title: "Stored and searchable" },
] as const;

const columns: Column<Job>[] = [
  {
    key: "name",
    header: "Name",
    render: (j) => (
      <div>
        <Link
          to={`/jobs/${encodeURIComponent(j.name)}`}
          className="font-semibold text-accent hover:underline"
        >
          {j.name}
        </Link>
        <div className="mt-0.5">
          <Link
            to={`/runs?job=${encodeURIComponent(j.name)}`}
            className="text-xs text-dim hover:text-accent"
          >
            View runs →
          </Link>
        </div>
      </div>
    ),
  },
  {
    key: "desc",
    header: "Description",
    render: (j) =>
      j.description ? (
        <span className="block max-w-xs truncate" title={j.description}>
          {j.description}
        </span>
      ) : (
        <span className="text-dim">-</span>
      ),
  },
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
    render: (j) => (
      <Badge tone={j.retest_consent ? "ok" : "neutral"}>
        {j.retest_consent ? "on" : "off"}
      </Badge>
    ),
  },
  {
    key: "runs",
    header: "Runs",
    render: (j) => (
      <span className="font-mono text-sm font-semibold text-ink">
        {j.run_count.toLocaleString()}
      </span>
    ),
  },
  {
    key: "runs_by_state",
    header: "Runs by state",
    render: (j) => {
      const hasRuns =
        (j.run_count && j.run_count > 0) ||
        RUN_STATES.some((s) => (j.runs_by_state?.[s.key] ?? 0) > 0);

      if (!hasRuns) {
        return <span className="text-dim">-</span>;
      }

      return (
        <div className="flex flex-wrap items-center gap-1.5">
          {RUN_STATES.map((state) => {
            const count = j.runs_by_state?.[state.key] ?? 0;
            return (
              <span
                key={state.key}
                title={state.title}
                className="inline-flex items-center gap-1.5 rounded-full bg-bg px-2.5 py-0.5 text-xs font-medium text-dim border border-rule cursor-help"
              >
                <span className="text-ink">{state.label}</span>
                <span className="font-mono font-bold text-accent">
                  {count.toLocaleString()}
                </span>
              </span>
            );
          })}
        </div>
      );
    },
  },
];

export function JobsTable({ jobs }: { jobs: Job[] }) {
  return <Table columns={columns} rows={jobs} rowKey={(j) => j.job_id} />;
}
