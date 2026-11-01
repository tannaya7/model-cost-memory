import type { Model } from "../../../shared/api/types";
import { Badge } from "../../../shared/components/Badge";
import { Table, type Column } from "../../../shared/components/Table";

export function getShutdownDaysDiff(dateStr: string): number {
  const parts = dateStr.split("-").map(Number);
  const targetUtc = Date.UTC(parts[0], parts[1] - 1, parts[2]);

  const now = new Date();
  const todayUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());

  const msPerDay = 24 * 60 * 60 * 1000;
  return Math.round((targetUtc - todayUtc) / msPerDay);
}

export function formatShutdownCountdown(dateStr: string): { text: string; isUrgent: boolean } {
  const diff = getShutdownDaysDiff(dateStr);
  const isUrgent = diff <= 30;

  if (diff > 1) {
    return { text: `Shuts down in ${diff} days`, isUrgent };
  }
  if (diff === 1) {
    return { text: "Shuts down in 1 day", isUrgent };
  }
  if (diff === 0) {
    return { text: "Shuts down today", isUrgent };
  }
  if (diff === -1) {
    return { text: "Shut down 1 day ago", isUrgent: true };
  }
  return { text: `Shut down ${Math.abs(diff)} days ago`, isUrgent: true };
}

export function formatShutdownDate(dateStr: string | null | undefined): string {
  if (!dateStr) return "-";
  try {
    const parts = dateStr.split("-").map(Number);
    const d = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2]));
    return d.toLocaleDateString(undefined, {
      timeZone: "UTC",
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  } catch {
    return dateStr;
  }
}

function formatPrice(price: number | null | undefined): string {
  if (price === null || price === undefined) return "-";
  if (price === 0) return "Free";
  return `$${price.toFixed(2)} / 1M tokens`;
}

function getRowClassName(m: Model): string {
  if (m.status === "DEPRECATED") {
    if (m.shutdown_date) {
      const { isUrgent } = formatShutdownCountdown(m.shutdown_date);
      return isUrgent ? "bg-bad-soft" : "bg-warn-soft";
    }
    return "bg-warn-soft";
  }
  if (m.status === "RETIRED") {
    return "text-dim opacity-75";
  }
  return "";
}

function getRowTitle(m: Model): string | undefined {
  if (m.status === "RETIRED") {
    return "Retired models are never recommended";
  }
  return undefined;
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
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="font-medium text-ink">{m.model}</span>
          {m.used_by_project && <Badge tone="accent">In use</Badge>}
        </div>
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
      return (
        <span title={m.status === "RETIRED" ? "Retired models are never recommended" : undefined}>
          <Badge tone={tone}>{m.status}</Badge>
        </span>
      );
    },
  },
  {
    key: "shutdown_date",
    header: "Shutdown date",
    render: (m) => {
      if (!m.shutdown_date) return <span className="font-mono text-xs text-dim">-</span>;

      const formatted = formatShutdownDate(m.shutdown_date);

      if (m.status === "DEPRECATED") {
        const { text, isUrgent } = formatShutdownCountdown(m.shutdown_date);
        return (
          <div className="space-y-0.5">
            <div className="font-mono text-xs text-ink">{formatted}</div>
            <div
              className={`font-mono text-xs font-semibold ${
                isUrgent ? "text-bad" : "text-warn"
              }`}
            >
              {text}
            </div>
          </div>
        );
      }

      return <span className="font-mono text-xs text-dim">{formatted}</span>;
    },
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
        rowClassName={getRowClassName}
        rowTitle={getRowTitle}
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
