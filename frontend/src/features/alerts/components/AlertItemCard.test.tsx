import { describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";
import { renderWithProviders } from "../../../test/render";
import type { Alert } from "../../../shared/api/types";
import { AlertItemCard } from "./AlertItemCard";

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
    renderWithProviders(<AlertItemCard item={{ kind: "regression", alert: regression(), ...at }} />);
    expect(screen.getByRole("link", { name: /See the failing runs/ })).toHaveAttribute(
      "href",
      "/runs?job=invoice-extract&outcome=FAIL",
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
});
