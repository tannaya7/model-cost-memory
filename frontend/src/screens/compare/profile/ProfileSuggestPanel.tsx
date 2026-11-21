import { useMemo, useState } from "react";
import { useProject } from "../../../app/project";
import { useModels } from "../../../features/models/hooks/useModels";
import { IconExternal, IconFlask, IconInfo } from "../../../ui/icons";
import { usd } from "../../../ui/format";
import { Button, ModelName, Panel, Pill, Skeleton } from "../../../ui/primitives";
import { clearProfile, NO_ANSWERS, readProfile, saveProfile, skipProfile } from "./answers";
import { SuggestionDisclaimer } from "./Disclaimer";
import { UNTESTED_LABEL } from "../wilson";
import { Questionnaire } from "./Questionnaire";
import { suggestFromProfile } from "./suggest";
import type { Answers, Profile, ProfileUsage } from "./types";

/** "job" is null before the project has an AI task: the questions can still be answered, and nothing is measured. */
export function ProfileSuggestPanel({ job, usage }: { job: string | null; usage: ProfileUsage }) {
  const { id: project } = useProject();
  const [profile, setProfile] = useState<Profile>(() => readProfile(project, job));
  const [editing, setEditing] = useState(false);
  const models = useModels({});
  const catalog = useMemo(() => (models.data?.pages ?? []).flatMap((p) => p.items), [models.data]);
  const answers: Answers | null = profile.state === "answered" ? profile.answers : null;
  // No answers (skipped) is the general list: what the providers publish, in a fixed order, matched to nothing.
  const options = useMemo(() => suggestFromProfile(answers ?? NO_ANSWERS, usage, catalog), [answers, usage, catalog]);

  const save = (a: Answers) => {
    saveProfile(project, job, a);
    setProfile(readProfile(project, job));
    setEditing(false);
  };
  const skip = () => {
    skipProfile(project, job);
    setProfile({ state: "skipped" });
    setEditing(false);
  };
  const clear = () => {
    clearProfile(project, job);
    setProfile({ state: "none" });
    setEditing(false);
  };
  const showForm = profile.state === "none" || editing;
  const general = answers === null;

  return (
    <Panel className="space-y-5 p-5">
      <div className="flex items-center gap-2 rounded-xl bg-warn-soft px-3 py-2 text-sm font-semibold text-warn" role="note">
        <IconInfo size={16} />
        {general ? "General information, not measured on your work" : "Based on your answers, not on measured quality"}
      </div>
      {usage.runs === 0 && (
        <p className="text-sm text-dim" data-testid="no-history">
          You have no calls yet, so everything here is general: what the providers publish about each model. It is not a result on your work.
        </p>
      )}

      {showForm ? (
        <Questionnaire
          initial={answers}
          defaultBudget={usage.budgetUsd}
          onSubmit={save}
          onSkip={skip}
          onClear={profile.state === "answered" ? clear : undefined}
          onCancel={editing ? () => setEditing(false) : undefined}
        />
      ) : models.isPending ? (
        <Skeleton className="h-32 w-full" />
      ) : (
        <div className="space-y-4">
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-sm font-semibold text-ink">Models to read about</h2>
            <span className="flex flex-wrap gap-2">
              {answers ? (
                <>
                  <Button size="sm" onClick={() => setEditing(true)}>Edit answers</Button>
                  <Button size="sm" onClick={clear}>Clear my answers</Button>
                </>
              ) : (
                <Button size="sm" onClick={() => setEditing(true)}>Answer a few questions</Button>
              )}
            </span>
          </div>
          {options.length === 0 ? (
            <p className="text-sm text-dim">None of the models in our short list matches these answers on what the providers publish. Read the providers' own model pages to decide.</p>
          ) : (
            <ul className="grid gap-3 md:grid-cols-3">
              {options.map((o) => (
                <li key={o.model} className="flex flex-col gap-3 rounded-xl border border-rule bg-surface-2 p-4">
                  <div>
                    <ModelName>{o.model}</ModelName>
                    <p className="text-xs text-muted">{o.provider}</p>
                    <p className="mt-1 text-xs font-semibold text-warn">{UNTESTED_LABEL}</p>
                  </div>
                  <ul className="space-y-1.5 text-xs leading-relaxed text-dim">
                    {o.why.map((w) => (
                      <li key={w}>{w}</li>
                    ))}
                  </ul>
                  <div className="mt-auto flex flex-wrap items-center gap-2">
                    <span className="text-sm font-semibold text-ink">{o.estimatedMonthlyUsd === null ? "Cost not estimated" : usage.daysOfHistory < 7 ? `Rough guess: about ${usd(o.estimatedMonthlyUsd)} a month (under 7 days of use)` : `About ${usd(o.estimatedMonthlyUsd)} a month (estimated)`}</span>
                    {o.fitsBudget !== null && <Pill tone={o.fitsBudget ? "good" : "bad"}>{o.fitsBudget ? "Fits your monthly budget" : "Over your monthly budget"}</Pill>}
                  </div>
                  {o.link && (
                    <a href={o.link.url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 text-xs font-semibold text-accent underline-offset-2 hover:underline">
                      {o.link.label}
                      <IconExternal size={13} />
                    </a>
                  )}
                </li>
              ))}
            </ul>
          )}
          <p className="text-xs text-dim">{general ? "A general list from what the providers publish; we have not tested these models on your work." : "Based only on your answers; we have not tested these models on your work."}</p>
          <SuggestionDisclaimer from={usage.periodFrom} to={usage.periodTo} />
          <p className="flex items-center gap-2 text-sm text-dim">
            <IconFlask size={15} />
            Add a check to this AI task (a way to tell correct answers from wrong ones) to compare models on real results.
          </p>
        </div>
      )}
    </Panel>
  );
}
