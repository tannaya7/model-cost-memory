/** A small note on the Overview, shown once, when the first checked answers reach the evidence floor. */
import { useProject } from "../../app/project";
import { MIN_CHECKED_ANSWERS } from "../../screens/compare/wilson";
import { Button } from "../../ui/primitives";
import { useDaily } from "../insights/api/dailyApi";
import { useBillingMode } from "../projects/hooks/useBillingMode";
import type { GuideFlags } from "./steps";
import { useGuideFlags } from "./useGuideFlags";

/** True once enough answers are checked for the results to mean something (the same floor as everywhere else). */
export function firstResultsReady(a: { owned: boolean; flagsLoaded: boolean; flags: GuideFlags; checked: number; floor?: number }): boolean {
  return a.owned && a.flagsLoaded && !a.flags.first_results_seen && a.checked >= (a.floor ?? MIN_CHECKED_ANSWERS);
}

export function FirstResults({ floor }: { floor?: number }) {
  const { mode } = useProject();
  const { mode: billing } = useBillingMode();
  const { loaded, flags, set } = useGuideFlags();
  const daily = useDaily({ days: 90 });
  const checked = (daily.data ?? []).reduce((s, d) => s + (d.passed ?? 0) + (d.failed ?? 0), 0);
  if (!firstResultsReady({ owned: mode === "owned", flagsLoaded: loaded, flags, checked, floor })) return null;
  return (
    <section aria-labelledby="first-results-title" className="flex flex-col gap-3 rounded-[16px] border border-accent/40 bg-accent-soft p-4 sm:flex-row sm:items-center sm:justify-between sm:gap-6 md:px-5 md:py-4">
      <div className="min-w-0">
      <h2 id="first-results-title" className="text-base font-semibold text-ink">Your first results are in</h2>
      <p className="mt-1 text-sm text-dim">
        {billing === "subscription"
          ? "Usage is how much your app used, and its list price is not your bill. Ideas to make your allowance last are suggestions. Nothing changes unless you decide. A wide range means few checked answers."
          : "Spend is what you paid. The saving is our suggestion. Nothing changes unless you decide. A wide range means few checked answers."}
      </p>
      </div>
      <div className="shrink-0">
        <Button size="sm" variant="primary" onClick={() => set("first_results_seen", true)}>Got it</Button>
      </div>
    </section>
  );
}
