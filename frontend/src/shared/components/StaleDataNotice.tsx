/**
 * Shown when a background refresh fails but data from the last successful load is still on screen.
 * Keeps the page usable instead of replacing good data with a full error box.
 */
export function StaleDataNotice({ onRetry }: { onRetry: () => void }) {
  return (
    <div
      role="status"
      className="mb-4 flex flex-wrap items-center justify-between gap-2 rounded-md border border-rule bg-surface px-3 py-2 text-xs text-dim"
    >
      <span>Could not refresh just now. Showing the last loaded data.</span>
      <button onClick={onRetry} className="font-semibold text-accent hover:underline">
        Try again
      </button>
    </div>
  );
}
