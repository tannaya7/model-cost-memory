import { describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders } from "../../test/render";
import type { Recommendation } from "../../shared/api/types";
import recSample from "../../mocks/recommendation.sample.json";
import { WithProject } from "../../app/project";
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
    const bar = screen.getByRole("progressbar");
    expect(bar).toHaveAttribute("aria-valuemax", String(downgrade.rules.evidence_floor));
    expect(bar).toHaveAttribute("aria-valuenow", String(Math.round(0.4 * downgrade.rules.evidence_floor)));
    // The floor is per model: the count is the best-covered model's (0.4 x 25 = 10), not the total over models.
    expect(screen.getByText(/You have 10 so far on your best-covered model/)).toBeInTheDocument();
    expect(screen.getByText(/Not enough checked answers yet. We need at least/)).toBeInTheDocument();
  });

  it("puts a plain sentence under the numbers and one help button on the recommendation", async () => {
    renderWithProviders(<VerdictTab rec={downgrade} />);
    expect(screen.getAllByText(/Out of every 100 answers we checked, about/).length).toBeGreaterThan(0);
    const help = screen.getByRole("button", { name: "How we reach this recommendation" });
    await userEvent.setup().click(help);
    expect(screen.getByRole("status")).toHaveTextContent(/within 3 points of the best model/);
    expect(screen.getByRole("status")).toHaveTextContent(/we need at least 25/);
  });

  it("offers the re-tests that would settle an open question", () => {
    renderWithProviders(<WithProject id="acme"><VerdictTab rec={downgrade} /></WithProject>);
    expect(screen.getByRole("link", { name: /Trial acme-nano on past prompts/ })).toHaveAttribute("href", "/p/acme/retest?job=invoice-extract&model=acme-nano");
  });

  it("gives the chart's numbers as a table on request", async () => {
    renderWithProviders(<VerdictTab rec={downgrade} />);
    await userEvent.setup().click(screen.getByRole("button", { name: /Show table/ }));
    const table = screen.getByRole("table");
    expect(table).toHaveTextContent("acme-mini");
    expect(table).toHaveTextContent("Cost / success");
  });
});
