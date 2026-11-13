import { vi } from "vitest";

/** A fetch stand-in that answers by path prefix (longest match wins) and records every call.
 * Paths with no answer get an empty list, which every list endpoint accepts. */
export function stubApi(routes: Record<string, unknown>) {
  const calls: string[] = [];
  const prefixes = Object.keys(routes).sort((a, b) => b.length - a.length);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push(`${init?.method ?? "GET"} ${url}`);
      const match = prefixes.find((p) => url.startsWith(p));
      const body = match ? routes[match] : [];
      if (body instanceof Response) return body;
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    }),
  );
  return calls;
}
