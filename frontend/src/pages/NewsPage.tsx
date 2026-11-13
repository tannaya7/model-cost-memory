import { useState } from "react";
import { QueryState } from "../shared/components/QueryState";
import { Skeleton } from "../shared/components/Skeleton";
import { ApiError } from "../shared/api/apiFetch";
import { NewsCard, timeAgo } from "../features/news/components/NewsCard";
import { useNews, useRefreshNews } from "../features/news/hooks/useNews";

function NewsSkeleton() {
  return (
    <div className="grid gap-4 md:grid-cols-2" role="status" aria-label="Loading news">
      <Skeleton className="h-44 md:col-span-2" />
      {Array.from({ length: 4 }, (_, i) => (
        <Skeleton key={i} className="h-36" />
      ))}
    </div>
  );
}

function Chip({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={[
        "rounded-full border px-3 py-1 text-xs font-semibold transition-colors",
        active
          ? "border-accent bg-accent text-on-accent"
          : "border-rule bg-surface text-dim hover:border-dim/50 hover:text-ink",
      ].join(" ")}
    >
      {children}
    </button>
  );
}

export default function NewsPage() {
  const [source, setSource] = useState<string | undefined>();
  const [mine, setMine] = useState(false);
  const query = useNews({ source, mine });
  const refresh = useRefreshNews();
  const news = query.data;

  let refreshNote: string | null = null;
  if (refresh.isError) {
    refreshNote = refresh.error instanceof ApiError ? refresh.error.message : "Could not refresh the news";
  } else if (refresh.data) {
    const r = refresh.data;
    if (!r.refreshed && r.failed_sources.length === 0 && r.next_refresh_at) {
      refreshNote = `Fetched moments ago. Next fetch from ${new Date(r.next_refresh_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}.`;
    } else if (!r.refreshed) {
      refreshNote = "No feed could be reached. Showing the stories already fetched.";
    } else {
      refreshNote = r.added === 0 ? "Up to date: no new stories." : `${r.added} new ${r.added === 1 ? "story" : "stories"}.`;
      if (r.failed_sources.length) refreshNote += ` Not reached: ${r.failed_sources.join(", ")}.`;
    }
  }

  return (
    <div className="space-y-6">
      {/* Masthead */}
      <header className="relative overflow-hidden rounded-card border border-rule bg-surface p-6 md:p-8">
        <div aria-hidden className="pointer-events-none absolute -right-16 -top-24 h-64 w-64 rounded-full bg-accent/15 blur-3xl" />
        <div className="relative flex flex-wrap items-end justify-between gap-4">
          <div className="min-w-0">
            <p className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.18em] text-dim">
              <span className="relative flex h-2 w-2" aria-hidden>
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-ok opacity-60 motion-reduce:animate-none" />
                <span className="relative inline-flex h-2 w-2 rounded-full bg-ok" />
              </span>
              {news?.updated_at ? `Updated ${timeAgo(news.updated_at)}` : "Not fetched yet"}
            </p>
            <h1 className="mt-2 text-3xl font-extrabold tracking-tight md:text-4xl">AI news</h1>
            <p className="mt-1 max-w-xl text-sm text-dim">
              What changed this week at the model makers, in the press and in the community, with the stories that
              name a model you run marked.
            </p>
          </div>
          <button
            type="button"
            onClick={() => refresh.mutate()}
            disabled={refresh.isPending}
            className="inline-flex items-center gap-2 rounded-md bg-accent px-4 py-2 text-sm font-semibold text-on-accent shadow-sm transition-opacity hover:opacity-90 disabled:opacity-60"
          >
            <svg
              aria-hidden
              viewBox="0 0 20 20"
              className={`h-4 w-4 ${refresh.isPending ? "animate-spin motion-reduce:animate-none" : ""}`}
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
            >
              <path d="M16.5 10a6.5 6.5 0 1 1-1.9-4.6M16.5 3.5v3h-3" />
            </svg>
            {refresh.isPending ? "Fetching…" : "Fetch latest"}
          </button>
        </div>
        {refreshNote && (
          <p role="status" className="relative mt-4 text-xs text-dim">
            {refreshNote}
          </p>
        )}
        {news && news.your_models.length > 0 && (
          <div className="relative mt-5 flex flex-wrap items-center gap-2 border-t border-rule pt-4 text-xs">
            <span className="font-semibold text-dim">Watching for</span>
            {news.your_models.map((model) => (
              <span key={model} className="rounded-full bg-accent-soft px-2 py-0.5 font-mono text-accent">
                {model}
              </span>
            ))}
          </div>
        )}
      </header>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Filter the news">
        <Chip active={!mine} onClick={() => setMine(false)}>
          All stories
        </Chip>
        <Chip active={mine} onClick={() => setMine(true)}>
          Affects my models
        </Chip>
        <span aria-hidden className="mx-1 h-5 w-px bg-rule" />
        <Chip active={source === undefined} onClick={() => setSource(undefined)}>
          Every source
        </Chip>
        {news?.sources.map((s) => (
          <Chip key={s.source} active={source === s.source} onClick={() => setSource(s.source)}>
            {s.source}
          </Chip>
        ))}
      </div>

      <QueryState
        query={query}
        skeleton={<NewsSkeleton />}
        isEmpty={(data) => data.items.length === 0}
        emptyTitle={mine ? "No recent story names a model you run" : "No stories yet"}
        emptyHint={
          mine
            ? "That is good news. Switch to All stories to see everything."
            : "Press Fetch latest to load the news. It also refreshes by itself every hour."
        }
      >
        {(data) => (
          <div className="grid gap-4 md:grid-cols-2">
            {data.items.map((item, index) => (
              <NewsCard key={item.item_id} item={item} index={index} featured={index === 0} />
            ))}
          </div>
        )}
      </QueryState>
    </div>
  );
}
