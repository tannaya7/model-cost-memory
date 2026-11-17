/** A small note on the Overview, shown once, when the first checked answers reach the evidence floor. */
import { useProject } from "../../app/project";
import { MIN_CHECKED_ANSWERS } from "../../screens/compare/wilson";
import { Button } from "../../ui/primitives";
import { useDaily } from "../insights/api/dailyApi";
import type { GuideFlags } from "./steps";
import { useGuideFlags } from "./useGuideFlags";

/** True once enough answers are checked for the results to mean something (the same floor as everywhere else). */
export function firstResultsReady(a: { owned: boolean; flagsLoaded: boolean; flags: GuideFlags; checked: number; floor?: number }): boolean {
  return a.owned && a.flagsLoaded && !a.flags.first_results_seen && a.checked >= (a.floor ?? MIN_CHECKED_ANSWERS);
}

export function FirstResults({ floor }: { floor?: number }) {
  const { mode } = useProject();
  const { loaded, flags, set } = useGuideFlags();
  const daily = useDaily({ days: 90 });
  const checked = (daily.data ?? []).reduce((s, d) => s + (d.passed ?? 0) + (d.failed ?? 0), 0);
  if (!firstResultsReady({ owned: mode === "owned", flagsLoaded: loaded, flags, checked, floor })) return null;
  return (
    <section aria-labelledby="first-results-title" className="rounded-[16px] border border-accent/40 bg-accent-soft p-4 md:p-5">
      <h2 id="first-results-title" className="text-base font-semibold text-ink">Your first results are in</h2>
      <p className="mt-1 text-sm text-dim">Start here:</p>
      <ul className="mt-2 flex list-disc flex-col gap-1 pl-5 text-sm text-dim">
        <li>The Spend card is what you spent.</li>
        <li>The Saving available card, and each AI task page, show the model we would suggest. It is a suggestion from your own checked answers. Nothing changes unless you decide.</li>
        <li>On an AI task, the range shows how sure we are. With only a few checked answers it is wide, and it narrows as more are checked.</li>
      </ul>
      <div className="mt-3">
        <Button size="sm" variant="primary" onClick={() => set("first_results_seen", true)}>Got it</Button>
      </div>
    </section>
  );
}
