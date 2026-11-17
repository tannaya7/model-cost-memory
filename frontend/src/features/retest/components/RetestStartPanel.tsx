import { useState, useEffect, type FormEvent } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useP } from "../../../app/project";
import { useQuery } from "@tanstack/react-query";
import { Card } from "../../../shared/components/Card";
import { Badge } from "../../../shared/components/Badge";
import { useJobs } from "../../jobs/hooks/useJobs";
import { fetchModels } from "../../models/api/modelsApi";
import { useRetestLimits, useStartRetest } from "../hooks/useRetest";
import { ApiError, errorCode } from "../../../shared/api/apiFetch";
import { InlineConfirm } from "../../../ui/InlineConfirm";
import { ProviderKeyForm } from "./ProviderKeyForm";
import type { Model } from "../../../shared/api/types";

function formatPrice(price: number | null | undefined): string {
  return price != null ? `$${price.toFixed(2)}` : "—";
}

export function RetestStartPanel() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const initialJobParam = searchParams.get("job") || "";
  // The model the engine named for a re-test ("Re-test X to settle it"), passed from the job page.
  const suggestedModel = searchParams.get("model") || "";

  const jobsQuery = useJobs();
  const limitsQuery = useRetestLimits();
  const modelsQuery = useQuery({
    queryKey: ["models", "retest-candidates"],
    queryFn: () => fetchModels({ limit: 100 }),
  });

  const startMutation = useStartRetest();

  const [selectedJob, setSelectedJob] = useState<string>(initialJobParam);
  const [selectedModel, setSelectedModel] = useState<string>(suggestedModel);
  const [budgetUsd, setBudgetUsd] = useState<string>("2.00");
  const [sampleSize, setSampleSize] = useState<string>("50");
  const p = useP();
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [askForKey, setAskForKey] = useState(false);
  const [confirming, setConfirming] = useState(false);

  const jobs = jobsQuery.data || [];
  const limits = limitsQuery.data;
  const models = (modelsQuery.data?.items || []).filter(
    (m: Model) => m.status !== "RETIRED",
  );

  // Pick initial job if not selected yet
  useEffect(() => {
    if (!selectedJob && jobs.length > 0) {
      if (initialJobParam && jobs.some((j) => j.name === initialJobParam)) {
        setSelectedJob(initialJobParam);
      } else {
        const eligible = jobs.find((j) => j.retest_consent !== false);
        if (eligible) {
          setSelectedJob(eligible.name);
        } else if (jobs[0]) {
          setSelectedJob(jobs[0].name);
        }
      }
    }
  }, [jobs, selectedJob, initialJobParam]);

  // Pick initial candidate model
  useEffect(() => {
    if (!selectedModel && models.length > 0) {
      // Prefer mini or cheap model if available
      const preferred =
        models.find((m) => m.model.includes("mini") && m.status === "ACTIVE") ||
        models.find((m) => m.status === "ACTIVE") ||
        models[0];
      if (preferred) {
        setSelectedModel(preferred.model);
      }
    }
  }, [models, selectedModel]);

  // Adjust default budget if remaining cap is less than 2.00
  useEffect(() => {
    if (limits && limits.cap_remaining_usd > 0) {
      const currentVal = parseFloat(budgetUsd);
      if (isNaN(currentVal) || currentVal > limits.cap_remaining_usd) {
        setBudgetUsd(limits.cap_remaining_usd.toFixed(2));
      }
    }
  }, [limits, budgetUsd]);

  const currentJobObj = jobs.find((j) => j.name === selectedJob);
  const isJobRetestDisabled = currentJobObj?.retest_consent === false;
  const activeCandidate = models.find((m) => m.model === selectedModel);

  const capRemaining = limits?.cap_remaining_usd ?? 0;
  const monthlyCap = limits?.monthly_cap_usd ?? 10;
  const spentThisMonth = limits?.spent_this_month_usd ?? 0;
  const capPercent =
    monthlyCap > 0
      ? Math.min(100, Math.round((spentThisMonth / monthlyCap) * 100))
      : 0;

  const budgetNum = parseFloat(budgetUsd);
  const isBudgetValid =
    !isNaN(budgetNum) && budgetNum > 0 && budgetNum <= (capRemaining || 10);
  const isCapExhausted = limits !== undefined && capRemaining <= 0;

  const sampleNum = Number(sampleSize);
  const isSampleValid = Number.isInteger(sampleNum) && sampleNum >= 1 && sampleNum <= 500;

  const canSubmit =
    isSampleValid &&
    Boolean(selectedJob) &&
    Boolean(selectedModel) &&
    !isJobRetestDisabled &&
    isBudgetValid &&
    !isCapExhausted &&
    !startMutation.isPending;

  // Changing anything closes the review, so it always describes what is on screen.
  useEffect(() => setConfirming(false), [selectedJob, selectedModel, budgetUsd, sampleSize]);

  /** The button only opens the review; nothing is sent until "Start trial". */
  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    setSubmitError(null);
    setConfirming(true);
  };

  const startTrial = async () => {
    if (!canSubmit) return;
    setSubmitError(null);

    try {
      const result = await startMutation.mutateAsync({
        jobName: selectedJob,
        input: {
          candidate_model: selectedModel,
          budget_usd: Number(budgetNum.toFixed(2)),
          sample_size: sampleNum,
        },
      });

      navigate(
        p(`/retest/${encodeURIComponent(result.retest_id)}?job=${encodeURIComponent(result.job)}`),
      );
    } catch (err) {
      setConfirming(false);
      if (errorCode(err) === "provider_key_required") {
        setAskForKey(true);
      } else if (err instanceof ApiError) {
        setSubmitError(err.message);
      } else if (err instanceof Error) {
        setSubmitError(err.message);
      } else {
        setSubmitError("The trial could not be started. Check your connection and try again.");
      }
    }
  };

  const isLoading =
    jobsQuery.isPending || limitsQuery.isPending || modelsQuery.isPending;

  return (
    <div className="space-y-6 max-w-4xl">
      {/* Monthly Cap Usage Card */}
      <Card className="p-6">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 mb-4">
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-base font-semibold text-ink">
                Monthly budget for trials on new models
              </h2>
              {isCapExhausted ? (
                <Badge tone="bad">Budget used up</Badge>
              ) : (
                <Badge tone="ok">Available</Badge>
              )}
            </div>
            <p className="mt-1 text-xs text-dim">
              A trial replays your past prompts on another model to see if it does as well. This is the most you allow trials to spend each month, across all your AI tasks, so a trial can never run up a surprise bill.
            </p>
          </div>
          <div className="text-right">
            <span className="text-2xl font-bold font-mono text-ink">
              ${capRemaining.toFixed(2)}
            </span>
            <span className="text-xs text-dim block">
              remaining of ${monthlyCap.toFixed(2)} cap
            </span>
          </div>
        </div>

        {/* Cap bar */}
        <div className="space-y-2">
          <div className="h-2.5 w-full overflow-hidden rounded-full bg-bg border border-rule">
            <div
              className={`h-full rounded-full transition-all duration-300 ${
                isCapExhausted
                  ? "bg-bad"
                  : capPercent > 80
                    ? "bg-warn"
                    : "bg-accent"
              }`}
              style={{ width: `${capPercent}%` }}
            />
          </div>
          <div className="flex justify-between text-xs text-dim font-mono">
            <span>Spent: ${spentThisMonth.toFixed(2)}</span>
            <span>{capPercent}% used</span>
            <span>Cap: ${monthlyCap.toFixed(2)}</span>
          </div>
        </div>

        {isCapExhausted && (
          <div className="mt-4 rounded-md border border-bad/30 bg-bad-soft p-3 text-xs text-bad">
            Your monthly trial budget is used up. You cannot start a new trial until it resets next month, or you raise the budget in Settings.
          </div>
        )}
      </Card>

      {/* The provider key: asked for only when a re-test first needs it */}
      {(askForKey || (limits && limits.provider_key === null)) && (
        <ProviderKeyForm
          onSaved={() => {
            setAskForKey(false);
            setSubmitError(null);
          }}
        />
      )}
      {limits?.provider_key && (
        <p className="text-xs text-dim">
          Trials use your {limits.provider_key.provider} key ending in{" "}
          <span className="font-mono text-ink">{limits.provider_key.key_hint}</span>, within the monthly budget above.
        </p>
      )}

      {/* Re-test Configuration Form */}
      <Card className="p-6">
        <form onSubmit={handleSubmit} className="space-y-6">
          <div className="border-b border-rule pb-4">
            <h2 className="text-base font-semibold text-ink">
              Set up a trial on a new model
            </h2>
            <p className="mt-1 text-xs text-dim">
              Choose the AI task and the model to try. We replay past prompts on that model, so your live app is not affected.
            </p>
          </div>

          {submitError && (
            <div className="rounded-md border border-bad/30 bg-bad-soft p-3 text-sm text-bad">
              {submitError}
            </div>
          )}

          {/* Job Selection */}
          <div>
            <label
              htmlFor="retest-job"
              className="block text-sm font-medium text-ink mb-1"
            >
              AI task to test <span className="text-bad">*</span>
            </label>
            <select
              id="retest-job"
              value={selectedJob}
              onChange={(e) => {
                setSelectedJob(e.target.value);
                setSubmitError(null);
              }}
              disabled={isLoading || jobs.length === 0}
              className="w-full rounded-md border border-rule bg-surface px-3 py-2 text-sm text-ink focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent disabled:opacity-50"
            >
              {jobs.length === 0 ? (
                <option value="">No AI tasks yet</option>
              ) : (
                jobs.map((j) => (
                  <option
                    key={j.name}
                    value={j.name}
                    disabled={j.retest_consent === false}
                  >
                    {j.name}
                    {j.retest_consent === false ? " (trials off)" : ""}
                  </option>
                ))
              )}
            </select>

            {isJobRetestDisabled && (
              <div className="mt-2 rounded-md border border-warn/30 bg-warn-soft p-3 text-xs text-warn">
                <span className="font-semibold">Trials are turned off:</span> This
                AI task does not allow its past prompts to be sent to another provider. To allow it, open the AI task's settings and turn trials on.
              </div>
            )}
          </div>

          {/* Candidate Model Selection */}
          <div>
            <label
              htmlFor="retest-model"
              className="block text-sm font-medium text-ink mb-1"
            >
              Candidate Model <span className="text-bad">*</span>
            </label>
            <select
              id="retest-model"
              value={selectedModel}
              onChange={(e) => {
                setSelectedModel(e.target.value);
                setSubmitError(null);
              }}
              disabled={isLoading || (models.length === 0 && !suggestedModel)}
              className="w-full rounded-md border border-rule bg-surface px-3 py-2 text-sm text-ink focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent disabled:opacity-50"
            >
              {/* The list holds the first 100 catalog models; the engine's suggestion may not be among them. */}
              {suggestedModel && !models.some((m) => m.model === suggestedModel) && (
                <option value={suggestedModel}>{suggestedModel} (suggested by the engine)</option>
              )}
              {models.length === 0 && !suggestedModel ? (
                <option value="">Loading models...</option>
              ) : (
                models.map((m) => (
                  <option key={m.model} value={m.model}>
                    {m.model}
                    {m.model === suggestedModel ? " · suggested by the engine" : ""} (
                    {m.status === "DEPRECATED" ? "Deprecated · " : ""}
                    {formatPrice(m.price_in_per_mtok)}/M in,{" "}
                    {formatPrice(m.price_out_per_mtok)}/M out)
                  </option>
                ))
              )}
            </select>

            {activeCandidate && (
              <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-dim">
                <span>Provider: {activeCandidate.provider}</span>
                <span>•</span>
                <span>
                  Input: {formatPrice(activeCandidate.price_in_per_mtok)}/M tokens
                </span>
                <span>•</span>
                <span>
                  Output: {formatPrice(activeCandidate.price_out_per_mtok)}/M tokens
                </span>
                {activeCandidate.status === "DEPRECATED" && (
                  <>
                    <span>•</span>
                    <Badge tone="warn">Deprecated</Badge>
                  </>
                )}
              </div>
            )}
          </div>

          {/* Budget Limit */}
          <div>
            <div className="flex items-center justify-between mb-1">
              <label
                htmlFor="retest-budget"
                className="block text-sm font-medium text-ink"
              >
                Most this trial may spend (USD) <span className="text-bad">*</span>
              </label>
              <span className="text-xs text-dim">
                Available: ${capRemaining.toFixed(2)}
              </span>
            </div>
            <div className="relative">
              <span className="absolute inset-y-0 left-0 flex items-center pl-3 text-sm text-dim">
                $
              </span>
              <input
                id="retest-budget"
                type="number"
                step="0.10"
                min="0.10"
                max={capRemaining > 0 ? capRemaining : 10}
                value={budgetUsd}
                onChange={(e) => {
                  setBudgetUsd(e.target.value);
                  setSubmitError(null);
                }}
                disabled={isLoading || isCapExhausted}
                className="w-full rounded-md border border-rule bg-surface pl-7 pr-3 py-2 text-sm text-ink placeholder:text-dim focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent disabled:opacity-50"
              />
            </div>
            {!isBudgetValid && (
              <p className="mt-1 text-xs text-bad">
                The budget must be more than $0.00 and no more than the ${capRemaining.toFixed(2)} left in your monthly trial budget.
              </p>
            )}
            <p className="mt-1 text-xs text-dim">
              The trial stops straight away if it reaches this amount before all the prompts are replayed.
            </p>
          </div>

          {/* How many past prompts to replay */}
          <div>
            <label htmlFor="retest-sample" className="mb-1 block text-sm font-medium text-ink">
              Past prompts to replay
            </label>
            <input
              id="retest-sample"
              type="number"
              step="1"
              min="1"
              max="500"
              value={sampleSize}
              onChange={(e) => {
                setSampleSize(e.target.value);
                setSubmitError(null);
              }}
              disabled={isLoading || isCapExhausted}
              className="w-full max-w-40 rounded-md border border-rule bg-surface px-3 py-2 text-sm text-ink focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent disabled:opacity-50"
            />
            {!isSampleValid && <p className="mt-1 text-xs text-bad">Between 1 and 500 prompts.</p>}
            <p className="mt-1 text-xs text-dim">
              Chosen at random from this AI task's recorded prompts, replayed once each. More prompts give a firmer answer but cost more; the budget above still caps the spend.
            </p>
          </div>

          {/* Notice Callout */}
          <div className="rounded-md border border-rule bg-bg p-4 text-xs text-dim space-y-1">
            <p className="font-medium text-ink">What this spends</p>
            <p>
              Up to 50 past prompts of this AI task are replayed on the model you chose, using your own provider key, most important first. Each answer is checked the same way as your real ones. Before every call we check that the trial stays within its budget and your monthly trial budget, so it stops before either is exceeded. It also stops early once the answer is clear.
            </p>
          </div>

          {/* Submit Action */}
          {confirming && canSubmit && (
            <InlineConfirm
              label="Start this trial"
              confirmLabel="Start trial"
              cancelLabel="Not now"
              busy={startMutation.isPending}
              busyLabel="Starting the trial..."
              onConfirm={() => void startTrial()}
              onCancel={() => setConfirming(false)}
            >
              Replay up to {sampleNum} past prompts of <b className="text-ink">{selectedJob}</b> on <b className="text-ink">{selectedModel}</b>
              {activeCandidate ? <> ({activeCandidate.provider})</> : null}, using your own provider key. It costs up to <b className="text-ink">${budgetNum.toFixed(2)}</b>, within your trial budget of ${monthlyCap.toFixed(2)} a month (${capRemaining.toFixed(2)} left). The budget is checked before every call.
            </InlineConfirm>
          )}
          <div className="flex items-center justify-end gap-3 pt-4 border-t border-rule">
            <button
              type="submit"
              disabled={!canSubmit || confirming}
              className="rounded-md bg-accent px-5 py-2.5 text-sm font-semibold text-on-accent shadow-sm hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50 transition-opacity"
            >
              {startMutation.isPending
                ? "Starting the trial..."
                : "Review and start a trial"}
            </button>
          </div>
        </form>
      </Card>
    </div>
  );
}
