import { useState, useEffect } from "react";
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
  const currentUsed = searchParams.get("used") === "true";
  const urlQ = searchParams.get("q") || "";

  const [queryInput, setQueryInput] = useState(urlQ);

  // Sync internal state if URL param changes externally
  useEffect(() => {
    setQueryInput(urlQ);
  }, [urlQ]);

  // Debounce search query by 300 ms
  useEffect(() => {
    const timer = setTimeout(() => {
      setSearchParams((prev) => {
        const next = new URLSearchParams(prev);
        const trimmed = queryInput.trim();
        if (trimmed) {
          if (next.get("q") !== trimmed) {
            next.set("q", trimmed);
          }
        } else {
          next.delete("q");
        }
        return next;
      });
    }, 300);

    return () => clearTimeout(timer);
  }, [queryInput, setSearchParams]);

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

  function handleUsedChange(checked: boolean) {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      if (checked) {
        next.set("used", "true");
      } else {
        next.delete("used");
      }
      return next;
    });
  }

  function handleClearFilters() {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.delete("status");
      next.delete("used");
      next.delete("q");
      return next;
    });
    setQueryInput("");
  }

  const hasActiveFilters = currentStatus !== "ALL" || currentUsed || Boolean(urlQ);

  return (
    <div className="flex flex-wrap items-center justify-between gap-4 rounded-card border border-rule bg-surface p-3 mb-4">
      <div className="flex flex-wrap items-center gap-4">
        {/* Search Box */}
        <div className="relative min-w-[220px]">
          <input
            type="text"
            placeholder="Search model name..."
            value={queryInput}
            onChange={(e) => setQueryInput(e.target.value)}
            className="w-full min-h-[40px] rounded-md border border-rule bg-surface px-3 py-2 text-sm text-ink placeholder:text-dim focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
          />
        </div>

        {/* Status Filter Tabs */}
        <div className="flex items-center gap-1.5">
          <span className="text-xs font-semibold uppercase tracking-wider text-dim mr-1">
            Status:
          </span>
          <div className="flex flex-wrap gap-1">
            {STATUS_OPTIONS.map((option) => {
              const isActive = currentStatus === option.value;
              return (
                <button
                  key={option.value}
                  type="button"
                  onClick={() => handleStatusChange(option.value)}
                  className={`min-h-[40px] inline-flex items-center rounded-md px-3 py-2 text-xs font-medium transition-colors ${
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

        {/* "Only models I use" checkbox */}
        <label className="min-h-[40px] flex items-center gap-2 cursor-pointer select-none text-xs font-medium text-ink">
          <input
            type="checkbox"
            checked={currentUsed}
            onChange={(e) => handleUsedChange(e.target.checked)}
            className="h-4 w-4 rounded border-rule text-accent focus:ring-accent"
          />
          <span>Only models I use</span>
        </label>
      </div>

      {hasActiveFilters && (
        <button
          type="button"
          onClick={handleClearFilters}
          className="text-xs font-semibold text-dim hover:text-ink"
        >
          Clear filters
        </button>
      )}
    </div>
  );
}
