import { describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";
import { renderWithProviders } from "../../test/render";
import { stubApi } from "../../test/api";
import { ExamplesCard } from "./ExamplesCard";

const base = { model: "acme-mini", tokens_in: 1, tokens_out: 1, cost_usd: 0.001, created_at: new Date().toISOString() };

describe("ExamplesCard", () => {
  it("shows what was asked, what the AI answered and whether it was correct", async () => {
    const calls = stubApi({
      "/v1/runs?": { items: [{ ...base, run_id: "r1", outcome: "PASS", prompt_preview: "Total of invoice 7?", output_preview: "$120" }], next_cursor: null },
    });
    renderWithProviders(<ExamplesCard job="invoice-extract" />);
    expect(await screen.findByText("Total of invoice 7?")).toBeInTheDocument();
    expect(screen.getByText("$120")).toBeInTheDocument();
    expect(screen.getByText("Correct")).toBeInTheDocument();
    expect(screen.getByText(/visible only to people with access/)).toBeInTheDocument();
    expect(calls.some((c) => c.includes("job=invoice-extract") && c.includes("limit=50"))).toBe(true);
  });

  it("says plainly when the text was removed", async () => {
    stubApi({
      "/v1/runs?": { items: [{ ...base, run_id: "r2", outcome: "FAIL", prompt_preview: null, output_preview: null }], next_cursor: null },
    });
    renderWithProviders(<ExamplesCard job="invoice-extract" />);
    expect(await screen.findByText(/removed after your retention period/)).toBeInTheDocument();
    expect(screen.getByText("Wrong")).toBeInTheDocument();
  });
});
