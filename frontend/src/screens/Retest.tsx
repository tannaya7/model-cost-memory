/** Starting a re-test, and following one. Reached from a job's verdict or its Re-tests tab. */
import { useP } from "../app/project";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { RetestProgress } from "../features/retest/components/RetestProgress";
import { RetestStartPanel } from "../features/retest/components/RetestStartPanel";
import { useRetestStatus } from "../features/retest/hooks/useRetest";
import { IconArrowRight, IconFlask } from "../ui/icons";
import { EmptyState, ErrorState, Panel, Skeleton } from "../ui/primitives";

function Crumbs({ job, last }: { job: string; last: string }) {
  const p = useP();
  return (
    <nav aria-label="Breadcrumb" className="flex items-center gap-1.5 text-sm text-muted">
      <Link to={p("/jobs")} className="hover:text-ink">Jobs</Link>
      {job && (
        <>
          <IconArrowRight size={13} />
          <Link to={p(`/jobs/${encodeURIComponent(job)}?tab=retests`)} className="font-mono hover:text-ink">{job}</Link>
        </>
      )}
      <IconArrowRight size={13} />
      <span className="text-dim">{last}</span>
    </nav>
  );
}

export function RetestStart() {
  const [params] = useSearchParams();
  const job = params.get("job") ?? "";
  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-5">
      <Crumbs job={job} last="New re-test" />
      <header>
        <h1 className="flex items-center gap-2.5 text-3xl font-semibold tracking-tight"><IconFlask size={26} className="text-accent" /> Try a model on your own prompts</h1>
        <p className="mt-1 max-w-2xl text-sm text-dim">
          A sample of this job's past prompts is sent to the model you choose, each answer is checked the same way as in production, and the
          results join the evidence. Production is not touched.
        </p>
      </header>
      <Panel className="p-5 md:p-6">
        <RetestStartPanel />
      </Panel>
    </div>
  );
}

export function RetestRun() {
  const { retestId = "" } = useParams<{ retestId: string }>();
  const [params] = useSearchParams();
  const job = params.get("job") ?? "";
  const query = useRetestStatus(job, retestId);
  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-5">
      <Crumbs job={job} last="Re-test" />
      {!job || !retestId ? (
        <EmptyState title="This re-test link is incomplete" hint="Open re-tests from a job's Re-tests tab." />
      ) : query.isPending ? (
        <Skeleton className="h-64" />
      ) : query.isError ? (
        <ErrorState error={query.error} onRetry={() => query.refetch()} />
      ) : (
        <Panel glow className="p-5 md:p-6">
          <RetestProgress retest={query.data!} />
        </Panel>
      )}
    </div>
  );
}

export function NotFound() {
  const p = useP();
  return (
    <div className="flex flex-col items-center gap-4 py-24 text-center">
      <p className="text-gradient text-7xl font-semibold tracking-tight">404</p>
      <p className="text-lg font-semibold">This page does not exist</p>
      <Link to={p("/")} className="text-sm font-semibold text-accent hover:underline">Back to the overview</Link>
    </div>
  );
}
