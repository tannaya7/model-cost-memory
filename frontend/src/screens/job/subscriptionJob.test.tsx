import { afterEach, describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import { renderWithProviders } from "../../test/render";
import { stubApi } from "../../test/api";
import { WithProject } from "../../app/project";
import type { Recommendation } from "../../shared/api/types";
import recSample from "../../mocks/recommendation.sample.json";
import { VerdictTab } from "./VerdictTab";
import { buildWhy } from "./why";
import { SpendTab } from "./Tabs";

afterEach(() => { localStorage.clear(); vi.unstubAllGlobals(); });

const rec = { ...(recSample as unknown as Recommendation), forecast: { runs_per_month: 3640, monthly_saving_usd: 101.6, extra_failures_per_month: 10.9, extra_failures_low: 1.8, extra_failures_high: 21.4 }, summary: "Moving saves $100 a month and cuts your bill." };
const today = new Date().toISOString().slice(0, 10);
const point = { day: today, job: "invoice-extract", model: "m", runs: 40, passed: 30, failed: 8, spend_usd: 12.5, tokens_in: 90_000, tokens_out: 10_000, cache_read_tokens: 0, cache_write_tokens: 0 };
const mount = (mode: string, ui: React.ReactElement) => {
  stubApi({ "/v1/projects/acme": { project_id: "acme", name: "Acme", billing_mode: mode }, "/v1/insights/daily": [point] });
  return renderWithProviders(<WithProject id="acme">{ui}</WithProject>);
};

describe("task page by billing mode", () => {
  it("per use is unchanged: cost per correct answer, the AI summary and the old card text", async () => {
    mount("per_use", <VerdictTab rec={rec} />);
    expect((await screen.findAllByText("Cost per correct answer")).length).toBeGreaterThan(0);
    expect(screen.getByText(/Moving saves \$100 a month/)).toBeInTheDocument();
    expect(screen.getByText("Written by AI from the figures below; it may be wrong.")).toBeInTheDocument();
    expect(screen.getAllByText("What you pay, on average, for each right answer.").length).toBeGreaterThan(0);
    expect(screen.getByText(/Saved per month/)).toBeInTheDocument();
  });

  it("subscription: list prices are labelled, no saving, no bill wording, money-talking summary hidden", async () => {
    mount("subscription", <VerdictTab rec={rec} />);
    expect((await screen.findAllByText("Cost per correct answer, at list prices")).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/not your bill/).length).toBeGreaterThan(0);
    expect(screen.queryByText(/Moving saves/)).toBeNull();
    expect(screen.queryByText(/Saved per month|Extra cost per month/)).toBeNull();
    expect(screen.queryByText("What you pay, on average, for each right answer.")).toBeNull();
    expect(screen.queryByText(/at \d+× less per successful answer/)).toBeNull();
    expect(screen.queryByText(/worth what it costs/)).toBeNull();
  });

  it("the written reasons show no per-answer dollar figure on a subscription, and say list price for both", () => {
    const sub = buildWhy(rec, "subscription").map((s) => s.text).join("\n");
    expect(sub).not.toMatch(/per correct answer|\$/);
    const both = buildWhy(rec, "both").map((s) => s.text).join("\n");
    expect(both).toMatch(/list price/);
    expect(buildWhy(rec, "per_use").map((s) => s.text).join("\n")).toMatch(/per correct answer instead of/);
  });

  it("the Spend tab shows tokens on a subscription and money otherwise", async () => {
    const first = mount("subscription", <SpendTab job="invoice-extract" />);
    expect(await screen.findByText("Tokens this job used, per day")).toBeInTheDocument();
    expect(screen.getByText("100K tokens over 60 days")).toBeInTheDocument();
    expect(screen.queryByText(/What this job costs/)).toBeNull();
    first.unmount();
    mount("per_use", <SpendTab job="invoice-extract" />);
    expect(await screen.findByText("What this job costs, per day")).toBeInTheDocument();
  });

  it("a negative forecast saving is shown as a rising bill, never as a saving", async () => {
    const dearer = { ...rec, verdict: "SWITCH", forecast: { ...rec.forecast!, monthly_saving_usd: -9 } } as Recommendation;
    mount("per_use", <VerdictTab rec={dearer} />);
    expect(await screen.findByText("Bill would rise per month")).toBeInTheDocument();
    expect(screen.queryByText(/Saved per month/)).toBeNull();
    expect(buildWhy(dearer, "per_use").map((s) => s.text).join(" ")).toMatch(/bill rise by about \$9/);
  });

  it("no forecast yet gives a calm still-learning card and no figures", async () => {
    mount("per_use", <VerdictTab rec={{ ...rec, forecast: null } as Recommendation} />);
    expect(await screen.findByTestId("forecast-learning")).toHaveTextContent("Still learning how much this task runs");
    expect(screen.queryByText(/Wrong answers a month/)).toBeNull();
  });
});
