import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import { renderWithProviders } from "../../../test/render";
import type { Alert, News } from "../../../shared/api/types";
import { WithProject } from "../../../app/project";
import { AlertItemCard, newsWindow } from "./AlertItemCard";

let requested: string[] = [];
let newsItems: News["items"] = [];

beforeEach(() => {
  requested = [];
  newsItems = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    requested.push(url);
    const body: News = { items: newsItems, sources: [], your_models: [], updated_at: null, next_refresh_at: null };
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function regression(overrides: Partial<Alert> = {}): Alert {
  return {
    alert_id: "8f6d1c1e-0000-4000-8000-000000000001",
    job: "invoice-extract",
    kind: "VERSION_REGRESSION",
    summary: "acme-mini got worse after its upgrade: 96.0% to 88.0%",
    detail: {
      model: "acme-mini", old_version: "acme-mini-2026-08-15", new_version: "acme-mini-2026-10-01",
      old_pass_rate: 0.96, new_pass_rate: 0.88, n_old: 1200, n_new: 300, drop: 0.08, p_value: 0.0004,
      failing_run_ids: [],
    },
    created_at: "2026-11-10T09:00:00Z",
    delivered_at: null,
    delivery_attempts: 0,
    delivery_failed_at: null,
    resolved_at: null,
    ...overrides,
  } as Alert;
}

const at = { timestamp: "2026-11-10T09:00:00Z" };

describe("AlertItemCard", () => {
  it("shows a version regression with both versions and the size of the drop", () => {
    renderWithProviders(<AlertItemCard item={{ kind: "regression", alert: regression(), ...at }} />);
    expect(screen.getByText("Regression")).toBeInTheDocument();
    expect(screen.getByText("acme-mini-2026-10-01")).toBeInTheDocument();
    expect(screen.getByText("96.0%")).toBeInTheDocument();
    expect(screen.getByText("88.0%")).toBeInTheDocument();
    expect(screen.getByText("(-8.0 points)")).toBeInTheDocument();
    expect(screen.getByText(/p < 0.001/)).toBeInTheDocument();
  });

  it("links to the failing runs of the job", () => {
    renderWithProviders(<WithProject id="acme"><AlertItemCard item={{ kind: "regression", alert: regression(), ...at }} /></WithProject>);
    expect(screen.getByRole("link", { name: /See the failing runs/ })).toHaveAttribute(
      "href",
      "/p/acme/jobs/invoice-extract?tab=runs&outcome=FAIL",
    );
  });

  it("says when webhook delivery gave up, and how to try again", () => {
    const gaveUp = regression({ delivery_attempts: 10, delivery_failed_at: "2026-11-11T21:00:00Z" });
    renderWithProviders(<AlertItemCard item={{ kind: "regression", alert: gaveUp, ...at }} />);
    expect(screen.getByText(/Webhook unreachable after 10 attempts; stopped trying/)).toBeInTheDocument();
  });

  it("offers no resolve button once an alert is resolved", () => {
    const resolved = regression({ resolved_at: "2026-11-12T08:00:00Z" });
    renderWithProviders(<AlertItemCard item={{ kind: "regression", alert: resolved, ...at }} />);
    expect(screen.getByText(/^Resolved/)).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("shows what was said about the model around when the alert was raised", async () => {
    newsItems = [{
      item_id: "n1", source: "Acme Labs", kind: "lab", title: "acme-mini 2026-10-01 changes output formatting",
      link: "https://example.com/acme", summary: "", published_at: "2026-10-01T10:00:00Z", affects: ["acme-mini"],
    }];
    renderWithProviders(<AlertItemCard item={{ kind: "regression", alert: regression(), ...at }} />);
    expect(await screen.findByText("In the news around this alert")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /changes output formatting/ })).toBeInTheDocument();
    const url = new URL(requested[0], "http://test");
    expect(url.pathname).toBe("/v1/news");
    expect(url.searchParams.get("model")).toBe("acme-mini");
    expect(url.searchParams.get("since")).toBe(newsWindow("2026-11-10T09:00:00Z").since);
  });
});

describe("newsWindow", () => {
  it("runs from two weeks before an alert to three days after", () => {
    expect(newsWindow("2026-11-15T00:00:00Z")).toEqual({
      since: "2026-11-01T00:00:00.000Z",
      until: "2026-11-18T00:00:00.000Z",
    });
  });
});
