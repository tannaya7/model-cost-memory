/** Compare: which model could do a job for less, and which are only worth testing. Filters live in the
 * address, so a link reproduces the view. Measured figures come from checked runs; anything about a model
 * the job has not run is an estimate and says so. */
import { useMemo } from "react";
import { useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { useP, useProject } from "../../app/project";
import { useDaily } from "../../features/insights/api/dailyApi";
import { jobTitle } from "../../features/jobs/jobTitle";
import { useJobs } from "../../features/jobs/hooks/useJobs";
import { fetchModels } from "../../features/models/api/modelsApi";
import { useRecommendation } from "../../features/recommendations/hooks/useRecommendation";
import type { DayPoint, Model } from "../../shared/api/types";
import { count, pct, usd } from "../../ui/format";
import { ButtonLink, cx, EmptyState, Panel, Pill, Skeleton } from "../../ui/primitives";
import { useProject as useAccountProject } from "../../features/projects/hooks/useProjects";
import { CompareChart } from "./CompareChart";
import { SuggestionDisclaimer } from "./profile/Disclaimer";
import { MIN_CHECKED_ANSWERS, TOO_FEW_LABEL, UNTESTED_LABEL } from "./wilson";
import { Help } from "../../ui/Help";
import { NotEnoughData } from "../../ui/NotEnoughData";
import { modelLink } from "./profile/modelLinks";
import { ProfileSuggestPanel } from "./profile/ProfileSuggestPanel";
import type { ProfileUsage } from "./profile/types";
import { suggestForCheckedJob, type Suggestion } from "./suggest";

type TokenPoint = Omit<DayPoint, "tokens_in" | "tokens_out" | "cache_read_tokens" | "cache_write_tokens" | "failed_spend_usd" | "unpriced_runs"> & { tokens_in?: number; tokens_out?: number; cache_read_tokens?: number; cache_write_tokens?: number; failed_spend_usd?: number; unpriced_runs?: number };

const DAYS = [30, 60, 90] as const;
const PRESETS = [0.5, 1, 2, 5] as const;
const field = "rounded-[10px] border border-rule bg-surface px-3 py-2 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-accent/40";

const sum = (pts: TokenPoint[], f: (p: TokenPoint) => number | undefined) => pts.reduce((a, p) => a + (f(p) ?? 0), 0);
const num = (v: string | null) => {
  const n = Number(v);
  return v !== null && v !== "" && Number.isFinite(n) && n > 0 ? n : null;
};

/** What the daily points say about the account: how long, how busy, how many tokens. */
export function summariseUsage(points: TokenPoint[]) {
  const days = points.map((p) => p.day).sort();
  const from = days[0] ?? "";
  const to = days[days.length - 1] ?? "";
  const span = from ? Math.max(1, Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000) + 1) : 0;
  const perMonth = (v: number) => (span > 0 ? (v / span) * 30 : 0);
  return {
    from,
    to,
    span,
    runs: sum(points, (p) => p.runs),
    monthlyIn: perMonth(sum(points, (p) => p.tokens_in)),
    monthlyOut: perMonth(sum(points, (p) => p.tokens_out)),
    monthlyRuns: perMonth(sum(points, (p) => p.runs)),
    monthlySpend: perMonth(sum(points, (p) => p.spend_usd)),
  };
}

function Chip({ on, onClick, children }: { on: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={onClick}
      className={cx("rounded-full border px-3 py-1 text-xs font-semibold transition-colors", on ? "border-accent bg-accent-soft text-accent-ink" : "border-rule text-dim hover:bg-surface-2")}
    >
      {children}
    </button>
  );
}

function SuggestionCard({ s, job }: { s: Suggestion; job: string }) {
  const p = useP();
  const link = modelLink(s.model);
  return (
    <li className="panel flex flex-col gap-2 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <Pill tone={s.tooFew ? "warn" : s.evidence === "measured" ? "good" : "info"}>{s.tooFew ? TOO_FEW_LABEL : s.evidence === "measured" ? s.label : UNTESTED_LABEL}</Pill>
        <span className="text-[11px] text-muted">{s.evidence === "measured" ? "Measured" : "Estimate"}</span>
      </div>
      <p className="font-mono text-sm font-semibold text-ink">{s.model}</p>
      <p className="text-sm text-dim">{s.reason}</p>
      <dl className="flex flex-wrap gap-x-6 gap-y-1 text-xs text-dim">
        <div>
          <dt className="inline text-muted">{s.evidence === "estimate" ? "Estimated a month: " : "A month: "}</dt>
          <dd className="inline font-semibold text-ink tabular">{usd(s.monthlyCostUsd)}</dd>
        </div>
        {s.passRate !== null && (
          <div>
            <dt className="inline text-muted">Correct answers: </dt>
            <dd className="inline font-semibold text-ink tabular">
              {pct(s.passRate)}
              {s.interval && !s.tooFew ? ` (${pct(s.interval.low, 0)} to ${pct(s.interval.high, 0)})` : ""}
            </dd>
          </div>
        )}
        {s.nChecked !== null && (
          <div>
            <dt className="inline text-muted">Checked answers: </dt>
            <dd className="inline font-semibold text-ink tabular">{s.nChecked.toLocaleString("en")}</dd>
          </div>
        )}
        {s.fitsBudget !== null && (
          <div>
            <dd className={cx("font-semibold", s.fitsBudget ? "text-ok" : "text-bad")}>{s.fitsBudget ? "Fits your monthly budget" : "Over your monthly budget"}</dd>
          </div>
        )}
      </dl>
      <div className="mt-1 flex flex-wrap items-center gap-3">
        {s.evidence === "estimate" && (
          <ButtonLink size="sm" variant="primary" to={p(`/retest?job=${encodeURIComponent(job)}&model=${encodeURIComponent(s.model)}`)}>
            Try it on your own past prompts
          </ButtonLink>
        )}
        {link && (
          <a href={link.url} target="_blank" rel="noopener noreferrer" className="text-xs font-semibold text-accent hover:underline">
            {link.label}
          </a>
        )}
      </div>
    </li>
  );
}

export default function Compare() {
  const { id: project } = useProject();
  const accountProject = useAccountProject(project === "key" || project === "demo" ? undefined : project);
  const p = useP();
  const [params, setParams] = useSearchParams();
  const set = (patch: Record<string, string | null>) =>
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        for (const [k, v] of Object.entries(patch)) (v === null || v === "" ? next.delete(k) : next.set(k, v));
        return next;
      },
      { replace: true },
    );

  const days = DAYS.find((d) => String(d) === params.get("days")) ?? 60;
  const providers = (params.get("providers") ?? "").split(",").filter(Boolean);
  const jobs = useJobs();
  const jobName = params.get("job") ?? jobs.data?.[0]?.name ?? "";
  const job = jobs.data?.find((j) => j.name === jobName);
  const daily = useDaily({ days });
  const rec = useRecommendation(jobName || undefined);
  const catalogQ = useQuery({ queryKey: ["models", "compare"], queryFn: () => fetchModels({ limit: 100 }) });
  const catalog: Model[] = useMemo(() => (catalogQ.data?.items ?? []).filter((m) => m.status !== "RETIRED"), [catalogQ.data]);
  const providerNames = [...new Set(catalog.map((m) => m.provider))].sort();

  const all = (daily.data ?? []) as TokenPoint[];
  const mine = all.filter((d) => d.job === jobName);
  const account = summariseUsage(all);
  const jobUse = summariseUsage(mine);
  const actualTokens = Math.round(account.monthlyIn + account.monthlyOut);
  const customTokens = num(params.get("tokens"));
  const preset = PRESETS.find((x) => String(x) === params.get("x")) ?? 1;
  const volumeTokens = customTokens ?? Math.round(actualTokens * preset);
  const factor = customTokens && actualTokens > 0 ? customTokens / actualTokens : customTokens ? 1 : preset;
  const budget = num(params.get("budget")) ?? accountProject.data?.monthly_budget_usd ?? null;

  const rec0 = rec.data ?? null;
  const checkedRuns = rec0?.evidence.n_runs ?? 0;
  const unchecked = !!job && !rec.isPending && job.check_kind === "LATE_LABEL" && checkedRuns === 0;
  const early = account.span < 14 || checkedRuns < 100;
  const jobRuns = jobUse.runs;
  const avgTokens = jobRuns > 0 && jobUse.monthlyIn + jobUse.monthlyOut > 0 ? { in: (jobUse.monthlyIn / jobUse.monthlyRuns) || 0, out: (jobUse.monthlyOut / jobUse.monthlyRuns) || 0 } : null;
  const runsPerMonth = jobUse.monthlyRuns * factor;
  const suggestions = rec0 && !unchecked ? suggestForCheckedJob({ rec: rec0, catalog, avgTokens, runsPerMonth, budgetUsd: budget, providers }) : [];
  const from = account.from || new Date().toISOString().slice(0, 10);
  const to = account.to || from;

  const currentModels = [...new Set([...mine].sort((a, b) => b.runs - a.runs).map((d) => d.model))];
  const usage: ProfileUsage = {
    daysOfHistory: account.span,
    runs: jobRuns,
    monthlyTokensIn: Math.round(jobUse.monthlyIn * factor),
    monthlyTokensOut: Math.round(jobUse.monthlyOut * factor),
    monthlySpendUsd: jobUse.monthlySpend * factor,
    budgetUsd: budget,
    currentModels,
    periodFrom: from,
    periodTo: to,
  };

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-5">
      <header>
        <h1 className="text-3xl font-semibold tracking-tight">Compare models</h1>
        <p className="mt-1 max-w-2xl text-sm text-dim">Pick an AI task (one kind of work your app asks an AI to do) to see what each model would cost for it, how many answers each got right, and which cheaper ones are worth a trial.</p>
      </header>

      <Panel className="p-4 md:p-5">
        <div className="grid gap-4 md:grid-cols-2">
          <label className="flex flex-col gap-1 text-xs font-semibold text-muted">
            AI task
            <select className={field} value={jobName} onChange={(e) => set({ job: e.target.value })}>
              {(jobs.data ?? []).map((j) => (
                <option key={j.name} value={j.name}>{jobTitle(j.name)} ({j.name})</option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-xs font-semibold text-muted">
            History to learn from
            <select className={field} value={days} onChange={(e) => set({ days: e.target.value })}>
              {DAYS.map((d) => (
                <option key={d} value={d}>{d} days</option>
              ))}
            </select>
          </label>
          <div className="flex flex-col gap-1 text-xs font-semibold text-muted">
            <span id="vol-label">Monthly volume</span>
            <div className="flex flex-wrap items-center gap-1.5" role="group" aria-labelledby="vol-label">
              {PRESETS.map((x) => (
                <Chip key={x} on={!customTokens && preset === x} onClick={() => set({ x: String(x), tokens: null })}>{x}x</Chip>
              ))}
              <input
                aria-label="Custom tokens a month"
                inputMode="numeric"
                className={cx(field, "w-36")}
                value={customTokens ?? ""}
                placeholder={actualTokens ? count(volumeTokens) : "tokens"}
                onChange={(e) => set({ tokens: e.target.value.replace(/[^\d]/g, "") })}
              />
            </div>
            <span className="font-normal text-muted">{actualTokens ? `${count(volumeTokens)} tokens a month (you use about ${count(actualTokens)} now)` : "No token counts recorded yet. Tokens are the small pieces of text AI models are billed by."}</span>
          </div>
          <label className="flex flex-col gap-1 text-xs font-semibold text-muted">
            Monthly budget (US dollars)
            <input
              inputMode="decimal"
              className={field}
              value={budget ?? ""}
              placeholder="No budget set"
              onChange={(e) => {
                const v = num(e.target.value.replace(/[^\d.]/g, ""));
                set({ budget: v === null ? null : String(v) });
              }}
            />
          </label>
        </div>
        {providerNames.length > 0 && (
          <div className="mt-4 flex flex-wrap items-center gap-1.5" role="group" aria-label="Provider">
            <span className="mr-1 text-xs font-semibold text-muted">Provider</span>
            {providerNames.map((name) => (
              <Chip
                key={name}
                on={providers.includes(name)}
                onClick={() => set({ providers: (providers.includes(name) ? providers.filter((x) => x !== name) : [...providers, name]).join(",") })}
              >
                {name}
              </Chip>
            ))}
          </div>
        )}
      </Panel>

      {daily.isPending || jobs.isPending ? (
        <Skeleton className="h-16" />
      ) : (
        <p className="flex flex-wrap items-center gap-2 text-sm text-dim" data-testid="evidence-line">
          <span>
            Based on {account.span} days of use: {count(account.runs)} AI calls, about {count(actualTokens)} tokens a month (tokens are the small pieces of text AI is billed by).
          </span>
          <Pill tone={early ? "warn" : "good"}>{early ? "Not enough history yet" : "Enough history to compare"}</Pill>
          <Help label="How to read the numbers on this page">Costs are what each model would charge for the same amount of text you use now. Correct answers come from answers we checked: we need at least {MIN_CHECKED_ANSWERS} per model before we show a range. Models you have not used are estimates.</Help>
        </p>
      )}

      {!jobName ? (
        <EmptyState title="No AI tasks yet" hint="Create an AI task and send some AI calls through our SDK. Then you can compare what different models would cost for it." />
      ) : unchecked ? (
        <>
          <Panel className="p-5">
            <h2 className="text-lg font-semibold">This AI task has no way to check answers, so we cannot compare quality</h2>
            <p className="mt-1 text-sm text-dim">Without a check we cannot tell which answers are correct. Add one and the comparison appears here.</p>
            <div className="mt-3">
              <ButtonLink to={p("/jobs")} variant="primary" size="sm">Create or edit the check</ButtonLink>
            </div>
          </Panel>
          <ProfileSuggestPanel job={jobName} usage={usage} />
          <SuggestionDisclaimer from={from} to={to} />
        </>
      ) : rec.isPending ? (
        <Skeleton className="h-72" />
      ) : !rec0 ? (
        <EmptyState title="Not enough checked answers yet" hint={`We need at least ${MIN_CHECKED_ANSWERS} checked answers from a model to compare quality. Until then, the costs on this page are only estimates. Check more of this task's answers to see the real comparison.`} />
      ) : (
        <>
          {checkedRuns < rec0.rules.evidence_floor && (
            <NotEnoughData n={checkedRuns} min={rec0.rules.evidence_floor}>
              Next step: check more of this task's answers. The costs below are still real or estimated prices.
            </NotEnoughData>
          )}
          <Panel className="p-5">
            <CompareChart rec={rec0} catalog={catalog} avgTokens={avgTokens} providers={providers} />
            {!avgTokens && <p className="mt-2 text-xs text-muted">Token counts are not recorded for this AI task yet, so models it has not used cannot be priced.</p>}
          </Panel>
          <section aria-label="Suggestions" className="flex flex-col gap-3">
            <h2 className="text-lg font-semibold">Suggestions</h2>
            {suggestions.length === 0 ? (
              <p className="text-sm text-dim">Nothing to suggest for these filters.</p>
            ) : (
              <ul className="grid gap-3 md:grid-cols-3">
                {suggestions.map((s) => (
                  <SuggestionCard key={s.label} s={s} job={jobName} />
                ))}
              </ul>
            )}
            <SuggestionDisclaimer from={from} to={to} />
          </section>
        </>
      )}
    </div>
  );
}
