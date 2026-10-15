const KEY_STORAGE = "mcm_api_key";
const DEFAULT_KEY = "demo-key";

export function getApiKey(): string {
  try {
    return localStorage.getItem(KEY_STORAGE) || DEFAULT_KEY;
  } catch {
    return DEFAULT_KEY;
  }
}

export function setApiKey(key: string) {
  try {
    localStorage.setItem(KEY_STORAGE, key);
  } catch {
    /* storage unavailable: ignore */
  }
}

/** Thrown for any non-2xx response. */
export class ApiError extends Error {
  status: number;
  body: unknown;
  constructor(status: number, message: string, body: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.body = body;
  }
}

/** Relative paths only (e.g. "/v1/jobs"), so the app works from the same origin as the API. */
export async function apiFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set("X-API-Key", getApiKey());
  if (init.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  const res = await fetch(path, { ...init, headers, credentials: "same-origin" });

  const text = await res.text();
  let body: unknown = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }

  if (!res.ok) {
    const detail =
      body && typeof body === "object" && "detail" in body
        ? String((body as { detail: unknown }).detail)
        : res.statusText;
    throw new ApiError(res.status, detail || `Request failed (${res.status})`, body);
  }
  return body as T;
}
