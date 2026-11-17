import { cx } from "../../../ui/primitives";
import type { BillingMode } from "../hooks/useBillingMode";

export const BILLING_OPTIONS: { value: BillingMode; title: string; example: string }[] = [
  { value: "per_use", title: "Pay per use", example: "Each call costs money, for example the Claude, OpenAI or Gemini API." },
  { value: "subscription", title: "Monthly subscription", example: "A flat monthly fee with a usage allowance that resets, for example Claude Pro or Max, ChatGPT Plus, Copilot, Cursor." },
  { value: "both", title: "Both", example: "Some of your AI is paid per use and some is covered by a subscription." },
];

/** "How do you pay for AI?" as three plain choices, each with one example. Used when making a project and in Settings. */
export function BillingChoice({ value, onChange, disabled, name = "billing-mode" }: { value: BillingMode; onChange: (v: BillingMode) => void; disabled?: boolean; name?: string }) {
  return (
    <div role="radiogroup" aria-label="How do you pay for AI?" className="flex flex-col gap-2">
      {BILLING_OPTIONS.map((o) => (
        <label
          key={o.value}
          className={cx(
            "flex cursor-pointer items-start gap-3 rounded-[10px] border p-3 transition-colors",
            value === o.value ? "border-accent bg-surface-2" : "border-rule hover:border-muted",
            disabled && "cursor-not-allowed opacity-70",
          )}
        >
          <input type="radio" name={name} value={o.value} checked={value === o.value} disabled={disabled} onChange={() => onChange(o.value)} className="mt-1 h-4 w-4 accent-[var(--color-accent)]" />
          <span className="min-w-0">
            <span className="block text-sm font-semibold text-ink">{o.title}</span>
            <span className="block text-[13px] text-dim">{o.example}</span>
          </span>
        </label>
      ))}
    </div>
  );
}
