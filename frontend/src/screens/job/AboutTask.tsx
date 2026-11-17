/** "What this task is": what you told us, what the calls prove, and an optional AI-written summary. */
import { tokensAre } from "../../features/projects/moneyWording";
import { useBillingMode } from "../../features/projects/hooks/useBillingMode";
import { useState } from "react";
import { checkExplanation, monthLine, profileFacts, summarizeMonth } from "../../features/jobs/aboutTask";
import { useDeleteTaskSummary, useTaskProfile, useTaskSummaryConsent, useUpdateJobDescription } from "../../features/jobs/hooks/useJobs";
import { TASK_EXPLAINER } from "../../features/jobs/jobTitle";
import { useDaily } from "../../features/insights/api/dailyApi";
import type { Job, TaskSummary } from "../../shared/api/types";
import { Help } from "../../ui/Help";
import { NotEnoughData } from "../../ui/NotEnoughData";
import { InlineConfirm } from "../../ui/InlineConfirm";
import { Button, Panel, Skeleton } from "../../ui/primitives";
import { useToast } from "../../ui/Toast";

const LABEL = "text-[11px] font-semibold uppercase tracking-wider text-muted";
const MAX_DESCRIPTION = 300;

export function AboutTask({ job }: { job: Job }) {
  const { mode: billing } = useBillingMode();
  const daily = useDaily({ job: job.name, days: 30 });
  const profile = useTaskProfile(job.name);
  const [open, setOpen] = useState(false);
  const line = daily.isPending ? "Loading this month..." : monthLine(summarizeMonth(daily.data ?? []), billing);
  return (
    <Panel className="flex flex-col gap-3 p-4 md:p-5">
      <div className="flex items-center gap-2">
        <h2 className="text-sm font-semibold text-ink">What this task is</h2>
        <Help label="What is in this box?">
          <span className="block">Three layers, from most to least certain.</span>
          <span className="mt-2 block"><b>What you told us</b> is the description you wrote. We never change it.</span>
          <span className="mt-2 block"><b>What we can see from your calls</b> is counted from your recorded calls. It is not a guess unless it says estimate.</span>
          <span className="mt-2 block"><b>Written by AI</b> is optional and off until you turn it on. It reads a few sample calls and may be wrong.</span>
        </Help>
      </div>
      <section>
        <p className={LABEL}>What you told us</p>
        <Description job={job} />
      </section>
      {profile.data?.models?.length ? <p className="text-xs text-dim">Models used: {profile.data.models.join(", ")}</p> : null}
      <div>
        <button
          type="button"
          aria-expanded={open}
          aria-controls={`about-${job.name}`}
          onClick={() => setOpen((v) => !v)}
          className="text-xs font-semibold text-accent hover:underline"
        >
          {open ? "Hide how we know" : "Show how we know"}
        </button>
      </div>

      {open && <div id={`about-${job.name}`} className="flex flex-col gap-4">
      <p className="text-xs text-muted">{TASK_EXPLAINER}</p>

      <section>
        <p className={LABEL}>What we can see from your calls</p>
        <div className="mt-1.5">
          {profile.isPending ? (
            <Skeleton className="h-16" />
          ) : profile.isError || !profile.data ? (
            <p className="text-sm text-dim">We could not read the call facts just now. Try again in a moment.</p>
          ) : !profile.data.enough_data ? (
            <NotEnoughData n={profile.data.calls} min={25} what="calls">
              Next step: keep sending calls from your code. {checkExplanation(job)[0]}
            </NotEnoughData>
          ) : (
            <dl className="grid gap-2 text-sm">
              {profileFacts(profile.data, job).map((f) => (
                <div key={f.label} className="grid gap-0.5 sm:grid-cols-[13rem_1fr] sm:gap-3">
                  <dt className="text-dim">{f.label}</dt>
                  <dd className="min-w-0 break-words text-ink">
                    {f.value}{" "}
                    <span className="whitespace-nowrap text-[11px] text-muted">({f.kind === "measured" ? "measured" : "estimate"})</span>
                  </dd>
                </div>
              ))}
            </dl>
          )}
          <p className="mt-2 text-xs text-dim">{checkExplanation(job).slice(1).join(" ")}</p>
          <p className="tabular mt-2 text-sm text-ink">{line}</p>
          <details className="mt-1 text-xs text-muted">
            <summary className="cursor-pointer">What are tokens?</summary>
            <p className="mt-1">{tokensAre(billing)} Longer prompts and answers use more tokens.</p>
          </details>
        </div>
      </section>

      <section>
        <p className={LABEL}>Written by AI (optional)</p>
        <AiSummary name={job.name} summary={profile.data?.summary} />
      </section>
      </div>}
    </Panel>
  );
}

function AiSummary({ name, summary }: { name: string; summary: TaskSummary | undefined }) {
  const consent = useTaskSummaryConsent();
  const remove = useDeleteTaskSummary(name);
  const toast = useToast();
  const [asking, setAsking] = useState(false);
  const [deleting, setDeleting] = useState(false);
  if (!summary) return <p className="mt-1 text-sm text-dim">Not available just now.</p>;
  const error = (consent.isError && !asking) || remove.isError;
  let body;
  if (summary.state === "unavailable" && !summary.consent) {
    body = <p className="text-sm text-dim">AI summaries are not set up on this server, so there is nothing to turn on.</p>;
  } else if (!summary.consent) {
    body = (
      <div className="flex flex-col gap-2 text-sm text-dim">
        <p>
          Off. Turned on, an outside AI service (<b className="text-ink">{summary.service}</b>) describes this task in two sentences, from a few of your sample calls.
        </p>
        {asking ? (
          <InlineConfirm
            label="Turn on AI summaries"
            confirmLabel="Turn on"
            cancelLabel="Keep it off"
            busy={consent.isPending}
            busyLabel="Turning on..."
            error={consent.isError ? "That did not work. Check your connection and try again." : null}
            onCancel={() => { consent.reset(); setAsking(false); }}
            onConfirm={() => consent.mutate(true, { onSuccess: () => { setAsking(false); toast({ message: "AI summaries are on for this project" }); } })}
          >
            We will send a few sample prompts and answers from your calls to the outside AI service (<b className="text-ink">{summary.service}</b>). Emails, links, long numbers and secret-looking codes are replaced first, but names and other free text cannot be spotted. This applies to every task in this project, and you can turn it off at any time.
          </InlineConfirm>
        ) : (
          <div>
            <Button type="button" onClick={() => setAsking(true)}>Turn on AI summaries</Button>
          </div>
        )}
      </div>
    );
  } else {
    let content;
    if (summary.state === "ready" && summary.text) {
      content = (
        <div className="flex flex-col gap-1.5">
          <p className="text-xs font-semibold text-dim">Written by AI from a few of your sample calls &mdash; it may be wrong</p>
          <p className="max-w-2xl text-sm text-ink">{summary.text}</p>
          {deleting ? (
            <InlineConfirm
              label="Delete this summary"
              confirmLabel="Delete summary"
              cancelLabel="Keep it"
              danger
              busy={remove.isPending}
              busyLabel="Deleting..."
              onCancel={() => { remove.reset(); setDeleting(false); }}
              onConfirm={() => remove.mutate(undefined, { onSuccess: () => { setDeleting(false); toast({ message: "Summary deleted" }); } })}
            >
              Delete this summary? It cannot be brought back. It is only written again if your sample calls change.
            </InlineConfirm>
          ) : (
            <div>
              <button type="button" onClick={() => { remove.reset(); setDeleting(true); }} className="text-xs font-semibold text-accent hover:underline">
                Delete this summary
              </button>
            </div>
          )}
        </div>
      );
    } else if (summary.state === "pending") {
      content = <p className="text-sm text-dim">Writing the summary now. It will appear here in a few seconds.</p>;
    } else if (summary.state === "no_samples") {
      content = <p className="text-sm text-dim">No sample text kept, so no summary. (It needs a few stored prompts; your retention setting may have removed them.)</p>;
    } else if (summary.state === "deleted") {
      content = <p className="text-sm text-dim">Summary deleted. It will only be written again if your sample calls change.</p>;
    } else {
      content = <p className="text-sm text-dim">No summary right now. We will try again later; nothing is wrong with your task.</p>;
    }
    body = (
      <div className="flex flex-col gap-2">
        {content}
        <label className="flex items-start gap-2 text-xs text-dim">
          <input type="checkbox" role="switch" className="mt-0.5" checked disabled={consent.isPending} onChange={() => consent.mutate(false, { onSuccess: () => toast({ message: "AI summaries are off. Stored summaries were deleted." }) })} />
          <span>AI summaries are on for this project (samples go to {summary.service}). Untick to turn off and delete the stored summaries.</span>
        </label>
      </div>
    );
  }
  return (
    <div className="mt-1.5">
      {body}
      {error && <p role="alert" className="mt-1 text-xs text-bad">That did not work. Check your connection and try again.</p>}
    </div>
  );
}

function Description({ job }: { job: Job }) {
  const save = useUpdateJobDescription(job.name);
  const toast = useToast();
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState("");
  const begin = () => {
    setText(job.description ?? "");
    save.reset();
    setEditing(true);
  };
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    save.mutate(text.trim() || null, { onSuccess: () => { setEditing(false); toast({ message: "Description saved" }); } });
  };
  if (editing) {
    return (
      <form onSubmit={submit} className="mt-1 flex max-w-2xl flex-col gap-2">
        <label htmlFor="task-description" className="text-xs font-semibold text-dim">What does this task do?</label>
        <textarea
          id="task-description"
          rows={2}
          maxLength={MAX_DESCRIPTION}
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
      {job.description ? job.description : <span className="text-muted">Add a one-line description so your team knows what this task does.</span>}{" "}
      <button type="button" onClick={begin} className="text-xs font-semibold text-accent hover:underline">
        {job.description ? "Edit" : "Add a description"}
      </button>
    </p>
  );
}

