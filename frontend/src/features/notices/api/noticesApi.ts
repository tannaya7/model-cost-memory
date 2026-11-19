import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "../../../shared/api/apiFetch";
import type { components } from "../../../shared/api/generated";

/** What the providers' own pages say about the models this project uses. Information only. */
export type Notices = components["schemas"]["NoticesOut"];
export type Notice = components["schemas"]["NoticeOut"];
export type NoticeSource = components["schemas"]["NoticeSourceOut"];

/** True for a real answer (and not an empty list from a stubbed or older server). */
export function isNotices(value: unknown): value is Notices {
  return typeof value === "object" && value !== null && !Array.isArray(value) && Array.isArray((value as Notices).notices);
}

/** GET /v1/notices */
export function useNotices() {
  return useQuery({
    queryKey: ["notices"],
    queryFn: () => apiFetch<Notices>("/v1/notices"),
    staleTime: 5 * 60_000,
  });
}
