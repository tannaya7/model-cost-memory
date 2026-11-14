import { IconInfo } from "../../../ui/icons";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2026-10-14" or a full timestamp as "14 Oct 2026"; anything unreadable is shown as it came. */
export function formatDay(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return iso;
  return `${Number(m[3])} ${MONTHS[Number(m[2]) - 1] ?? m[2]} ${m[1]}`;
}

export function SuggestionDisclaimer({ from, to }: { from: string; to: string }) {
  return (
    <p className="flex items-start gap-2 rounded-xl border border-rule bg-surface-2 p-3 text-xs leading-relaxed text-dim">
      <IconInfo size={15} className="mt-0.5 shrink-0 text-muted" />
      <span>
        A suggestion from your own recent calls only. It is not a benchmark. Test it on your own examples before you switch.
        <span className="mt-0.5 block text-muted">Period used: {formatDay(from)} to {formatDay(to)}.</span>
      </span>
    </p>
  );
}
