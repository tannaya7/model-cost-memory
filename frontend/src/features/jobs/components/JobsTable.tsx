import type { Job } from "../../../shared/api/types";
import { Badge } from "../../../shared/components/Badge";
import { Table, type Column } from "../../../shared/components/Table";

const columns: Column<Job>[] = [
  { key: "name", header: "Name", render: (j) => <span className="font-semibold">{j.name}</span> },
  { key: "desc", header: "Description", render: (j) => j.description ?? "-" },
  {
    key: "check",
    header: "Check",
    render: (j) => (j.check_kind ? <Badge tone="accent">{j.check_kind}</Badge> : "-"),
  },
  {
    key: "retest",
    header: "Re-test",
    render: (j) => <Badge tone={j.retest_consent ? "ok" : "neutral"}>{j.retest_consent ? "on" : "off"}</Badge>,
  },
];

export function JobsTable({ jobs }: { jobs: Job[] }) {
  return <Table columns={columns} rows={jobs} rowKey={(j) => j.id} />;
}
