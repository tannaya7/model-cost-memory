/** Cost analysis: how the spend figure was worked out, where the tokens went, and what each feature the customer labelled cost.
 *  The parts are the ones already shown on the Overview, gathered in one place; nothing is re-implemented here. Every figure is an
 *  estimate from recorded calls at list prices, never an invoice, and nothing on this page changes anything. */
import { useState } from "react";
import { Link } from "react-router-dom";
import { useP, useProject } from "../app/project";
import { canAdminister, useMyRole } from "../app/useMyRole";
import { ExportButton } from "../features/exports/ExportButton";
import { CostReceipt } from "../features/insights/components/CostReceipt";
import { EmptyState, Panel, PanelHeader, Reveal, Segmented } from "../ui/primitives";
import { FeatureCostsBody } from "./costs/FeatureCosts";
import { TokensWentBody } from "./overview/TokensWent";

const DAYS = [7, 30, 90] as const;

export default function CostAnalysis() {
  const [days, setDays] = useState("30");
  const n = Number(days);
  const p = useP();
  const { mode: scope } = useProject();
  const role = useMyRole();
  // The server decides who may download; the button is only left out for people it would refuse.
  const canExport = scope === "owned" && canAdminister(role);
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight">Cost analysis</h1>
          <p className="mt-1 max-w-2xl text-sm text-dim">
            How your spend was worked out, where the tokens went, and what each of your features cost. Estimates from recorded calls at list prices, not your invoice. Nothing here changes your app or your models.
          </p>
        </div>
        <Segmented label="Period" value={days} options={DAYS.map((d) => ({ value: String(d), label: `${d} days` }))} onChange={setDays} />
      </div>


      <Reveal>
        <Panel className="p-5 md:p-6" id="receipt">
          <PanelHeader title="How the spend was worked out" hint="Currency and period, passed, failed and unchecked calls, unpriced calls and why, the dated list prices used, and your own invoice total to compare with." />
          <div className="mt-4"><CostReceipt days={n} /></div>
        </Panel>
      </Reveal>

      <Reveal delay={0.05}>
        <Panel className="p-5 md:p-6" id="tokens">
          <PanelHeader title="Where your tokens went" hint="The tasks and prompt versions that use the most, split into the parts of each call. Prompt text is never shown here." />
          <div className="mt-4"><TokensWentBody days={n} limit={8} /></div>
        </Panel>
      </Reveal>

      <Reveal delay={0.1}>
        <Panel className="p-5 md:p-6" id="features">
          <PanelHeader
            title="Cost by your own feature labels"
            hint="Optional. Your app names a feature or workflow on each call, and we add up what each cost."
            actions={canExport && <ExportButton path={`/v1/insights/features/export.csv?days=${n}`} what={`the last ${n} days of cost by feature`} title={`Download the last ${n} days of cost by feature as a spreadsheet file (CSV)`}>Download (CSV)</ExportButton>}
          />
          <div className="mt-4"><FeatureCostsBody days={n} /></div>
        </Panel>
      </Reveal>

      <p className="text-sm text-dim" data-testid="costs-next">
        Looking ahead? <Link className="text-ink underline" to={p("/planner")}>Try numbers in the Cost planner</Link>. Not sure the data is complete?{" "}
        <Link className="text-ink underline" to={p("/coverage")}>Check Data coverage</Link>.
      </p>

      <EmptyState title="No dollar figure is a promise" hint="Costs use public list prices at the time of each call. Your provider's invoice is the authority: discounts, taxes, credits, other users of the same account and billing lag are not visible here." />
    </div>
  );
}
