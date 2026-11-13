import { motion } from "framer-motion";
import type { NewsItem } from "../../../shared/api/types";

const KIND_LABEL: Record<NewsItem["kind"], string> = {
  lab: "Model maker",
  press: "Press",
  community: "Community",
};

const KIND_DOT: Record<NewsItem["kind"], string> = {
  lab: "bg-accent",
  press: "bg-warn",
  community: "bg-ok",
};

/** "just now", "35 min ago", "5 h ago", "3 d ago", or a date for anything older than a week. */
export function timeAgo(iso: string, now: Date = new Date()): string {
  const minutes = Math.max(0, Math.round((now.getTime() - new Date(iso).getTime()) / 60_000));
  if (minutes < 2) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  if (days <= 7) return `${days} d ago`;
  return new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

/** One story. A story that names a model the project uses is marked with an accent stripe. */
export function NewsCard({ item, index = 0, featured = false }: { item: NewsItem; index?: number; featured?: boolean }) {
  const affects = item.affects.length > 0;
  return (
    <motion.article
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.28, delay: Math.min(index, 10) * 0.035, ease: "easeOut" }}
      className={[
        "group relative flex min-w-0 flex-col gap-3 overflow-hidden rounded-card border bg-surface p-5 transition-colors",
        affects ? "border-accent/50" : "border-rule hover:border-dim/40",
        featured ? "md:col-span-2 md:p-7" : "",
      ].join(" ")}
    >
      {affects && <span aria-hidden className="absolute inset-y-0 left-0 w-1 bg-accent" />}

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-dim">
        <span className="inline-flex items-center gap-1.5 font-semibold text-ink">
          <span aria-hidden className={`h-2 w-2 rounded-full ${KIND_DOT[item.kind]}`} />
          {item.source}
        </span>
        <span>{KIND_LABEL[item.kind]}</span>
        <time dateTime={item.published_at} className="ml-auto font-mono tabular-nums">
          {timeAgo(item.published_at)}
        </time>
      </div>

      <h3 className={`font-bold leading-snug tracking-tight text-ink ${featured ? "text-2xl" : "text-base"}`}>
        <a
          href={item.link}
          target="_blank"
          rel="noopener noreferrer"
          className="outline-none after:absolute after:inset-0 after:content-[''] hover:text-accent focus-visible:text-accent"
        >
          {item.title}
        </a>
      </h3>

      {item.summary && (
        <p className={`text-sm text-dim ${featured ? "line-clamp-4 max-w-3xl" : "line-clamp-3"}`}>{item.summary}</p>
      )}

      {affects && (
        <p className="relative mt-auto flex flex-wrap items-center gap-1.5 text-xs font-semibold text-accent">
          Affects your models:
          {item.affects.map((model) => (
            <span key={model} className="rounded-full bg-accent-soft px-2 py-0.5 font-mono font-medium">
              {model}
            </span>
          ))}
        </p>
      )}
    </motion.article>
  );
}
