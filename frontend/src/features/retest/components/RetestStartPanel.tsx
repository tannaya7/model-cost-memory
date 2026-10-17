import { useState, useEffect, type FormEvent } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Card } from "../../../shared/components/Card";
import { Badge } from "../../../shared/components/Badge";
import { useJobs } from "../../jobs/hooks/useJobs";
import { fetchModels } from "../../models/api/modelsApi";
import { useRetestLimits, useStartRetest } from "../hooks/useRetest";
import { ApiError } from "../../../shared/api/apiFetch";
import type { Model } from "../../../shared/api/types";

function formatPrice(price: number | null | undefined): string {
  return price != null ? `$${price.toFixed(2)}` : "—";
}

export function RetestStartPanel() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const initialJobParam = searchParams.get("job") || "";

  const jobsQuery = useJobs();
  const limitsQuery = useRetestLimits();
  const modelsQuery = useQuery({
    queryKey: ["models", "retest-candidates"],
    queryFn: () => fetchModels({ limit: 100 }),
  });

  const startMutation = useStartRetest();

  const [selectedJob, setSelectedJob] = useState<string>(initialJobParam);
  const [selectedModel, setSelectedModel] = useState<string>("");
  const [budgetUsd, setBudgetUsd] = useState<string>("2.00");
  const [submitError, setSubmitError] = useState<string | null>(null);

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

  const canSubmit =
    Boolean(selectedJob) &&
    Boolean(selectedModel) &&
    !isJobRetestDisabled &&
    isBudgetValid &&
    !isCapExhausted &&
    !startMutation.isPending;

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    setSubmitError(null);

    try {
      const result = await startMutation.mutateAsync({
        jobName: selectedJob,
        input: {
          candidate_model: selectedModel,
          budget_usd: Number(budgetNum.toFixed(2)),
        },
      });

      navigate(
        `/retest/${encodeURIComponent(result.retest_id)}?job=${encodeURIComponent(result.job)}`,
      );
    } catch (err) {
      if (err instanceof ApiError) {
        setSubmitError(err.message);
      } else if (err instanceof Error) {
        setSubmitError(err.message);
      } else {
        setSubmitError("Failed to start re-test");
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
              <h3 className="text-base font-semibold text-ink">
                Monthly Re-test Budget Cap
              </h3>
              {isCapExhausted ? (
                <Badge tone="bad">Cap Reached</Badge>
              ) : (
                <Badge tone="ok">Available</Badge>
              )}
            </div>
            <p className="mt-1 text-xs text-dim">
              Protects against accidental re-test runaway costs across all jobs.
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
            Your monthly re-test cap has been exhausted. You cannot start new
            re-tests until the cap resets next month.
          </div>
        )}
      </Card>

      {/* Re-test Configuration Form */}
      <Card className="p-6">
        <form onSubmit={handleSubmit} className="space-y-6">
          <div className="border-b border-rule pb-4">
            <h3 className="text-base font-semibold text-ink">
              Configure Re-test Run
            </h3>
            <p className="mt-1 text-xs text-dim">
              Select a target job and candidate model to evaluate offline
              without affecting live production traffic.
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
              Target Job <span className="text-bad">*</span>
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
                <option value="">No jobs found</option>
              ) : (
                jobs.map((j) => (
                  <option
                    key={j.name}
                    value={j.name}
                    disabled={j.retest_consent === false}
                  >
                    {j.name}
                    {j.retest_consent === false ? " (re-tests off)" : ""}
                  </option>
                ))
              )}
            </select>

            {isJobRetestDisabled && (
              <div className="mt-2 rounded-md border border-warn/30 bg-warn-soft p-3 text-xs text-warn">
                <span className="font-semibold">Re-tests are disabled:</span> This
                job has retest consent turned off in settings. To enable
                re-testing, edit the job settings and turn re-test consent on.
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
              disabled={isLoading || models.length === 0}
              className="w-full rounded-md border border-rule bg-surface px-3 py-2 text-sm text-ink focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent disabled:opacity-50"
            >
              {models.length === 0 ? (
                <option value="">Loading models...</option>
              ) : (
                models.map((m) => (
                  <option key={m.model} value={m.model}>
                    {m.model} (
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
                Max Run Budget (USD) <span className="text-bad">*</span>
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
                Budget must be greater than $0.00 and cannot exceed the available
                cap of ${capRemaining.toFixed(2)}.
              </p>
            )}
            <p className="mt-1 text-xs text-dim">
              The re-test will immediately stop if the budget is reached before
              all planned runs complete.
            </p>
          </div>

          {/* Notice Callout */}
          <div className="rounded-md border border-rule bg-bg p-4 text-xs text-dim space-y-1">
            <p className="font-medium text-ink">Sandbox Execution Notice</p>
            <p>
              Re-tests replay historical job inputs against the candidate model.
              Actual token spend will be billed to your provider account and
              tracked against your monthly re-test cap.
            </p>
          </div>

          {/* Submit Action */}
          <div className="flex items-center justify-end gap-3 pt-4 border-t border-rule">
            <button
              type="submit"
              disabled={!canSubmit}
              className="rounded-md bg-accent px-5 py-2.5 text-sm font-semibold text-on-accent shadow-sm hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50 transition-opacity"
            >
              {startMutation.isPending
                ? "Starting Re-test..."
                : "Start Re-test"}
            </button>
          </div>
        </form>
      </Card>
    </div>
  );
}
