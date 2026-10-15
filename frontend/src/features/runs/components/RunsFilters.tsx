import { useSearchParams } from "react-router-dom";
import { useJobs } from "../../jobs/hooks/useJobs";

export function RunsFilters() {
  const [searchParams, setSearchParams] = useSearchParams();
  const { data: jobs } = useJobs();

  const currentJob = searchParams.get("job") || "";
  const currentModel = searchParams.get("model") || "";
  const currentOutcome = searchParams.get("outcome") || "ALL";

  function setFilter(key: string, value: string) {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      if (!value || value === "ALL") {
        next.delete(key);
      } else {
        next.set(key, value);
      }
      return next;
    });
  }

  return (
    <div className="flex flex-wrap items-center gap-3 rounded-card border border-rule bg-surface p-3 mb-4">
      {/* Job Filter */}
      <div className="flex items-center gap-2">
        <label htmlFor="job-filter" className="text-xs font-semibold uppercase tracking-wider text-dim">
          Job
        </label>
        <select
          id="job-filter"
          value={currentJob}
          onChange={(e) => setFilter("job", e.target.value)}
          className="rounded-md border border-rule bg-surface px-2.5 py-1.5 text-sm text-ink focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
        >
          <option value="">All jobs</option>
          {jobs?.map((j) => (
            <option key={j.job_id} value={j.name}>
              {j.name}
            </option>
          ))}
        </select>
      </div>

      {/* Model Filter */}
      <div className="flex items-center gap-2">
        <label htmlFor="model-filter" className="text-xs font-semibold uppercase tracking-wider text-dim">
          Model
        </label>
        <input
          id="model-filter"
          type="text"
          placeholder="Filter by model..."
          value={currentModel}
          onChange={(e) => setFilter("model", e.target.value)}
          className="rounded-md border border-rule bg-surface px-2.5 py-1.5 text-sm text-ink placeholder:text-dim focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
        />
      </div>

      {/* Outcome Filter */}
      <div className="flex items-center gap-2">
        <label htmlFor="outcome-filter" className="text-xs font-semibold uppercase tracking-wider text-dim">
          Outcome
        </label>
        <select
          id="outcome-filter"
          value={currentOutcome}
          onChange={(e) => setFilter("outcome", e.target.value)}
          className="rounded-md border border-rule bg-surface px-2.5 py-1.5 text-sm text-ink focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
        >
          <option value="ALL">All</option>
          <option value="PASS">PASS</option>
          <option value="FAIL">FAIL</option>
          <option value="UNKNOWN">UNKNOWN</option>
        </select>
      </div>

      {(currentJob || currentModel || currentOutcome !== "ALL") && (
        <button
          type="button"
          onClick={() => {
            setSearchParams((prev) => {
              const next = new URLSearchParams(prev);
              next.delete("job");
              next.delete("model");
              next.delete("outcome");
              return next;
            });
          }}
          className="text-xs font-semibold text-dim hover:text-ink ml-auto"
        >
          Clear filters
        </button>
      )}
    </div>
  );
}
