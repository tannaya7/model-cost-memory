/** "Where your tokens went": which prompts use the most tokens, why, and what to try. Also used on each AI task's Tokens tab. */
import { jobTitle } from "../../features/jobs/jobTitle";
import { usePromptGroups, type PromptGroup } from "../../features/insights/api/promptsApi";
import { count, pct } from "../../ui/format";
import { NoCallsYet } from "../../ui/NotEnoughData";
import { EmptyState, ErrorState, Skeleton } from "../../ui/primitives";
import { Shell, type Ctx, type ShellProps } from "./widgets";
import { promptHints } from "./promptHints";

export const MIN_TEXT_SAMPLES = 5;
const TOKENS_HELP = "Tokens are the small pieces of text that AI is billed by. Many providers charge much less for text they have already seen, so the same start in every call can cost less.";

type Parts = { start: number; changes: number; end: number };

/** The three parts of a prompt as shares of its length: same at the start, changes each call, same at the end. */
export function anatomy(g: PromptGroup): Parts | null {
  if (g.text_samples < MIN_TEXT_SAMPLES || g.repeated_start_share === null || g.repeated_end_share === null) return null;
  const start = Math.min(Math.max(g.repeated_start_share, 0), 1);
  const end = Math.min(Math.max(g.repeated_end_share, 0), 1 - start);
  return { start, changes: Math.max(0, 1 - start - end), end };
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

function GroupCard({ g }: { g: PromptGroup }) {
  const a = anatomy(g);
  const tips = promptHints(g);
  const removed = g.text_samples === 0;
  return (
    <li className="rounded-[12px] border border-rule bg-surface-2 p-4">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <p className="min-w-0 text-sm font-semibold text-ink" title={`Name in your code: ${g.job}`}>
          {jobTitle(g.job)} <span className="ml-1 rounded-md border border-rule bg-surface px-1.5 py-0.5 font-mono text-[11px] font-normal text-dim">{g.job}</span>
          {g.prompt_version && <span className="ml-1 rounded-md border border-rule bg-surface px-1.5 py-0.5 font-mono text-[11px] font-normal text-dim">version {g.prompt_version}</span>}
        </p>
        <p className="text-sm font-semibold text-ink tabular">{pct(g.share, 0)} of your tokens</p>
      </div>
      <p className="mt-1 text-[13px] text-dim tabular">
        {count(g.calls)} calls · typically {count(Math.round(g.avg_tokens_in))} tokens in and {count(Math.round(g.avg_tokens_out))} out
      </p>

      {removed ? (
        <p className="mt-2 text-[13px] text-dim">The text of these calls was removed after your retention period, so we can only show the counts.</p>
      ) : a ? (
        <>
          <AnatomyBar a={a} />
          {g.repeated_start_preview && (
            <p className="mt-2 truncate text-xs italic text-muted" title={g.repeated_start_preview}>
              Every call starts: "{g.repeated_start_preview}"
            </p>
          )}
          <p className="mt-1 text-xs text-muted">Estimated from your last {g.text_samples} calls.</p>
        </>
      ) : (
        <p className="mt-2 text-[13px] text-dim">
          We need at least {MIN_TEXT_SAMPLES} stored calls to show the split. This prompt has {g.text_samples} so far.
        </p>
      )}

      {tips.length > 0 && (
        <div className="mt-3">
          <p className="text-xs font-semibold uppercase tracking-wider text-muted">Ideas, not promises</p>
          <ul className="mt-1 space-y-2">
            {tips.map((t) => (
              <li key={t.id} className="text-[13px]">
                <span className="font-semibold text-ink">{t.title}. </span>
                <span className="text-dim">{t.text}</span>
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
  const q = usePromptGroups({ days, job, limit });
  if (q.isPending) {
    return (
      <div className="space-y-3" aria-busy="true">
        <Skeleton className="h-28 w-full" />
        <Skeleton className="h-28 w-full" />
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
  return (
    <>
      <ul className="space-y-3">
        {groups.map((g) => (
          <GroupCard key={`${g.job}:${g.prompt_version ?? ""}`} g={g} />
        ))}
      </ul>
      <p className="mt-3 text-xs text-muted">Shares are of the tokens used in the last {q.data.days} days. Tips are rule-based ideas and may not fit every prompt.</p>
    </>
  );
}

export function TokensWent({ ctx, shell }: { ctx: Ctx; shell: ShellProps }) {
  return (
    <Shell shell={shell} title="Where your tokens went" help={TOKENS_HELP} hint="Which prompts use the most tokens, and what you could change.">
      <TokensWentBody days={ctx.days} limit={3} />
    </Shell>
  );
}
