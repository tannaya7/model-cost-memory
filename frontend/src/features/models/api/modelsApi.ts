import { apiFetch } from "../../../shared/api/apiFetch";
import type { ModelPage } from "../../../shared/api/types";

export interface FetchModelsParams {
  status?: string;
  used?: boolean;
  q?: string;
  limit?: number;
  cursor?: string;
}

export async function fetchModels(params: FetchModelsParams = {}): Promise<ModelPage> {
  const search = new URLSearchParams();
  if (params.status && params.status !== "ALL") search.set("status", params.status);
  if (params.used !== undefined) search.set("used", String(params.used));
  if (params.q) search.set("q", params.q);
  if (params.limit) search.set("limit", String(params.limit));
  if (params.cursor) search.set("cursor", params.cursor);

  const query = search.toString();
  return apiFetch<ModelPage>(query ? `/v1/models?${query}` : "/v1/models");
}
