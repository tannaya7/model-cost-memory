/** The comparison chart's numbers: cost per 1,000 answers, and a model that costs nothing to call. */
import { describe, expect, it } from "vitest";
import { render, screen, within } from "@testing-library/react";
import type { Model, Recommendation } from "../../shared/api/types";
import recSample from "../../mocks/recommendation.sample.json";
import { CompareChart } from "./CompareChart";

const rec = recSample as unknown as Recommendation;
const free = {
  model: "local-llm:3b",
  model_version: "",
  provider: "ollama",
  price_in_per_mtok: 0,
  price_out_per_mtok: 0,
  shutdown_date: null,
  status: "ACTIVE",
  first_seen_at: "2026-01-01T00:00:00Z",
} as unknown as Model;

describe("CompareChart", () => {
  it("shows cost per 1,000 answers, not a number 1,000 times too large", () => {
    render(<CompareChart rec={rec} catalog={[]} avgTokens={{ in: 1000, out: 200 }} providers={[]} />);
    const row = screen.getByText("acme-large").closest("tr")!;
    // 0.035028 dollars per correct answer is about $35.03 per 1,000
    expect(within(row).getByText("$35.03")).toBeInTheDocument();
  });

  it("still draws when a model costs nothing to call (a log scale cannot show zero)", () => {
    const { container } = render(<CompareChart rec={rec} catalog={[free]} avgTokens={{ in: 1000, out: 200 }} providers={[]} />);
    expect(screen.getByText("local-llm:3b")).toBeInTheDocument();
    // the chart frame is there and the table lists both measured and not-tested models
    expect(container.querySelector("svg")).not.toBeNull();
    expect(screen.getByText("acme-large")).toBeInTheDocument();
  });
});
