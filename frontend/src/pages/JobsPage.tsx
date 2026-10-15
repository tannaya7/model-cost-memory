import { JobsTable } from "../features/jobs/components/JobsTable";
import { useJobs } from "../features/jobs/hooks/useJobs";
import { QueryState } from "../shared/components/QueryState";
import { PageHeader } from "../shared/components/PageHeader";

export default function JobsPage() {
  const query = useJobs();
  return (
    <>
      <PageHeader title="Jobs" subtitle="The tasks your team sends to AI models." />
      <QueryState
        query={query}
        emptyTitle="No jobs yet"
        emptyHint="Define a job to start recording runs."
      >
        {(jobs) => <JobsTable jobs={jobs} />}
      </QueryState>
    </>
  );
}
