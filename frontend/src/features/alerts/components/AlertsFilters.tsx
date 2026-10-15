import { useSearchParams } from "react-router-dom";

export type AlertStateFilter = "open" | "resolved" | "all";

interface AlertsFiltersProps {
  counts?: {
    open: number;
    resolved: number;
    all: number;
  };
}

export function AlertsFilters({ counts }: AlertsFiltersProps) {
  const [searchParams, setSearchParams] = useSearchParams();
  const currentState = (searchParams.get("state") || "open").toLowerCase();

  const handleFilterClick = (state: AlertStateFilter) => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.set("state", state);
      return next;
    });
  };

  const filters: Array<{ label: string; value: AlertStateFilter; count?: number }> = [
    { label: "Open", value: "open", count: counts?.open },
    { label: "Resolved", value: "resolved", count: counts?.resolved },
    { label: "All", value: "all", count: counts?.all },
  ];

  return (
    <div
      role="toolbar"
      aria-label="Filter alerts by status"
      className="flex flex-wrap items-center gap-2 mb-6"
    >
      {filters.map((f) => {
        const isActive = currentState === f.value;
        return (
          <button
            key={f.value}
            type="button"
            aria-pressed={isActive}
            onClick={() => handleFilterClick(f.value)}
            className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors cursor-pointer focus:outline-none focus:ring-2 focus:ring-accent ${
              isActive
                ? "bg-accent-soft font-semibold text-accent"
                : "border border-rule bg-surface text-dim hover:bg-bg hover:text-ink"
            }`}
          >
            {f.label}
            {f.count !== undefined && (
              <span className="ml-1.5 font-mono text-[11px] opacity-80">
                ({f.count})
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
