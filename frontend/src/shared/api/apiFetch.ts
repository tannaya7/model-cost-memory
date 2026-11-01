const KEY_STORAGE = "mcm_api_key";
const PROJECT_STORAGE = "mcm_project_id";
// The mock server accepts this; against the real API only a key the user saved is sent.
const MOCK_KEY = import.meta.env.VITE_USE_MOCK === "true" ? "demo-key" : "";

function read(name: string): string {
  try {
    return localStorage.getItem(name) || "";
  } catch {
    return "";
  }
}

function write(name: string, value: string) {
  try {
    if (value) localStorage.setItem(name, value);
    else localStorage.removeItem(name);
  } catch {
    /* storage unavailable: ignore */
  }
}

/** A project key saved in Settings, or "" when the user works through sign-in instead. */
export function getApiKey(): string {
  return read(KEY_STORAGE) || MOCK_KEY;
}

export function hasApiKey(): boolean {
  return Boolean(read(KEY_STORAGE));
}

/** The signed-in user's chosen project, sent as X-Project-Id. */
export function getActiveProject(): string {
  return read(PROJECT_STORAGE);
}

export function setActiveProject(projectId: string) {
  write(PROJECT_STORAGE, projectId);
}

export function setApiKey(key: string) {
  write(KEY_STORAGE, key);
}

/** The machine-readable reason of a refusal (`detail.code`), e.g. "provider_key_required". */
export function errorCode(err: unknown): string | null {
  if (!(err instanceof ApiError)) return null;
  const detail = (err.body as { detail?: unknown } | null)?.detail;
  return detail && typeof detail === "object" && "code" in detail ? String((detail as { code: unknown }).code) : null;
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

/**
 * FastAPI sends `detail` as a string for HTTPException, but as a list of
 * `{loc, msg}` objects for a 422 validation error.
 */
function describeDetail(detail: unknown): string {
  if (Array.isArray(detail)) {
    return detail
      .map((d) => (d && typeof d === "object" && "msg" in d ? String((d as { msg: unknown }).msg) : String(d)))
      .map((msg) => msg.replace(/^Value error, /, ""))
      .join("; ");
  }
  if (detail && typeof detail === "object" && "message" in detail) {
    return String((detail as { message: unknown }).message);
  }
  return String(detail);
}

/** Relative paths only (e.g. "/v1/jobs"), so the app works from the same origin as the API. */
export async function apiFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  const key = getApiKey();
  if (key && !headers.has("X-API-Key")) {
    headers.set("X-API-Key", key);
  }
  const project = getActiveProject();
  if (project && !headers.has("X-Project-Id")) {
    headers.set("X-Project-Id", project);
  }
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
        ? describeDetail((body as { detail: unknown }).detail)
        : res.statusText;
    throw new ApiError(res.status, detail || `Request failed (${res.status})`, body);
  }

  if (typeof body === "string" && (body.trim().startsWith("<") || res.headers.get("content-type")?.includes("text/html"))) {
    throw new ApiError(500, "The server sent a web page instead of data. Check that the mock server or backend is running", body);
  }
  return body as T;
}
