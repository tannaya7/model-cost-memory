import { useId, useState } from "react";
import { count, usd } from "../../../ui/format";
import { cx, Skeleton } from "../../../ui/primitives";
import { useCostReceipt } from "../api/costReceiptApi";
import { compare, parseInvoice, type Comparison, type CostReceipt as Receipt } from "../reconcile";

/** Exact cents for a receipt ($1,198.00, never rounded to whole dollars). Under a cent keeps the shared format, so a
 * tiny real cost never shows as "$0.00". */
const cents = new Intl.NumberFormat("en", { style: "currency", currency: "USD" });
const money = (n: number) => (n === 0 ? "$0.00" : Math.abs(n) < 0.01 ? usd(n) : cents.format(n).replace("-", "−"));
/** One correct answer often costs a fraction of a dollar, so under $1 it keeps four decimals ($0.0144, not $0.01). */
const unit = (n: number) => (n > 0 && n < 1 ? (n < 0.01 ? usd(n) : `$${n.toFixed(4)}`) : money(n));
/** "1 Jul 2026": a price's period needs the year. Days are UTC, like everything on the receipt. */
const day = (iso: string) => new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });

function Row({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-t border-rule py-1.5 first:border-t-0">
      <dt className="text-muted">{label}{hint && <span className="block text-[11px] text-muted/80">{hint}</span>}</dt>
      <dd className="shrink-0 font-semibold text-ink tabular">{value}</dd>
    </div>
  );
}

/** What the person typed against what was recorded. Held in this component's state only: never sent, never saved. */
function InvoiceCheck({ receipt }: { receipt: Receipt }) {
  const [text, setText] = useState("");
  const [result, setResult] = useState<Comparison | null>(null);
  const [error, setError] = useState<string | null>(null);
  const id = useId();

  const run = (e: React.FormEvent) => {
    e.preventDefault();
    const invoice = parseInvoice(text);
    if (invoice === null) {
      setResult(null);
      setError("Enter a plain US dollar amount, like 1,240.50. Currency codes, minus signs and text are not accepted.");
      return;
    }
    setError(null);
    setResult(compare(invoice, receipt));
  };

  return (
    <div className="border-t border-rule pt-3">
      <p className="text-sm font-semibold text-ink">Compare with an invoice</p>
      <p className="mt-0.5 text-xs text-muted">
        Type the total from your own invoice, for the same {receipt.period_days} days. It is compared here in your browser: it is not uploaded or saved, and we never read your provider account.
      </p>
      <form onSubmit={run} className="mt-2 flex flex-wrap items-start gap-2" noValidate>
        <label htmlFor={id} className="sr-only">Invoice total in US dollars</label>
        <span className="relative">
          <span aria-hidden className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted">$</span>
          <input
            id={id}
            inputMode="decimal"
            autoComplete="off"
            value={text}
            onChange={(e) => { setText(e.target.value); setError(null); }}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? `${id}-err` : undefined}
            placeholder="1,240.50"
            className="w-36 rounded-md border border-rule bg-surface-2 py-1.5 pl-6 pr-2 text-sm text-ink tabular"
          />
        </span>
        <button type="submit" className="rounded-md border border-rule bg-surface-2 px-3 py-1.5 text-sm font-medium text-ink hover:bg-surface-3">Compare</button>
      </form>
      {error && <p id={`${id}-err`} role="alert" className="mt-1.5 text-xs text-bad">{error}</p>}
      {result && (
        <div className="mt-3 flex flex-col gap-2 text-sm" aria-live="polite">
          <p className="text-ink">
            {result.verdict === "close"
              ? `The invoice (${money(result.invoice)}) is close to the recorded total (${money(result.recorded)}). Close is not a match: this check cannot prove the figures agree.`
              : result.verdict === "invoice_higher"
                ? `The invoice (${money(result.invoice)}) is ${money(result.difference)} higher than the recorded total (${money(result.recorded)}).`
                : `The invoice (${money(result.invoice)}) is ${money(-result.difference)} lower than the recorded total (${money(result.recorded)}).`}
          </p>
          <p className="text-xs font-semibold uppercase tracking-wide text-muted">Possible reasons for a difference</p>
          <ul className="flex flex-col gap-1.5 text-xs text-muted">
            {result.causes.map((c) => (
              <li key={c.id} className="flex gap-2">
                <span className={cx("mt-0.5 shrink-0 rounded-full px-1.5 text-[10px] font-semibold", c.applies === "yes" ? "bg-warn-soft text-warn" : "bg-surface-3 text-muted")}>
                  {c.applies === "yes" ? "In your data" : "Possible"}
                </span>
                <span>{c.text}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function Body({ r }: { r: Receipt }) {
  const cps = r.cost_per_success;
  return (
    <div className="flex flex-col gap-3 text-sm">
      <p className="text-xs text-muted">
        Last {r.period_days} days, counted in {r.timezone}. Amounts are in US dollars, at public list prices: an estimate from your recorded calls, not your invoice.
      </p>
      <dl>
        <Row label="AI calls" value={count(r.runs)} />
        <Row label="Passed their check" value={count(r.passed)} />
        <Row label="Failed their check" value={count(r.failed)} />
        <Row label="Not checked yet" value={count(r.unchecked)} />
        {r.excluded > 0 && <Row label="Left out of the checks" value={count(r.excluded)} hint="Archived, or the answer was marked invalid" />}
        <Row label="Spend (priced calls only)" value={money(r.spend_usd)} />
      </dl>
      {r.unpriced_note && <p className="rounded-md bg-surface-3 px-2.5 py-1.5 text-xs text-ink">{r.unpriced_note}. Their cost is unknown, not zero.</p>}

      <div>
        <p className="font-semibold text-ink">How each call was priced</p>
        <ul className="mt-1 flex flex-col gap-1 text-xs text-muted">
          {r.basis.map((b) => (
            <li key={b.status} className="flex justify-between gap-3">
              <span>{b.label}</span>
              <span className="shrink-0 font-semibold text-ink tabular">{count(b.runs)} · {b.spend_usd === null ? "cost unknown" : money(b.spend_usd)}</span>
            </li>
          ))}
        </ul>
      </div>

      <div>
        <p className="font-semibold text-ink">Cost of one correct answer</p>
        {cps && cps.value_usd !== null ? (
          <p className="mt-0.5 text-xs text-muted">
            <span className="font-semibold text-ink tabular">{unit(cps.value_usd)}</span> = {money(cps.spend_usd)} ÷ {count(cps.passed)} that passed, from {count(cps.checked_priced_runs)} checked, priced calls.
            {" "}Left out: {count(cps.unchecked_runs)} not checked, {count(cps.checked_unpriced_runs)} checked without a price. A correct answer means: {cps.success_definition.charAt(0).toLowerCase() + cps.success_definition.slice(1)}.
          </p>
        ) : (
          <p className="mt-0.5 text-xs text-muted">{cps?.reason ?? "Not enough checked calls yet."}</p>
        )}
      </div>

      <div>
        <p className="font-semibold text-ink">Spend on answers that failed their check</p>
        <p className="mt-0.5 text-xs text-muted"><span className="font-semibold text-ink tabular">{money(r.spend_on_failed_checks_usd)}</span>. A failed check can be a deliberate test, so this is not called wasted.</p>
      </div>

      <div>
        <p className="font-semibold text-ink">Prices used</p>
        {r.price_versions.length === 0 ? (
          <p className="mt-0.5 text-xs text-muted">No dated price is recorded for these calls (they were priced before price history existed).</p>
        ) : (
          <>
            <p className="mt-0.5 text-xs text-muted">
              {r.price_versions.length === 1 ? "1 price" : `${r.price_versions.length} prices`}, per million tokens
              {r.price_versions_checked_at ? `, last checked ${day(r.price_versions_checked_at)}` : ""}.
            </p>
            <ul className="mt-1 flex flex-col gap-1 text-xs text-muted">
              {r.price_versions.slice(0, 5).map((v) => (
                <li key={v.version_id} className="flex flex-wrap justify-between gap-x-3">
                  <span className="min-w-0 truncate"><span className="font-mono text-[11px] text-ink">{v.model}</span> · {v.provider} · in {money(v.input_per_mtok)} / out {money(v.output_per_mtok)}</span>
                  <span className="shrink-0">
                    from {day(v.effective_from)}{v.effective_to ? ` to ${day(v.effective_to)}` : ""} · {v.source_kind === "MANUAL" ? "entered by hand" : v.source_url ? <a className="underline" href={v.source_url} target="_blank" rel="noreferrer noopener">source</a> : "source not recorded"}
                  </span>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>

      <InvoiceCheck receipt={r} />
    </div>
  );
}

/** "How this is worked out": a closed-by-default panel under a spend figure. The receipt is fetched when it opens. */
export function CostReceipt({ days }: { days: number }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const { data, isPending, isError } = useCostReceipt({ days, enabled: open });
  return (
    <div>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((v) => !v)}
        className="text-xs font-medium text-accent underline-offset-2 hover:underline"
      >
        {open ? "Hide how this is worked out" : "How this is worked out"}
      </button>
      {open && (
        <div id={id} role="region" aria-label="How this cost is worked out" className="mt-2 rounded-lg border border-rule bg-surface-2 p-3">
          {isPending ? <Skeleton className="h-32" /> : isError || !data ? (
            <p className="text-xs text-bad" role="alert">Could not load the details. Try again in a moment.</p>
          ) : <Body r={data} />}
        </div>
      )}
    </div>
  );
}
