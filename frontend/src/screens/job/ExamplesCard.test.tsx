import { describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";
import { renderWithProviders } from "../../test/render";
import { stubApi } from "../../test/api";
import { ExamplesCard } from "./ExamplesCard";

const base = { model: "acme-mini", tokens_in: 1, tokens_out: 1, cost_usd: 0.001, created_at: "2026-11-10T10:00:00Z", prompt_preview: null, output_preview: null, outcome_reason: null };
const daily = [{ day: "2026-11-10", runs: 40, tokens_in: 4000, tokens_out: 100 }];
const page = (items: unknown[]) => ({ items, next_cursor: null });

describe("ExamplesCard", () => {
  it("shows the summary, the examples and the wrong call with its reason", async () => {
    const calls = stubApi({
      "/v1/insights/daily": daily,
      "/v1/runs?": page([]),
      "/v1/runs?limit=20&job=invoice-extract&outcome=PASS": page([
        { ...base, run_id: "r1", outcome: "PASS", prompt_preview: "Total of invoice 7?", output_preview: "$120" },
        { ...base, run_id: "r3", created_at: "2026-11-09T10:00:00Z", outcome: "PASS", prompt_preview: "Translate poem", output_preview: "Poeme" },
      ]),
      "/v1/runs?limit=1&job=invoice-extract&outcome=FAIL": page([{ ...base, run_id: "r2", outcome: "FAIL", prompt_preview: "Total of invoice 9?", output_preview: "$1", outcome_reason: "Wrong total" }]),
    });
    renderWithProviders(<ExamplesCard job="invoice-extract" />);
    expect(await screen.findByText("Total of invoice 7?")).toBeInTheDocument();
    expect(screen.getByText("What this task looks like in practice")).toBeInTheDocument();
    expect(screen.getByText("Your app sent 40 AI calls here in the last 30 days.")).toBeInTheDocument();
    expect(screen.getByText("A typical call (marked correct)")).toBeInTheDocument();
    expect(screen.getByText("A different kind of call (marked correct)")).toBeInTheDocument();
    expect(screen.getByText("Translate poem")).toBeInTheDocument();
    expect(screen.getByText("A call marked wrong")).toBeInTheDocument();
    expect(screen.getByText(/Wrong total/)).toBeInTheDocument();
    expect(screen.getByText(/because your code names it/)).toBeInTheDocument();
    expect(screen.getByText(/visible only to people with access/)).toBeInTheDocument();
    expect(calls.filter((c) => c.includes("/v1/runs?")).length).toBe(2);
  });

  it("says plainly when the text was removed and when nothing is wrong", async () => {
    stubApi({
      "/v1/insights/daily": daily,
      "/v1/runs?limit=20&job=invoice-extract&outcome=PASS": page([{ ...base, run_id: "r2", outcome: "PASS" }]),
      "/v1/runs?limit=1&job=invoice-extract&outcome=FAIL": page([]),
    });
    renderWithProviders(<ExamplesCard job="invoice-extract" />);
    expect(await screen.findByText(/removed after your retention period/)).toBeInTheDocument();
    expect(screen.getByText("No call has been marked wrong yet.")).toBeInTheDocument();
    expect(screen.queryByText("A different kind of call (marked correct)")).toBeNull();
  });

  it("says answers are not checked when there are no checked calls", async () => {
    stubApi({ "/v1/insights/daily": daily, "/v1/runs?": page([]) });
    renderWithProviders(<ExamplesCard job="invoice-extract" />);
    expect(await screen.findByText(/Answers are not checked yet/)).toBeInTheDocument();
  });
});
