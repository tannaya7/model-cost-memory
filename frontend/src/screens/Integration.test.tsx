/** Every backend option the web app relies on is actually sent, and the edge cases land somewhere sensible. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { stubApi } from "../test/api";
import { renderWithProviders } from "../test/render";
import { WithProject } from "../app/project";
import { fetchHealth } from "../features/health/api";
import { onSignedOut } from "../shared/api/queryClient";
import { ApiError } from "../shared/api/apiFetch";
import type { Recommendation } from "../shared/api/types";
import recSample from "../mocks/recommendation.sample.json";
import Jobs from "./Jobs";
import { RunsTab } from "./job/Tabs";

afterEach(() => {
  vi.unstubAllGlobals();
});

const rec = recSample as unknown as Recommendation;
const emptyPage = { items: [], next_cursor: null };

describe("runs of a job", () => {
  it("asks for the runs one verdict rests on when opened from its history", async () => {
    const calls = stubApi({ "/v1/runs": emptyPage });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={["/p/acme/jobs/invoice-extract?tab=runs&recommendation=rec-42"]}>
          <WithProject id="acme"><RunsTab job="invoice-extract" rec={rec} /></WithProject>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    expect(await screen.findByText(/only the runs one verdict rests on/)).toBeInTheDocument();
    await vi.waitFor(() => expect(calls.some((c) => c.includes("/v1/runs?") && c.includes("recommendation=rec-42") && c.includes("job=invoice-extract"))).toBe(true));
  });

  it("filters by model and outcome", async () => {
    const calls = stubApi({ "/v1/runs": emptyPage });
    renderWithProviders(<WithProject id="acme"><RunsTab job="invoice-extract" rec={rec} /></WithProject>);
    const user = userEvent.setup();
    await user.selectOptions(await screen.findByRole("combobox", { name: "Model" }), "acme-mini");
    await user.click(screen.getByRole("tab", { name: "Failed" }));
    await vi.waitFor(() => expect(calls.some((c) => c.includes("model=acme-mini") && c.includes("outcome=FAIL"))).toBe(true));
  });
});

describe("jobs list", () => {
  it("asks for spend over the period chosen", async () => {
    const calls = stubApi({ "/v1/jobs": [] });
    renderWithProviders(<WithProject id="acme"><Jobs /></WithProject>);
    expect(calls).toContain("GET /v1/insights/spend?days=30");
    await userEvent.setup().click(await screen.findByRole("tab", { name: "7 d" }));
    await vi.waitFor(() => expect(calls).toContain("GET /v1/insights/spend?days=7"));
    expect(calls).toContain("GET /v1/insights/daily?days=7");
  });
});

describe("system status", () => {
  it("reads overdue background jobs from the scheduler check's 503", async () => {
    stubApi({
      "/healthz/scheduler": new Response(JSON.stringify({ status: "overdue", overdue: { decay: 190.5, "catalog-sync": null } }), { status: 503 }),
      "/healthz": { status: "ok" },
    });
    expect(await fetchHealth()).toEqual({ api: "ok", scheduler: "overdue", overdue: { decay: 190.5, "catalog-sync": null } });
  });

  it("says when the API itself does not answer", async () => {
    stubApi({ "/healthz": new Response("", { status: 502 }), "/healthz/scheduler": new Response("", { status: 502 }) });
    expect(await fetchHealth()).toMatchObject({ api: "down", scheduler: "unknown" });
  });
});

describe("an ended session", () => {
  function where(path: string) {
    const [pathname, search = ""] = path.split("?");
    return { pathname, search: search ? `?${search}` : "", assign: vi.fn() } as unknown as Location;
  }
  const expired = new ApiError(401, "Sign in first", null);

  it("sends a signed-in page to sign in, and back afterwards", () => {
    const loc = where("/p/acme/jobs?tab=runs");
    onSignedOut(expired, loc);
    expect(loc.assign).toHaveBeenCalledWith(`/signin?next=${encodeURIComponent("/p/acme/jobs?tab=runs")}`);
  });

  it("asks for the key again when a saved project key stops working", () => {
    const loc = where("/p/key/models");
    onSignedOut(expired, loc);
    expect(loc.assign).toHaveBeenCalledWith("/key");
  });

  it("leaves the public pages and other errors alone", () => {
    for (const path of ["/", "/signin", "/p/demo/jobs"]) {
      const loc = where(path);
      onSignedOut(expired, loc);
      expect(loc.assign).not.toHaveBeenCalled();
    }
    const loc = where("/p/acme");
    onSignedOut(new ApiError(404, "Not found", null), loc);
    expect(loc.assign).not.toHaveBeenCalled();
  });
});
