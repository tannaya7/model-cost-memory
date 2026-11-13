import { Link } from "react-router-dom";
import type { NewsFilters } from "../api/newsApi";
import { useNews } from "../hooks/useNews";
import { timeAgo } from "./NewsCard";

const KIND_DOT = { lab: "bg-accent", press: "bg-warn", community: "bg-ok" } as const;

/**
 * A short "In the news" list about particular models: an alert's model, a job's models, or the project's.
 * It stays out of the way: nothing at all while loading, on an error, or when no story matches, unless
 * `emptyText` asks for a line saying so (the job page, where the section always exists).
 */
export function RelatedNews({
  filters,
  title = "In the news",
  limit = 3,
  emptyText,
  allLink = true,
}: {
  filters: NewsFilters;
  title?: string;
  limit?: number;
  emptyText?: string;
  allLink?: boolean;
}) {
  const query = useNews({ ...filters, limit });
  const items = query.data?.items ?? [];

  if (items.length === 0) {
    if (!emptyText || query.isPending || query.isError) return null;
    return <p className="text-xs text-dim">{emptyText}</p>;
  }

  return (
    <div className="space-y-2" aria-label={title}>
      <div className="flex items-baseline justify-between gap-2">
        <h4 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-dim">{title}</h4>
        {allLink && (
          <Link to="/news" className="text-xs font-semibold text-accent hover:underline">
            All AI news →
          </Link>
        )}
      </div>
      <ul className="divide-y divide-rule overflow-hidden rounded-md border border-rule bg-bg">
        {items.map((item) => (
          <li key={item.item_id} className="flex min-w-0 items-start gap-3 px-3 py-2.5">
            <span aria-hidden className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${KIND_DOT[item.kind]}`} />
            <div className="min-w-0 flex-1">
              <a
                href={item.link}
                target="_blank"
                rel="noopener noreferrer"
                className="block text-sm font-semibold leading-snug text-ink hover:text-accent"
              >
                {item.title}
              </a>
              <p className="mt-0.5 text-xs text-dim">
                {item.source} · <time dateTime={item.published_at}>{timeAgo(item.published_at)}</time>
                {item.affects.length > 0 && (
                  <span className="font-mono text-accent"> · {item.affects.join(", ")}</span>
                )}
              </p>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
