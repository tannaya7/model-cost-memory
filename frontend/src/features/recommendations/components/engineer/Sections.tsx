import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "../../../../shared/api/apiFetch";
import type { Breakdown, History, Model, ModelEvidence, ModelPage, Recommendation, RunPage } from "../../../../shared/api/types";
import { useSpendInsights, useJobInsights } from "../../../insights/hooks/useSpendInsights";
import { useJobHistory } from "../../hooks/useJobHistory";
import { useJobRegressions } from "../../hooks/useJobRegressions";
import { range, ruleSentence } from "../../evidence";
import { JobHistoryTimeline } from "../JobHistoryTimeline";
import { DataTable, Hint, Section, Tag, minute, pct, usd } from "./Section";

const CATALOG_TONE = { ACTIVE: "ok", DEPRECATED: "warn", RETIRED: "bad", UNKNOWN: "neutral" } as const;

function eligibleCell(m: ModelEvidence) {
  if (m.eligible) return <Tag tone="ok">yes</Tag>;
  return (
    <span className="text-xs">
      <Tag tone="bad">no</Tag> <span className="text-dim">{m.why}</span>
    </span>
  );
}

/** "How every model compares on this job": the same response as the recommendation. */
export function CompareSection({ recommendation: r }: { recommendation: Recommendation }) {
  const rows = [...r.models]
    .sort((a, b) => (b.weighted_pass_rate ?? -1) - (a.weighted_pass_rate ?? -1))
    .map((m) => [
      <div key="m">
        <b className="font-mono">{m.model}</b>
        {r.recommended?.model === m.model && <span className="ml-1.5"><Tag tone="accent">recommended</Tag></span>}
        {r.current?.model === m.model && <span className="ml-1.5"><Tag tone="neutral">current</Tag></span>}
        <div className="font-mono text-[11px] text-dim">{m.model_version}</div>
      </div>,
      <Tag key="c" tone={CATALOG_TONE[m.catalog_status as keyof typeof CATALOG_TONE] ?? "neutral"}>{m.catalog_status}</Tag>,
      <span key="n" className="font-mono">{m.n_runs.toLocaleString()}</span>,
      <span key="e" className="font-mono">{m.evidence_weight.toFixed(2)}</span>,
      <div key="p" className="font-mono">
        {pct(m.weighted_pass_rate)}
        {range(m) && <div className="text-[11px] text-dim">{range(m)}</div>}
      </div>,
      <span key="mc" className="font-mono">{usd(m.mean_cost_usd)}</span>,
      <span key="cs" className="font-mono">{usd(m.cost_per_success_usd)}</span>,
      eligibleCell(m),
    ]);
  return (
    <Section id="compare" title="How every model compares on this job" endpoint="same response">
      <Hint>
        Older runs count less (decay), runs on superseded versions fade ~4× faster. {ruleSentence(r)}
      </Hint>
      <DataTable
        head={["Model", "Catalog", "Runs", "Evidence", "Pass rate", "Mean cost", "Cost / success", "Eligible?"]}
        rows={rows}
        empty="No runs yet."
      />
    </Section>
  );
}

/** "Did something break? Alerts": this job's regressions, and whether the team's webhook got them. */
export function AlertsSection({ jobName }: { jobName: string }) {
  const { data } = useJobRegressions(jobName);
  const alerts = data ?? [];
  return (
    <Section id="alerts" title="Did something break? Alerts" endpoint={`GET /v1/jobs/${jobName}/regressions`} raw={alerts}>
      {alerts.length === 0 ? (
        <Hint>No alerts. The daily check looks for regressions across version changes and silent drops.</Hint>
      ) : (
        <div className="space-y-2">
          {alerts.map((a) => (
            <div
              key={a.alert_id}
              className={`rounded-md border-l-4 bg-bg p-3 ${a.kind === "MODEL_DEPRECATED" ? "border-warn" : "border-bad"}`}
            >
              <Tag tone={a.kind === "MODEL_DEPRECATED" ? "warn" : "bad"}>{a.kind}</Tag>
              <div className="mt-1 text-sm text-ink">{a.summary}</div>
              <div className="mt-0.5 text-xs text-dim">
                {a.delivered_at ? "Sent to the team's webhook" : a.delivery_attempts > 0 ? "Not delivered yet, retrying" : "Waiting to be sent"}{" "}
                · {minute(a.created_at)}
                {a.resolved_at ? ` · resolved ${minute(a.resolved_at)}` : ""}
              </div>
            </div>
          ))}
        </div>
      )}
    </Section>
  );
}

/** "Why are we using this model? History". */
export function HistorySection({ jobName }: { jobName: string }) {
  const { data } = useJobHistory(jobName);
  return (
    <Section id="history" title="Why are we using this model? History" endpoint={`GET /v1/jobs/${jobName}/history`} raw={data}>
      <JobHistoryTimeline jobName={jobName} />
    </Section>
  );
}

const BAND_ORDER = ["under 8k", "8k to 32k", "over 32k"];

function bandTable(rows: Breakdown[]) {
  const models = [...new Set(rows.map((x) => x.model))];
  const bands = [...new Set(rows.map((x) => x.group))].sort((a, b) => BAND_ORDER.indexOf(a) - BAND_ORDER.indexOf(b));
  const cell = (m: string, b: string) => {
    const x = rows.find((y) => y.model === m && y.group === b);
    if (!x) return <span className="text-dim">—</span>;
    const tone = x.pass_rate >= 0.97 ? "text-ok" : x.pass_rate < 0.9 ? "text-bad" : "text-ink";
    return (
      <span className={`font-mono ${tone}`}>
        {pct(x.pass_rate)} <span className="text-dim">({x.runs.toLocaleString()})</span>
      </span>
    );
  };
  return { head: ["Model", ...bands.map((b) => `${b} tokens`)], rows: models.map((m) => [<b key="m" className="font-mono">{m}</b>, ...bands.map((b) => cell(m, b))]) };
}

/** "Breakdowns": every number in a table, as in the prototype. */
export function BreakdownSection({ jobName }: { jobName: string }) {
  const { data } = useJobInsights(jobName);
  const sizes = bandTable(data?.by_input_size ?? []);
  const prompts = (data?.by_prompt_version ?? []).map((x) => [
    <span key="m" className="font-mono">{x.model}</span>,
    <span key="g" className="font-mono">{x.group}</span>,
    <span key="n" className="font-mono">{x.runs.toLocaleString()}</span>,
    <span key="p" className="font-mono">{pct(x.pass_rate)} <span className="text-[11px] text-dim">({pct(x.pass_rate_low)}–{pct(x.pass_rate_high)})</span></span>,
  ]);
  return (
    <Section id="breakdowns" title="Breakdowns" endpoint={`GET /v1/jobs/${jobName}/insights`} raw={data}>
      <div className="space-y-2">
        <h4 className="text-sm font-bold text-ink">Pass rate by input size</h4>
        <Hint>Cheap models often do fine on short inputs and struggle on long ones.</Hint>
        <DataTable head={sizes.head} rows={sizes.rows} empty="No checked runs in the last 90 days." />
      </div>
      <div className="space-y-2">
        <h4 className="text-sm font-bold text-ink">Pass rate by prompt version</h4>
        <DataTable head={["Model", "Prompt", "Runs", "Pass rate"]} rows={prompts} empty="No checked runs in the last 90 days." />
      </div>
      {data && <Hint>Last {data.days} days of checked runs. A group with few runs is shown, but should not decide anything.</Hint>}
    </Section>
  );
}

/** "Where does the money go? Spend by job": every job of the project, this one highlighted. */
export function SpendSection({ jobName }: { jobName: string }) {
  const { data } = useSpendInsights();
  const rows = data ?? [];
  const max = Math.max(...rows.map((x) => x.spend_usd), 0.0001);
  return (
    <Section id="spend" title="Where does the money go? Spend by job" endpoint="GET /v1/insights/spend" raw={rows}>
      {rows.length === 0 ? (
        <Hint>No spend yet.</Hint>
      ) : (
        <div className="space-y-3">
          {rows.map((x) => (
            <div key={x.job}>
              <div className="flex justify-between text-sm">
                <b className={x.job === jobName ? "text-accent" : "text-ink"}>{x.job}</b>
                <span className="font-mono text-ink">
                  {usd(x.spend_usd, 2)} · {pct(x.share)} · {x.runs.toLocaleString()} runs
                  {x.unpriced_runs > 0 && <span className="text-dim"> · {x.unpriced_runs} unpriced</span>}
                </span>
              </div>
              <div className="mt-1 h-2 rounded-full bg-accent transition-all duration-700" style={{ width: `${(x.spend_usd / max) * 100}%` }} />
            </div>
          ))}
        </div>
      )}
    </Section>
  );
}

/** "Model catalog": the versions this job has run on, with the version that replaced each one. */
export function CatalogSection({ jobName }: { jobName: string }) {
  const history = useJobHistory(jobName);
  const catalog = useQuery({
    queryKey: ["models", "used"],
    queryFn: () => apiFetch<ModelPage>("/v1/models?used=true&limit=500"),
  });
  const versions = (history.data as History | undefined)?.versions ?? [];
  const byName = new Map<string, Model>();
  for (const m of catalog.data?.items ?? []) {
    byName.set(m.model_version.toLowerCase(), m);
    if (!byName.has(m.model.toLowerCase())) byName.set(m.model.toLowerCase(), m);
  }
  const ordered = [...versions].sort((a, b) => a.model.localeCompare(b.model) || a.first_seen.localeCompare(b.first_seen));
  const rows = ordered.map((v, i) => {
    const entry = byName.get(v.model_version.toLowerCase()) ?? byName.get(v.model.toLowerCase());
    const next = ordered[i + 1] && ordered[i + 1].model === v.model ? ordered[i + 1].model_version : null;
    return [
      <span key="v" className="whitespace-nowrap font-mono text-xs">{v.model_version}</span>,
      entry ? <Tag key="s" tone={CATALOG_TONE[entry.status]}>{entry.status}</Tag> : <Tag key="s" tone="neutral">NOT IN CATALOG</Tag>,
      <span key="d" className="font-mono text-xs">{entry?.shutdown_date ?? "—"}</span>,
      <span key="i" className="font-mono text-xs">{entry?.price_in_per_mtok ?? "—"}</span>,
      <span key="o" className="font-mono text-xs">{entry?.price_out_per_mtok ?? "—"}</span>,
      <span key="r" className="whitespace-nowrap font-mono text-xs">{next ?? "—"}</span>,
      <span key="n" className="font-mono text-xs">{v.runs.toLocaleString()}</span>,
    ];
  });
  return (
    <Section id="catalog" title="Model catalog" endpoint="GET /v1/models" raw={catalog.data?.items.filter((m) => versions.some((v) => v.model_version.toLowerCase() === m.model_version.toLowerCase() || v.model.toLowerCase() === m.model.toLowerCase()))}>
      <DataTable
        head={["Version", "Status", "Shuts down", "$/1M in", "$/1M out", "Replaced by", "Runs"]}
        rows={rows}
        empty="No model versions recorded for this job yet."
      />
    </Section>
  );
}

/** "Latest recorded runs (episodic memory)". */
export function RunsSection({ jobName }: { jobName: string }) {
  const { data } = useQuery({
    queryKey: ["runs", "latest", jobName],
    queryFn: () => apiFetch<RunPage>(`/v1/runs?job=${encodeURIComponent(jobName)}&limit=25`),
    refetchInterval: 30_000,
  });
  const runs = data?.items ?? [];
  const anyEffort = runs.some((x) => x.effort);
  const rows = runs.map((x) => [
    <span key="id" className="font-mono text-xs" title={x.run_id}>{x.run_id.slice(0, 8)}</span>,
    <span key="w" className="whitespace-nowrap text-xs">{minute(x.created_at).slice(5)}</span>,
    <span key="k" className="text-xs">{x.run_kind}</span>,
    <span key="v" className="whitespace-nowrap font-mono text-xs">{x.model_version}</span>,
    ...(anyEffort ? [<span key="ef" className="text-xs">{x.effort ?? "—"}</span>] : []),
    <span key="p" className="text-xs">{x.prompt_version ?? "—"}</span>,
    <span key="t" className="font-mono text-xs">{x.tokens_in}/{x.tokens_out}</span>,
    <span key="c" className="font-mono text-xs">{x.cache_read_tokens}/{x.cache_write_tokens}</span>,
    <span key="$" className="font-mono text-xs">{usd(x.cost_usd)}</span>,
    <Tag key="o" tone={x.outcome === "PASS" ? "ok" : x.outcome === "FAIL" ? "bad" : "neutral"}>{x.outcome}</Tag>,
    <span key="y" className="text-xs">{x.outcome_reason ?? "—"}</span>,
    <span key="i" className="font-mono text-xs">{Number(x.importance_score.toFixed(4))}</span>,
    <span key="wt" className="font-mono text-xs">{x.weight !== null && x.weight !== undefined ? x.weight.toFixed(2) : "—"}</span>,
    <Tag key="s" tone="neutral">{x.state}</Tag>,
  ]);
  const head = ["Run", "When", "Kind", "Version", ...(anyEffort ? ["Effort"] : []), "Prompt", "Tokens in/out", "Cache r/w", "Cost", "Outcome", "Why", "Importance", "Weight", "State"];
  return (
    <Section id="runs" title="Latest recorded runs (episodic memory)" endpoint={`GET /v1/runs?job=${jobName}`} raw={runs}>
      <DataTable head={head} rows={rows} empty="No runs yet." />
    </Section>
  );
}
