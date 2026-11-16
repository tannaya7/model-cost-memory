import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { stubApi } from "../test/api";
import { WithProject } from "../app/project";
import Activity from "./Activity";

function show(tab: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[`/p/acme/activity${tab}`]}>
        <WithProject id="acme">
          <Routes><Route path="/p/acme/activity" element={<Activity />} /></Routes>
        </WithProject>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("Activity", () => {
  it("has a short header", async () => {
    stubApi({});
    show("");
    expect(await screen.findByText("Alerts first, then live AI calls and news.")).toBeInTheDocument();
    expect(screen.getByText(/We check every 15 minutes/)).toBeInTheDocument();
  });

  it("shows live events as plain sentences, never as raw log lines", async () => {
    stubApi({
      "/v1/flow": [
        { event_id: 1, ts: new Date().toISOString(), run_id: "run_abcdef12", stage: "api", message: "POST /v1/runs accepted: 202 Accepted for 'customer-support'", data: { job: "customer-support" } },
        { event_id: 2, ts: new Date().toISOString(), run_id: "run_abcdef12", stage: "sdk", message: "RunRecorder captured call", data: { job: "customer-support" } },
      ],
    });
    show("?tab=live");
    expect(await screen.findByText("A new AI call was recorded for “Customer support”")).toBeInTheDocument();
    expect(screen.queryByText(/POST \/v1\/runs/)).toBeNull();
    expect(screen.queryByText(/Nothing to do here but watch/)).toBeNull();
  });

  it("gives a next step when nothing has arrived yet", async () => {
    stubApi({ "/v1/flow": [] });
    show("?tab=live");
    expect(await screen.findByText("Waiting for AI calls")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Get your API key" })).toHaveAttribute("href", "/p/acme/settings#keys");
  });
});
