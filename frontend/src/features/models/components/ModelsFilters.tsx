import { useSearchParams } from "react-router-dom";

const STATUS_OPTIONS = [
  { label: "All", value: "ALL" },
  { label: "Active", value: "ACTIVE" },
  { label: "Deprecated", value: "DEPRECATED" },
  { label: "Retired", value: "RETIRED" },
] as const;

export function ModelsFilters() {
  const [searchParams, setSearchParams] = useSearchParams();
  const currentStatus = (searchParams.get("status") || "ALL").toUpperCase();

  function handleStatusChange(status: string) {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      if (!status || status === "ALL") {
        next.delete("status");
      } else {
        next.set("status", status);
      }
      return next;
    });
  }

  return (
    <div className="flex flex-wrap items-center gap-2 mb-4">
      <span className="text-xs font-semibold uppercase tracking-wider text-dim mr-1">
        Status:
      </span>
      <div className="flex flex-wrap gap-1.5">
        {STATUS_OPTIONS.map((option) => {
          const isActive = currentStatus === option.value;
          return (
            <button
              key={option.value}
              type="button"
              onClick={() => handleStatusChange(option.value)}
              className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
                isActive
                  ? "bg-accent text-on-accent"
                  : "border border-rule bg-surface text-dim hover:bg-bg hover:text-ink"
              }`}
            >
              {option.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
