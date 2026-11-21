/** Models this task has never run. They have no score, so they are not drawn on the quality axis and never ranked:
 * only a list-price estimate of cost (when token counts exist) and a way to try them on the user's own past prompts. */
import { useP } from "../../app/project";
import type { Model, Recommendation } from "../../shared/api/types";
import { usd } from "../../ui/format";
import { ButtonLink } from "../../ui/primitives";
import { estimateRunCost, untestedModels } from "./suggest";
import { UNTESTED_LABEL } from "./wilson";

export function UntestedList({
  rec, catalog, avgTokens, providers, job, limit = 6,
}: {
  rec: Recommendation;
  catalog: Model[];
  avgTokens: { in: number; out: number } | null;
  providers: string[];
  job: string;
  limit?: number;
}) {
  const p = useP();
  const all = untestedModels(rec, catalog).filter((m) => providers.length === 0 || providers.includes(m.provider));
  if (all.length === 0) return null;
  const shown = all.map((m) => ({ m, cost: estimateRunCost(m, avgTokens) })).sort((a, b) => (a.cost ?? Infinity) - (b.cost ?? Infinity)).slice(0, limit);
  return (
    <section aria-label="Not tested on your work yet" data-testid="untested-list" className="flex flex-col gap-2">
      <h2 className="text-sm font-semibold text-ink">{UNTESTED_LABEL}</h2>
      <p className="text-xs text-muted">These have no score here. Any cost is an estimate from list prices, not a measurement, and says nothing about how well they answer your task.</p>
      <ul className="grid gap-2 sm:grid-cols-2">
        {shown.map(({ m, cost }) => (
          <li key={m.model} className="flex flex-wrap items-center justify-between gap-2 rounded-[10px] border border-dashed border-rule px-3 py-2">
            <span>
              <span className="block font-mono text-xs font-semibold text-ink">{m.model}</span>
              <span className="block text-[11px] text-muted">{cost == null ? "No estimate: no token counts or list price yet" : `About ${usd(cost * 1000)} per 1,000 answers at list price (estimate)`}</span>
            </span>
            <ButtonLink size="sm" variant="secondary" to={p(`/retest?job=${encodeURIComponent(job)}&model=${encodeURIComponent(m.model)}`)}>Try it on your own past prompts</ButtonLink>
          </li>
        ))}
      </ul>
      {all.length > shown.length && <p className="text-[11px] text-muted">{all.length - shown.length} more not shown. Filter by provider to narrow the list.</p>}
    </section>
  );
}
