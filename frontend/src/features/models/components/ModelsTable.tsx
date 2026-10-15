import type { Model } from "../../../shared/api/types";
import { Badge } from "../../../shared/components/Badge";
import { Table, type Column } from "../../../shared/components/Table";

function formatPrice(price: number | null | undefined): string {
  if (price === null || price === undefined) return "-";
  if (price === 0) return "Free";
  return `$${price.toFixed(2)} / 1M tokens`;
}

function formatShutdownDate(dateStr: string | null | undefined): string {
  if (!dateStr) return "-";
  try {
    const d = new Date(dateStr);
    return d.toLocaleDateString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
      // shutdown_date is a plain date (no time); read it as UTC so it never shifts by a day
      timeZone: "UTC",
    });
  } catch {
    return dateStr;
  }
}

const columns: Column<Model>[] = [
  {
    key: "provider",
    header: "Provider",
    render: (m) => <span className="font-semibold text-ink">{m.provider}</span>,
  },
  {
    key: "model",
    header: "Model",
    render: (m) => (
      <div>
        <div className="font-medium text-ink">{m.model}</div>
        {m.model_version && m.model_version !== m.model && (
          <div className="font-mono text-xs text-dim">{m.model_version}</div>
        )}
      </div>
    ),
  },
  {
    key: "status",
    header: "Status",
    render: (m) => {
      const tone =
        m.status === "ACTIVE"
          ? "ok"
          : m.status === "DEPRECATED"
          ? "warn"
          : "neutral";
      return <Badge tone={tone}>{m.status}</Badge>;
    },
  },
  {
    key: "shutdown_date",
    header: "Shutdown date",
    render: (m) => (
      <span className="font-mono text-xs text-dim">
        {formatShutdownDate(m.shutdown_date)}
      </span>
    ),
  },
  {
    key: "price_in",
    header: "Input price",
    render: (m) => (
      <span className="font-mono text-xs text-ink">
        {formatPrice(m.price_in_per_mtok)}
      </span>
    ),
  },
  {
    key: "price_out",
    header: "Output price",
    render: (m) => (
      <span className="font-mono text-xs text-ink">
        {formatPrice(m.price_out_per_mtok)}
      </span>
    ),
  },
  {
    key: "source",
    header: "Source",
    render: (m) =>
      m.source === "MANUAL" ? (
        <Badge tone="neutral">Manual</Badge>
      ) : null,
  },
];

export function ModelsTable({
  models,
  hasNextPage,
  isFetchingNextPage,
  fetchNextPage,
}: {
  models: Model[];
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  fetchNextPage: () => void;
}) {
  return (
    <div className="space-y-4">
      <Table
        columns={columns}
        rows={models}
        rowKey={(m) => `${m.provider}_${m.model}_${m.model_version}`}
      />

      {hasNextPage && (
        <button
          type="button"
          onClick={fetchNextPage}
          disabled={isFetchingNextPage}
          className="w-full rounded-md border border-rule bg-surface py-2.5 text-sm font-semibold text-accent hover:bg-bg disabled:cursor-not-allowed disabled:opacity-50 transition-colors"
        >
          {isFetchingNextPage ? "Loading more models..." : "Load more"}
        </button>
      )}
    </div>
  );
}
