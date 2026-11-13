import { useQuery } from "@tanstack/react-query";
import { ApiError, apiFetch } from "../../shared/api/apiFetch";

export interface SystemHealth {
  api: "ok" | "down";
  scheduler: "ok" | "overdue" | "unknown";
  /** Overdue jobs: minutes since their last success, null if never. */
  overdue: Record<string, number | null>;
}

/** GET /healthz (API and database) and GET /healthz/scheduler (503 with the overdue jobs). */
export async function fetchHealth(): Promise<SystemHealth> {
  let api: SystemHealth["api"] = "ok";
  try {
    await apiFetch("/healthz");
  } catch {
    api = "down";
  }
  try {
    await apiFetch("/healthz/scheduler");
    return { api, scheduler: "ok", overdue: {} };
  } catch (err) {
    if (err instanceof ApiError && err.status === 503) {
      const body = err.body as { overdue?: Record<string, number | null> } | null;
      return { api, scheduler: "overdue", overdue: body?.overdue ?? {} };
    }
    return { api, scheduler: "unknown", overdue: {} };
  }
}

export function useHealth() {
  return useQuery({ queryKey: ["health"], queryFn: fetchHealth, refetchInterval: 60_000, retry: false });
}
