import { afterEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { mergeFlags, readLocal, useGuideFlags, writeLocal } from "./useGuideFlags";

afterEach(() => {
  localStorage.clear();
  vi.unstubAllGlobals();
});

const me = { user_id: "u1", email: "a@b.c", name: null, picture_url: null, ui_flags: {} as Record<string, boolean> };

function stub(failPatch: boolean, serverFlags: Record<string, boolean> = {}) {
  const calls: Array<{ method: string; body?: string }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init?: RequestInit) => {
      calls.push({ method: init?.method ?? "GET", body: init?.body as string | undefined });
      if (init?.method === "PATCH") {
        if (failPatch) throw new TypeError("network down");
        return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({ ...me, ui_flags: serverFlags }), { status: 200, headers: { "content-type": "application/json" } });
    }),
  );
  return calls;
}

function wrap() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

describe("guide flags storage", () => {
  it("keeps only the two known flags, only when true", () => {
    writeLocal("u1", { tour_seen: true });
    localStorage.setItem("mcm_guide_u2", JSON.stringify({ tour_seen: "yes", other: true, first_results_seen: true }));
    expect(readLocal("u1")).toEqual({ tour_seen: true });
    expect(readLocal("u2")).toEqual({ first_results_seen: true });
  });
  it("reads nothing when storage holds junk", () => {
    localStorage.setItem("mcm_guide_u1", "{not json");
    expect(readLocal("u1")).toEqual({});
  });
  it("merges the account's answer with this browser's", () => {
    expect(mergeFlags({ tour_seen: true }, { first_results_seen: true })).toEqual({ tour_seen: true, first_results_seen: true });
    expect(mergeFlags(null, {})).toEqual({});
  });
});

describe("useGuideFlags", () => {
  it("shows what the account already saw", async () => {
    stub(false, { tour_seen: true });
    const { result } = renderHook(() => useGuideFlags(), { wrapper: wrap() });
    await waitFor(() => expect(result.current.loaded).toBe(true));
    expect(result.current.flags.tour_seen).toBe(true);
  });
  it("saves to the account and to this browser", async () => {
    const calls = stub(false);
    const { result } = renderHook(() => useGuideFlags(), { wrapper: wrap() });
    await waitFor(() => expect(result.current.loaded).toBe(true));
    act(() => result.current.set("tour_seen", true));
    await waitFor(() => expect(result.current.flags.tour_seen).toBe(true));
    expect(calls.some((c) => c.method === "PATCH" && c.body === JSON.stringify({ tour_seen: true }))).toBe(true);
    expect(readLocal("u1").tour_seen).toBe(true);
  });
  it("still remembers in this browser when the server save fails", async () => {
    stub(true);
    const { result } = renderHook(() => useGuideFlags(), { wrapper: wrap() });
    await waitFor(() => expect(result.current.loaded).toBe(true));
    act(() => result.current.set("first_results_seen", true));
    await waitFor(() => expect(result.current.flags.first_results_seen).toBe(true));
    expect(readLocal("u1").first_results_seen).toBe(true);
  });
});
