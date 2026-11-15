import { useMemo, useState } from "react";
import { useProject } from "../../../app/project";
import { useModels } from "../../../features/models/hooks/useModels";
import { IconExternal, IconFlask, IconInfo } from "../../../ui/icons";
import { usd } from "../../../ui/format";
import { Button, ModelName, Panel, Pill, Skeleton } from "../../../ui/primitives";
import { readAnswers, writeAnswers } from "./answers";
import { SuggestionDisclaimer } from "./Disclaimer";
import { UNTESTED_LABEL } from "../wilson";
import { Questionnaire } from "./Questionnaire";
import { suggestFromProfile } from "./suggest";
import type { Answers, ProfileUsage } from "./types";

export function ProfileSuggestPanel({ job, usage }: { job: string; usage: ProfileUsage }) {
  const { id: project } = useProject();
  const [answers, setAnswers] = useState<Answers | null>(() => readAnswers(project, job));
  const [editing, setEditing] = useState(false);
  const models = useModels({});
  const catalog = useMemo(() => (models.data?.pages ?? []).flatMap((p) => p.items), [models.data]);
  const options = useMemo(() => (answers ? suggestFromProfile(answers, usage, catalog) : []), [answers, usage, catalog]);

  const save = (a: Answers) => {
    writeAnswers(project, job, a);
    setAnswers(a);
    setEditing(false);
  };
  const showForm = !answers || editing;

  return (
    <Panel className="space-y-5 p-5">
      <div className="flex items-center gap-2 rounded-xl bg-warn-soft px-3 py-2 text-sm font-semibold text-warn" role="note">
        <IconInfo size={16} />
        Based on your answers, not on measured quality
      </div>

      {showForm ? (
        <Questionnaire initial={answers} defaultBudget={usage.budgetUsd} onSubmit={save} />
      ) : models.isPending ? (
        <Skeleton className="h-32 w-full" />
      ) : (
        <div className="space-y-4">
          <div className="flex items-center justify-between gap-3">
            <h3 className="text-sm font-semibold text-ink">Models to read about</h3>
            <Button size="sm" onClick={() => setEditing(true)}>Edit answers</Button>
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
          <p className="text-xs text-dim">Based only on your answers; we have not tested these models on your work.</p>
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
