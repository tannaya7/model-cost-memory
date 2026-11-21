import { apiFetch } from "../../../shared/api/apiFetch";
import type { News, NewsRefresh } from "../../../shared/api/types";

export interface NewsFilters {
  source?: string;
  /** Only stories naming a model the project uses. */
  mine?: boolean;
  /** Only stories naming this model (an alert's model). */
  model?: string;
  /** Only stories naming a model this job uses. */
  job?: string;
  /** ISO times bounding when the stories were published. */
  since?: string;
  until?: string;
  limit?: number;
}

export function fetchNews(filters: NewsFilters = {}): Promise<News> {
  const params = new URLSearchParams();
  if (filters.source) params.set("source", filters.source);
  if (filters.mine) params.set("mine", "true");
  if (filters.model) params.set("model", filters.model);
  if (filters.job) params.set("job", filters.job);
  if (filters.since) params.set("since", filters.since);
  if (filters.until) params.set("until", filters.until);
  if (filters.limit) params.set("limit", String(filters.limit));
  const query = params.toString();
  return apiFetch<News>(`/v1/news${query ? `?${query}` : ""}`);
}

export function refreshNews(): Promise<NewsRefresh> {
  return apiFetch<NewsRefresh>("/v1/news/refresh", { method: "POST" });
}
