import { useState } from "react";
import { JobsTable } from "../features/jobs/components/JobsTable";
import { JobCreatePanel } from "../features/jobs/components/JobCreatePanel";
import { useJobs } from "../features/jobs/hooks/useJobs";
import { QueryState } from "../shared/components/QueryState";
import { PageHeader } from "../shared/components/PageHeader";

export default function JobsPage() {
  const query = useJobs();
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [notification, setNotification] = useState<string | null>(null);

  return (
    <>
      <PageHeader
        title="Jobs"
        subtitle="The tasks your team sends to AI models."
        actions={
          <button
            type="button"
            onClick={() => setIsCreateOpen(true)}
            className="rounded-md bg-accent px-4 py-2 text-sm font-semibold text-on-accent shadow-sm hover:opacity-90"
          >
            New job
          </button>
        }
      />

      {notification && (
        <div
          role="status"
          className="mb-4 flex items-center justify-between rounded-md border border-ok bg-ok-soft p-3 text-sm font-medium text-ok"
        >
          <span>{notification}</span>
          <button
            type="button"
            onClick={() => setNotification(null)}
            className="text-xs font-semibold text-ok hover:underline"
          >
            Dismiss
          </button>
        </div>
      )}

      <QueryState
        query={query}
        emptyTitle="No jobs yet"
        emptyHint="Define a job to start recording runs."
      >
        {(jobs) => <JobsTable jobs={jobs} />}
      </QueryState>

      <JobCreatePanel
        isOpen={isCreateOpen}
        onClose={() => setIsCreateOpen(false)}
        onSuccess={(msg) => setNotification(msg)}
      />
    </>
  );
}
