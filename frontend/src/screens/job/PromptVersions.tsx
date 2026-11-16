/** "Before and after a prompt change": one task's prompt versions side by side, in plain words. Facts only. */
import { usePromptVersions, type PromptVersion, type PromptVersions as Data } from "../../features/insights/api/promptVersionsApi";
import { count, pct, shortDate, usd } from "../../ui/format";
import { Help } from "../../ui/Help";
import { summaryText } from "./promptCompare";
import { ErrorState, Skeleton } from "../../ui/primitives";

export const MIN_CHECKED = 25;
const NOT_CHANGED = "This shows what changed, not why. To prove a change helps, test it on the same examples first.";
const HELP =
  "A prompt version is one wording of the instructions you send the AI. Here we line up the versions of this task so you can see what changed in tokens, cost and checked answers. We never say a version is better or worse: a smaller prompt can still cost more if it loses cached text or makes answers longer.";

function range(v: PromptVersion) {
  return `${shortDate(v.first_seen)} to ${shortDate(v.last_seen)}`;
}

function Correct({ v }: { v: PromptVersion }) {
  if (v.correct_rate === null) {
    return (
      <span>
        Not enough checked answers yet
        <span className="block text-xs text-muted tabular">{v.checked} of {MIN_CHECKED} needed</span>
      </span>
    );
  }
  return (
    <span className="tabular">
      {pct(v.correct_rate, 0)}
      <span className="block text-xs text-muted">
        likely between {pct(v.rate_low, 0)} and {pct(v.rate_high, 0)}, from {count(v.checked)} checked
      </span>
    </span>
  );
}

function Cost({ v }: { v: PromptVersion }) {
  if (v.cost_per_call === null) return <span className="text-muted">No price known</span>;
  return (
    <span className="tabular">
      {v.cost_per_call < 1 ? `$${v.cost_per_call.toFixed(4)}` : usd(v.cost_per_call)}
      {v.unpriced_calls > 0 && <span className="block text-xs text-muted">{count(v.unpriced_calls)} of {count(v.calls)} calls not priced</span>}
    </span>
  );
}

const ROWS: { label: string; cell: (v: PromptVersion) => React.ReactNode }[] = [
  { label: "First and last seen", cell: (v) => <span className="tabular">{range(v)}</span> },
  { label: "Calls", cell: (v) => <span className="tabular">{count(v.calls)}</span> },
  { label: "Typical tokens in", cell: (v) => <span className="tabular">{count(Math.round(v.typical_tokens_in))}</span> },
  { label: "Typical tokens out", cell: (v) => <span className="tabular">{count(Math.round(v.typical_tokens_out))}</span> },
  { label: "Cached share", cell: (v) => <span className="tabular">{v.cache_read_share === null ? "–" : pct(v.cache_read_share, 0)}</span> },
  { label: "List-price cost per call", cell: (v) => <Cost v={v} /> },
  { label: "Correct answers", cell: (v) => <Correct v={v} /> },
];

function Table({ versions }: { versions: PromptVersion[] }) {
  // one card per version on a phone, one column per version on a wide screen
  return (
    <>
      <div className="hidden overflow-x-auto md:block">
        <table className="w-full text-left text-[13px]">
          <thead>
            <tr className="border-b border-rule">
              <th scope="col" className="py-2 pr-3 font-medium text-muted"><span className="sr-only">Measure</span></th>
              {versions.map((v) => (
                <th key={v.label} scope="col" className="px-3 py-2 align-top font-semibold text-ink">
                  {v.label}
                  {v.kind === "detected" && <span className="ml-2 rounded-full border border-rule bg-surface px-2 py-0.5 text-[11px] font-medium text-dim">Detected</span>}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {ROWS.map((r) => (
              <tr key={r.label} className="border-b border-rule/60 last:border-0">
                <th scope="row" className="py-2 pr-3 align-top font-medium text-dim">{r.label}</th>
                {versions.map((v) => (
                  <td key={v.label} className="px-3 py-2 align-top text-ink">{r.cell(v)}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <ul className="space-y-3 md:hidden">
        {versions.map((v) => (
          <li key={v.label} className="rounded-[12px] border border-rule bg-surface-2 p-3">
            <p className="text-sm font-semibold text-ink">
              {v.label}
              {v.kind === "detected" && <span className="ml-2 rounded-full border border-rule bg-surface px-2 py-0.5 text-[11px] font-medium text-dim">Detected</span>}
            </p>
            <dl className="mt-2 space-y-1.5 text-[13px]">
              {ROWS.map((r) => (
                <div key={r.label} className="flex justify-between gap-3">
                  <dt className="text-dim">{r.label}</dt>
                  <dd className="min-w-0 text-right text-ink">{r.cell(v)}</dd>
                </div>
              ))}
            </dl>
          </li>
        ))}
      </ul>
    </>
  );
}

function HowToTag() {
  return (
    <div className="mt-3 rounded-[12px] border border-rule bg-surface-2/50 p-3 text-[13px] text-dim">
      <p className="font-semibold text-ink">How to tag a version</p>
      <p className="mt-1">Add <code className="rounded bg-surface-3 px-1 font-mono text-xs">prompt_version</code> to the recorder in your code, and change it whenever you change the prompt:</p>
      <pre className="mt-2 overflow-x-auto rounded-md bg-surface-3 p-2 font-mono text-xs text-ink">{`with RunRecorder(job="your-task", prompt_version="v2") as rec:\n    ...`}</pre>
      <p className="mt-2">Calls recorded after that appear here as separate versions.</p>
    </div>
  );
}

function Nothing({ data }: { data: Data }) {
  if (data.reason === "text_not_kept") {
    return (
      <div className="rounded-[12px] border border-rule bg-surface-2/50 p-3 text-[13px] text-dim">
        <p className="font-semibold text-ink">Not available: the prompt text was not kept.</p>
        <p className="mt-1">Without the text we cannot tell where your prompt changed. You can still tag versions yourself.</p>
        <HowToTag />
      </div>
    );
  }
  if (data.reason === "unstable") {
    return (
      <div className="rounded-[12px] border border-rule bg-surface-2/50 p-3 text-[13px] text-dim">
        <p className="font-semibold text-ink">The start of this prompt changes too often to tell versions apart.</p>
        <p className="mt-1">That usually means each call starts with different text. Tagging a version tells us exactly what to compare.</p>
        <HowToTag />
      </div>
    );
  }
  return (
    <div className="rounded-[12px] border border-rule bg-surface-2/50 p-3 text-[13px] text-dim">
      <p className="font-semibold text-ink">{data.reason === "no_calls" ? "No calls in the last " + data.days + " days." : "Only one version so far."}</p>
      {data.reason !== "no_calls" && <p className="mt-1">We have not seen this task's prompt change, and no version tags were sent. Nothing is wrong: there is simply nothing to compare yet.</p>}
      <HowToTag />
    </div>
  );
}

export function PromptVersions({ job, days = 30 }: { job: string; days?: number }) {
  const q = usePromptVersions({ job, days });
  return (
    <section id="prompt-versions" aria-labelledby="pv-title" className="scroll-mt-20">
      <div className="flex items-center gap-2">
        <h2 id="pv-title" className="text-[15px] font-semibold tracking-tight text-ink">Before and after a prompt change</h2>
        <Help label="What is a prompt version?">{HELP}</Help>
      </div>
      <p className="mb-3 mt-0.5 text-[13px] text-dim">Your prompt versions for this task, side by side, from the last {days} days.</p>
      {q.isPending ? (
        <Skeleton className="h-40 w-full" />
      ) : q.isError ? (
        <ErrorState error={q.error} onRetry={() => void q.refetch()} />
      ) : q.data.source === "none" || !Array.isArray(q.data.versions) || q.data.versions.length === 0 ? (
        <Nothing data={q.data} />
      ) : (
        <>
          <p className="mb-2 text-xs text-muted">
            {q.data.source === "detected"
              ? "Detected: you did not tag versions, so we found where the start of the stored prompt changed and stayed changed. These are not tags you sent."
              : "Tagged: these are the prompt_version values your code sent."}
          </p>
          {q.data.comparison && (
            <div className="mb-3 rounded-[12px] border border-rule bg-surface-2 p-3">
              <p className="text-[13px] font-semibold text-ink">
                {q.data.comparison.side_by_side ? "Ran side by side" : "Ran at different times, so other things may have changed"}
              </p>
              <p className="mt-1 text-[13px] text-ink">{summaryText(q.data.comparison.summary, q.data.versions, q.data.comparison.older, q.data.comparison.newer)}</p>
              <p className="mt-1 text-xs text-muted">{NOT_CHANGED}</p>
            </div>
          )}
          <Table versions={q.data.versions} />
          {q.data.source === "detected" && q.data.versions.some((v) => v.start_preview) && (
            <ul className="mt-3 space-y-1 text-xs italic text-muted">
              {q.data.versions.map((v) => v.start_preview && <li key={v.label} className="break-words">{v.label} starts: "{v.start_preview}"</li>)}
            </ul>
          )}
          {q.data.versions.some((v) => v.kind === "untagged") && <p className="mt-2 text-xs text-muted">"No version tag" are calls that did not send a prompt_version.</p>}
          {!q.data.comparison && <HowToTag />}
        </>
      )}
    </section>
  );
}
