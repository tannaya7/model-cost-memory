import { describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders } from "../../test/render";
import type { Recommendation } from "../../shared/api/types";
import recSample from "../../mocks/recommendation.sample.json";
import { VerdictTab } from "./VerdictTab";

const downgrade = recSample as unknown as Recommendation;

describe("VerdictTab", () => {
  it("states the move in words, with both models side by side", () => {
    renderWithProviders(<VerdictTab rec={downgrade} />);
    expect(screen.getByRole("heading", { level: 2, name: "Move to acme-mini" })).toBeInTheDocument();
    expect(screen.getByText(/at 11× less per successful answer/)).toBeInTheDocument();
    expect(screen.getByText("In use now")).toBeInTheDocument();
    expect(screen.getByText("Recommended")).toBeInTheDocument();
  });

  it("asks to keep the model in use on HOLD", () => {
    renderWithProviders(<VerdictTab rec={{ ...downgrade, verdict: "HOLD", recommended: downgrade.current, forecast: null }} />);
    expect(screen.getByRole("heading", { level: 2, name: "Keep using acme-large" })).toBeInTheDocument();
    expect(screen.getByText(/No cheaper model is proven/)).toBeInTheDocument();
  });

  it("shows progress instead of a verdict while evidence is thin", () => {
    renderWithProviders(<VerdictTab rec={{ ...downgrade, verdict: "INSUFFICIENT_EVIDENCE", recommended: null, forecast: null, progress: 0.4 }} />);
    expect(screen.getByRole("heading", { level: 2, name: "Still learning" })).toBeInTheDocument();
    expect(screen.getByText("40%")).toBeInTheDocument();
  });

  it("offers the re-tests that would settle an open question", () => {
    renderWithProviders(<VerdictTab rec={downgrade} />);
    expect(screen.getByRole("link", { name: /Re-test acme-nano/ })).toHaveAttribute("href", "/retest?job=invoice-extract&model=acme-nano");
  });

  it("gives the chart's numbers as a table on request", async () => {
    renderWithProviders(<VerdictTab rec={downgrade} />);
    await userEvent.setup().click(screen.getByRole("button", { name: /Show table/ }));
    const table = screen.getByRole("table");
    expect(table).toHaveTextContent("acme-mini");
    expect(table).toHaveTextContent("Cost / success");
  });
});
