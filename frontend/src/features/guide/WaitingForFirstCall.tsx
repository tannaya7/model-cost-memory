/** The empty state for a project whose app has not sent a call yet: what to do, in order, and a way to look again.
 * It shows no example numbers: every figure in the app comes from the project's own calls, so there is nothing to fake. */
import { useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { useP, useProject } from "../../app/project";
import { Button } from "../../ui/primitives";
import { useDaily } from "../insights/api/dailyApi";
import { useJobs } from "../jobs/hooks/useJobs";
import { FIRST_CALL_SNIPPET } from "./snippet";

/** True when the project is the viewer's own, its history has loaded, and no call has arrived: none in the last 90 days
 * and none recorded on any AI task (so a project whose calls are all older is never told it is waiting). */
export function useWaitingForFirstCall() {
  const { mode } = useProject();
  const daily = useDaily({ days: 90 });
  const jobs = useJobs();
  const total = (daily.data ?? []).reduce((s, d) => s + (d.runs ?? 0), 0);
  const anyRecorded = (jobs.data ?? []).some((j) => (j.run_count ?? 0) > 0);
  return {
    waiting: mode === "owned" && daily.isSuccess && jobs.isSuccess && total === 0 && !anyRecorded,
    checking: daily.isFetching || jobs.isFetching,
    check: () => {
      void jobs.refetch();
      return daily.refetch();
    },
  };
}

export function WaitingForFirstCall({ checking, onCheck }: { checking: boolean; onCheck: () => void }) {
  const p = useP();
  const queryClient = useQueryClient();
  return (
    <section aria-labelledby="waiting-title" data-testid="waiting" className="flex flex-col gap-4 rounded-[16px] border border-rule bg-surface-2/50 p-5 md:p-6">
      <div>
        <h2 id="waiting-title" className="text-lg font-semibold tracking-tight text-ink">Waiting for your first call</h2>
        <p className="mt-1 max-w-2xl text-sm text-dim">
          Nothing here is example data. Every number in this app comes from your own app's calls, so these pages stay empty until the first one arrives.
        </p>
      </div>
      <ol className="flex max-w-2xl flex-col gap-4 text-sm text-dim">
        <li>
          <span className="font-semibold text-ink">1. Create an AI task.</span> It is a name for one kind of work your code asks an AI to do, such as reading invoices.{" "}
          <Link to={p("/jobs")} className="font-semibold text-accent hover:underline">Create an AI task</Link>
        </li>
        <li>
          <span className="font-semibold text-ink">2. Put this around the AI call your code already makes.</span> Your project key is under{" "}
          <Link to={p("/settings#keys")} className="font-semibold text-accent hover:underline">API keys in Settings</Link>.
          <pre className="mt-2 overflow-x-auto rounded-[10px] border border-rule bg-surface p-3 text-xs text-ink" tabIndex={0} aria-label="Example code for your first call">{FIRST_CALL_SNIPPET}</pre>
        </li>
        <li>
          <span className="font-semibold text-ink">3. Run your app once, then look again.</span>{" "}
          <Button
            size="sm"
            disabled={checking}
            onClick={() => {
              void queryClient.invalidateQueries({ queryKey: ["jobs"] });
              onCheck();
            }}
          >
            {checking ? "Looking…" : "Check again"}
          </Button>
        </li>
      </ol>
      <p className="text-xs text-muted">
        Not ready to send calls? You can still{" "}
        <Link to={p("/compare")} className="font-semibold text-accent hover:underline">answer a few questions about your work</Link> to see which models are worth reading about. That is general information, not a result.
      </p>
    </section>
  );
}
