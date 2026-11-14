/** The "About this task" card: what it does, how answers are judged, and this month at a glance. */
import { useState } from "react";
import { checkExplanation, monthLine, summarizeMonth } from "../../features/jobs/aboutTask";
import { useUpdateJobDescription } from "../../features/jobs/hooks/useJobs";
import { TASK_EXPLAINER } from "../../features/jobs/jobTitle";
import { useDaily } from "../../features/insights/api/dailyApi";
import type { Job } from "../../shared/api/types";
import { Button, Panel } from "../../ui/primitives";

export function AboutTask({ job }: { job: Job }) {
  const daily = useDaily({ job: job.name, days: 30 });
  const line = daily.isPending ? "Loading this month..." : monthLine(summarizeMonth(daily.data ?? []));
  return (
    <Panel className="flex flex-col gap-3 p-4 md:p-5">
      <h2 className="text-sm font-semibold text-ink">About this task</h2>
      <p className="text-xs text-muted">{TASK_EXPLAINER}</p>
      <div>
        <p className="text-[11px] font-semibold uppercase tracking-wider text-muted">What it does</p>
        <Description job={job} />
      </div>
      <div>
        <p className="text-[11px] font-semibold uppercase tracking-wider text-muted">How we decide an answer is correct</p>
        <p className="mt-1 text-sm text-dim">{checkExplanation(job).join(" ")}</p>
      </div>
      <div>
        <p className="text-[11px] font-semibold uppercase tracking-wider text-muted">This month at a glance</p>
        <p className="tabular mt-1 text-sm text-ink">{line}</p>
        <details className="mt-1 text-xs text-muted">
          <summary className="cursor-pointer">What are tokens?</summary>
          <p className="mt-1">Tokens are the small pieces of text AI models are billed by. Longer prompts and answers use more tokens.</p>
        </details>
      </div>
    </Panel>
  );
}

function Description({ job }: { job: Job }) {
  const save = useUpdateJobDescription(job.name);
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState("");
  const begin = () => {
    setText(job.description ?? "");
    save.reset();
    setEditing(true);
  };
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    save.mutate(text.trim() || null, { onSuccess: () => setEditing(false) });
  };
  if (editing) {
    return (
      <form onSubmit={submit} className="mt-1 flex max-w-2xl flex-col gap-2">
        <label htmlFor="task-description" className="text-xs font-semibold text-dim">What does this task do?</label>
        <textarea
          id="task-description"
          rows={2}
          maxLength={500}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Pull the total amount out of an invoice"
          className="rounded-[10px] border border-rule bg-surface px-3 py-2 text-sm text-ink outline-none placeholder:text-muted focus:border-accent"
        />
        {save.isError && (
          <p role="alert" className="text-xs text-bad">We could not save the description. Check your connection and try again.</p>
        )}
        <div className="flex gap-2">
          <Button type="submit" variant="primary" disabled={save.isPending}>{save.isPending ? "Saving..." : "Save"}</Button>
          <Button type="button" onClick={() => setEditing(false)}>Cancel</Button>
        </div>
      </form>
    );
  }
  return (
    <p className="mt-1 max-w-2xl text-sm text-dim">
      {job.description ? job.description : <span className="text-muted">No description yet. Add one so your team knows what this does.</span>}{" "}
      <button type="button" onClick={begin} className="text-xs font-semibold text-accent hover:underline">
        {job.description ? "Edit" : "Add a description"}
      </button>
    </p>
  );
}

