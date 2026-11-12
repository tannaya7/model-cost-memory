import { describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";
import { renderWithProviders } from "../../../test/render";
import type { Recommendation } from "../../../shared/api/types";
import sample from "../../../mocks/recommendation.sample.json";
import { RecommendationCard } from "./RecommendationCard";

const downgrade = sample as unknown as Recommendation;

describe("RecommendationCard", () => {
  it("names the cheaper model to move to and the one in use", () => {
    renderWithProviders(<RecommendationCard recommendation={downgrade} />);
    expect(screen.getByRole("heading", { name: "Use acme-mini instead of acme-large" })).toBeInTheDocument();
    expect(screen.getByText("Recommended")).toBeInTheDocument();
    expect(screen.getByText("Current")).toBeInTheDocument();
  });

  it("shows the optional summary only when there is one", () => {
    const { unmount } = renderWithProviders(<RecommendationCard recommendation={downgrade} />);
    expect(screen.queryByText(/passes as often/)).not.toBeInTheDocument();
    unmount();
    renderWithProviders(
      <RecommendationCard
        recommendation={{ ...downgrade, summary: "Switch invoice to acme-mini: it passes as often for less." }}
      />,
    );
    expect(screen.getByText(/passes as often/)).toBeInTheDocument();
  });

  it("asks to keep the current model on HOLD", () => {
    renderWithProviders(
      <RecommendationCard
        recommendation={{ ...downgrade, verdict: "HOLD", recommended: downgrade.current, forecast: null }}
      />,
    );
    expect(screen.getByRole("heading", { name: "Keep using acme-large" })).toBeInTheDocument();
  });

  it("shows progress toward the evidence floor instead of a verdict while evidence is thin", () => {
    renderWithProviders(
      <RecommendationCard
        recommendation={{ ...downgrade, verdict: "INSUFFICIENT_EVIDENCE", recommended: null, forecast: null, progress: 0.4 }}
      />,
    );
    expect(screen.getByRole("heading", { name: /Gathering evidence for/ })).toBeInTheDocument();
    expect(screen.getByText("40%")).toBeInTheDocument();
    expect(screen.queryByText("Recommended")).not.toBeInTheDocument();
  });

  it("puts every warning in front of the reader", () => {
    renderWithProviders(
      <RecommendationCard recommendation={{ ...downgrade, warnings: ["acme-large shuts down on 1 Dec 2026"] }} />,
    );
    expect(screen.getByText("acme-large shuts down on 1 Dec 2026")).toBeInTheDocument();
  });
});
