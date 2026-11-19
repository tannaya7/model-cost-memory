/** "Where your tokens went": the biggest contributors to your tokens, what each is made of, and what repeats. Also used on each AI task's Tokens tab. */
import { useState } from "react";
import { Link } from "react-router-dom";
import { jobTitle } from "../../features/jobs/jobTitle";
import { usePromptGroups, type GroupBy, type PromptGroup, type PromptGroups, type TokenPart } from "../../features/insights/api/promptsApi";
import { count, pct, usd } from "../../ui/format";
import { NoCallsYet } from "../../ui/NotEnoughData";
import { EmptyState, ErrorState, Segmented, Skeleton } from "../../ui/primitives";
import { Shell, type Ctx, type ShellProps } from "./widgets";
import { promptHints } from "./promptHints";
import { useBillingMode, type BillingMode } from "../../features/projects/hooks/useBillingMode";

export const MIN_TEXT_SAMPLES = 5;
const TOKENS_HELP_SUB = "Tokens are the small pieces of text that AI reads and writes. Some providers count text they have already seen differently, so the same start in every call may help. We have not verified how your plan counts it.";
const TOKENS_HELP = "Tokens are the small pieces of text that AI is billed by. Many providers charge much less for text they have already seen, so the same start in every call can cost less.";

const GROUPINGS: Array<{ value: GroupBy; label: string }> = [
  { value: "task_version", label: "Task and version" },
  { value: "task", label: "Task" },
  { value: "agent", label: "Agent" },
  { value: "prompt_version", label: "Prompt version" },
  { value: "template", label: "Receipt: agent, task, version" },
];

type Parts = { start: number; changes: number; end: number };

/** The three parts of a prompt as shares of its length: same at the start, changes each call, same at the end. */
export function anatomy(g: PromptGroup): Parts | null {
  if (g.text_samples < MIN_TEXT_SAMPLES || g.repeated_start_share === null || g.repeated_end_share === null) return null;
  const start = Math.min(Math.max(g.repeated_start_share, 0), 1);
  const end = Math.min(Math.max(g.repeated_end_share, 0), 1 - start);
  return { start, changes: Math.max(0, 1 - start - end), end };
}

/** "18 Oct to 17 Nov 2026 (UTC)" for the exact period the server counted. */
export function periodText(data: Pick<PromptGroups, "period_start" | "period_end" | "timezone">): string | null {
  if (!data.period_start || !data.period_end) return null;
  const f = (iso: string, year: boolean) =>
    new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", ...(year ? { year: "numeric" } : {}), timeZone: "UTC" });
  return `${f(data.period_start, false)} to ${f(data.period_end, true)} (${data.timezone ?? "UTC"})`;
}

function AnatomyBar({ a }: { a: Parts }) {
  const seg = (w: number, cls: string) => (w > 0 ? <div className={cls} style={{ width: `${w * 100}%` }} /> : null);
  return (
    <div className="mt-3">
      <div
        role="img"
        aria-label={`${pct(a.start, 0)} same every time at the start, ${pct(a.changes, 0)} changes each call, ${pct(a.end, 0)} same every time at the end`}
        className="flex h-3 overflow-hidden rounded-full bg-surface-3"
      >
        {seg(a.start, "bg-accent")}
        {seg(a.changes, "bg-surface-3")}
        {seg(a.end, "bg-accent-2")}
      </div>
      <ul className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 text-xs text-dim">
        <li>
          <span className="mr-1.5 inline-block h-2 w-2 rounded-full bg-accent" />
          Same every time, at the start <span className="tabular">{pct(a.start, 0)}</span>
        </li>
        <li>
          <span className="mr-1.5 inline-block h-2 w-2 rounded-full border border-rule bg-surface-3" />
          Changes each call <span className="tabular">{pct(a.changes, 0)}</span>
        </li>
        {a.end > 0 && (
          <li>
            <span className="mr-1.5 inline-block h-2 w-2 rounded-full bg-accent-2" />
            Same every time, at the end <span className="tabular">{pct(a.end, 0)}</span>
          </li>
        )}
      </ul>
    </div>
  );
}

const WHY_MISSING: Record<"not_reported" | "unknown", string> = {
  not_reported: "not reported by the providers used",
  unknown: "unknown for some or all of these calls",
};

/** What the total is made of. A part shows only if a provider reported it; the rest are named, never shown as 0. */
function Breakdown({ parts }: { parts: TokenPart[] }) {
  const shown = parts.filter((p) => p.state === "measured" && p.tokens !== null);
  const missing = parts.filter((p) => p.state !== "measured");
  return (
    <div className="mt-2 text-[13px] text-dim" data-testid="breakdown">
      <p className="tabular">
        {shown.map((p, i) => (
          <span key={p.key}>
            {i > 0 && " · "}
            {p.label} <span className="font-semibold text-ink">{count(p.tokens)}</span>
            {p.calls ? <span className="text-muted"> ({count(p.calls)} calls reported)</span> : null}
          </span>
        ))}
      </p>
      {missing.length > 0 && (
        <p className="mt-0.5 text-xs text-muted">
          Not available: {missing.map((p) => `${p.label.replace("of which ", "")} (${WHY_MISSING[p.state as "not_reported" | "unknown"]})`).join("; ")}.
        </p>
      )}
    </div>
  );
}

/** What the row cost, only when the server sent it. Money is worded for how the project pays, and an unknown is never shown as $0. */
function CostLine({ g, mode }: { g: PromptGroup; mode: BillingMode }) {
  if (g.spend_usd === undefined) return null;
  const unpriced = g.unpriced_calls ?? 0;
  const gap = unpriced > 0 ? ` ${count(unpriced)} ${unpriced === 1 ? "call has" : "calls have"} no known price and ${unpriced === 1 ? "is" : "are"} not counted.` : "";
  if (g.spend_usd === null) {
    return <p className="mt-1 text-[13px] text-dim" data-testid="cost-line">{mode === "per_use" ? "Cost" : "List price"} unknown: no call in this row has a known price.</p>;
  }
  return (
    <p className="mt-1 text-[13px] text-dim tabular" data-testid="cost-line">
      {mode === "per_use" ? "Cost" : "List price"} <span className="font-semibold text-ink">{usd(g.spend_usd)}</span>
      {g.cost_share != null ? ` (${pct(g.cost_share, 0)} of the priced ${mode === "per_use" ? "cost" : "list price"})` : ""}
      {mode === "per_use" ? ", at list prices" : ", not your bill"}.{gap}
    </p>
  );
}

function Coverage({ g }: { g: PromptGroup }) {
  const notes: string[] = [];
  if ((g.no_usage_calls ?? 0) > 0) notes.push(`${count(g.no_usage_calls)} of ${count(g.calls)} calls came back with no token counts, so their tokens are unknown`);
  if ((g.legacy_calls ?? 0) > 0) notes.push(`${count(g.legacy_calls)} were recorded before token parts were tracked`);
  if (notes.length === 0) return null;
  return <p className="mt-1 text-xs text-muted">{notes.join("; ")}.</p>;
}

function GroupCard({ g, mode, days, showText, onShowText }: { g: PromptGroup; mode: BillingMode; days: number; showText: boolean; onShowText: (v: boolean) => void }) {
  const a = anatomy(g);
  const tips = promptHints(g, mode);
  const removed = g.text_samples === 0 && (g.text_calls ?? 0) === 0 && !g.text_note;
  const byTask = !g.group_by || g.group_by === "task_version";
  const heading = byTask ? jobTitle(g.job) : g.label || g.job;
  return (
    <li className="rounded-[12px] border border-rule bg-surface-2 p-4">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <p className="min-w-0 text-sm font-semibold text-ink" title={g.job ? `Name in your code: ${g.job}` : undefined}>
          {heading}
          {byTask && g.job && <span className="ml-1 rounded-md border border-rule bg-surface px-1.5 py-0.5 font-mono text-[11px] font-normal text-dim">{g.job}</span>}
          {byTask && g.prompt_version && <span className="ml-1 rounded-md border border-rule bg-surface px-1.5 py-0.5 font-mono text-[11px] font-normal text-dim">version {g.prompt_version}</span>}
        </p>
        <p className="text-sm font-semibold text-ink tabular">{pct(g.share, 0)} of your tokens</p>
      </div>
      <p className="mt-1 text-[13px] text-dim tabular">
        {count(g.calls)} calls · typically {count(Math.round(g.avg_tokens_in))} tokens in and {count(Math.round(g.avg_tokens_out))} out
      </p>
      <CostLine g={g} mode={mode} />
      {g.breakdown && g.breakdown.length > 0 && <Breakdown parts={g.breakdown} />}
      <Coverage g={g} />
      {g.grouping_basis === "untagged" && (
        <p className="mt-1 text-xs text-muted" data-testid="estimated-grouping">
          <span className="mr-1.5 whitespace-nowrap rounded-full bg-surface-3 px-1.5 py-0.5 text-[10px] font-semibold text-muted">estimated grouping</span>
          These calls carry no {g.group_by === "agent" ? "agent name" : "version label"}, so they are grouped only by the labels they do have. Their prompt text is not compared.
        </p>
      )}

      {g.text_note ? (
        <p className="mt-2 text-xs text-muted">{g.text_note}</p>
      ) : removed ? (
        <p className="mt-2 text-[13px] text-dim">The text of these calls was removed after your retention period, so we can only show the counts.</p>
      ) : a ? (
        <>
          <AnatomyBar a={a} />
          <p className="mt-1 text-xs text-muted" data-testid="sample-note">
            {g.text_calls !== undefined && g.text_calls > g.text_samples
              ? `Estimated from the newest ${count(g.text_samples)} of ${count(g.text_calls)} calls with stored text: a sample, not the whole ${days} days.`
              : `Estimated from ${count(g.text_samples)} ${g.text_samples === 1 ? "call" : "calls"} with stored text.`}
          </p>
          {showText ? (
            <p className="mt-2 text-xs text-muted">
              {g.repeated_start_preview ? (
                <>
                  <span className="italic">Every sampled call starts: "{g.repeated_start_preview}"</span>{" "}
                  (text from your prompts; emails, links and keys are hidden){" "}
                </>
              ) : (
                <>No clear repeated start to show. </>
              )}
              <button type="button" onClick={() => onShowText(false)} className="font-semibold text-accent-ink hover:underline">Hide</button>
            </p>
          ) : (
            <p className="mt-2 text-xs text-muted">
              <button type="button" onClick={() => onShowText(true)} className="font-semibold text-accent-ink hover:underline">Show the repeated start</button>
              {" "}(this shows text from your prompts, with emails, links and keys hidden)
            </p>
          )}
        </>
      ) : (
        <p className="mt-2 text-[13px] text-dim">
          We need at least {MIN_TEXT_SAMPLES} stored calls to show the split. This prompt has {g.text_samples} so far.
        </p>
      )}

      {g.job && (
        <p className="mt-3 text-[13px]">
          <Link to={`/jobs/${encodeURIComponent(g.job)}?tab=tokens#prompt-versions`} className="font-semibold text-accent-ink hover:underline">
            Compare prompt versions of this task
          </Link>
        </p>
      )}

      {tips.length > 0 && (
        <div className="mt-3">
          <p className="text-xs font-semibold uppercase tracking-wider text-muted">Ideas, not promises</p>
          <ul className="mt-1 space-y-2">
            {tips.map((t) => (
              <li key={t.id} className="text-[13px]">
                <span className="font-semibold text-ink">{t.title}. </span>
                <span className="text-dim">{t.text}</span>{" "}
                <span className="whitespace-nowrap rounded-full bg-surface-3 px-1.5 py-0.5 text-[10px] font-semibold text-muted">
                  {t.basis === "estimated" ? "estimated from a sample" : "measured"}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </li>
  );
}

/** The body shared by the widget and the task's Tokens tab. */
export function TokensWentBody({ days, job, limit }: { days: number; job?: string; limit: number }) {
  const [groupBy, setGroupBy] = useState<GroupBy>("task_version");
  const [showText, setShowText] = useState(false);
  const q = usePromptGroups({ days, job, limit, group_by: groupBy, show_text: showText });
  const { mode } = useBillingMode();
  const picker = (
    <div className="mb-3 flex flex-wrap items-center gap-2">
      <span className="text-xs font-semibold text-muted">Group by</span>
      <Segmented<GroupBy> label="Group the tokens by" value={groupBy} options={GROUPINGS} onChange={(v) => { setGroupBy(v); setShowText(false); }} />
    </div>
  );
  if (q.isPending) {
    return (
      <div>
        {picker}
        <div className="space-y-3" aria-busy="true">
          <Skeleton className="h-28 w-full" />
          <Skeleton className="h-28 w-full" />
        </div>
      </div>
    );
  }
  if (q.isError) return <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  const groups = Array.isArray(q.data?.groups) ? q.data.groups : [];
  if (groups.length === 0 || !(q.data.total_tokens > 0)) {
    return job ? (
      <EmptyState title="No token counts yet" hint="Once this AI task's calls report their tokens, you will see here how they were spent and what to change." />
    ) : (
      <NoCallsYet />
    );
  }
  const period = periodText(q.data);
  return (
    <>
      {picker}
      <p className="mb-3 text-xs text-muted" data-testid="coverage">
        {period ? `${period}. ` : `Last ${q.data.days} days. `}
        {q.data.total_calls !== undefined ? `Token totals count every one of the ${count(q.data.total_calls)} AI calls in this period, not a sample. ` : ""}
        {q.data.grouping_note ?? ""}
        {q.data.group_by === "template" ? " This receipt shows what was observed. It does not say that changing a template would save money." : ""}
      </p>
      <ul className="space-y-3">
        {groups.map((g) => (
          <GroupCard key={`${g.group_by ?? "task_version"}:${g.label ?? g.job}:${g.job}:${g.prompt_version ?? ""}`} g={g} mode={mode} days={q.data.days} showText={showText} onShowText={setShowText} />
        ))}
      </ul>
      <p className="mt-3 text-xs text-muted">Tips are observations, not promises: what a change saves depends on your provider, model and settings.</p>
    </>
  );
}

export function TokensWent({ ctx, shell }: { ctx: Ctx; shell: ShellProps }) {
  const { mode } = useBillingMode();
  return (
    <Shell shell={shell} title="Where your tokens went" help={mode === "subscription" ? TOKENS_HELP_SUB : TOKENS_HELP} hint="Which tasks, agents or prompt versions use the most tokens, and what to look at.">
      <TokensWentBody days={ctx.days} limit={3} />
    </Shell>
  );
}
