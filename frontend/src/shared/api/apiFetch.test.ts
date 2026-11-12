import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, apiFetch, setActiveProject, setApiKey } from "./apiFetch";

afterEach(() => {
  vi.unstubAllGlobals();
});

function respond(status: number, body: string, contentType = "application/json") {
  const fetch = vi.fn(async () => new Response(body || null, { status, headers: { "content-type": contentType } }));
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

describe("apiFetch", () => {
  it("sends the saved project key and the active project", async () => {
    const fetch = respond(200, "[]");
    setApiKey("mcm_live_abc");
    setActiveProject("acme-1234");
    await apiFetch("/v1/jobs");
    const headers = new Headers((fetch.mock.calls[0] as unknown as [string, RequestInit])[1].headers);
    expect(headers.get("X-API-Key")).toBe("mcm_live_abc");
    expect(headers.get("X-Project-Id")).toBe("acme-1234");
  });

  it("returns null for an empty 204 answer", async () => {
    respond(204, "");
    await expect(apiFetch("/v1/provider-key", { method: "DELETE" })).resolves.toBeNull();
  });

  it("turns a validation error list into one readable message", async () => {
    respond(422, JSON.stringify({
      detail: [
        { loc: ["body", "name"], msg: "Value error, name is required" },
        { loc: ["body", "cap"], msg: "Input should be at most 500" },
      ],
    }));
    await expect(apiFetch("/v1/jobs", { method: "POST", body: "{}" })).rejects.toMatchObject({
      status: 422,
      message: "name is required; Input should be at most 500",
    });
  });

  it("refuses an HTML page where data was expected", async () => {
    respond(200, "<!doctype html><html></html>", "text/html");
    const err = await apiFetch("/v1/jobs").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).message).toMatch(/web page instead of data/);
  });
});
