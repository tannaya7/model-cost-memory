/** One definition per figure: the pass rate is the model in use; the saving is priced on calls on that model;
 * direction of wrong answers is said in words; under 7 days a month figure is a rough guess. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { screen, within } from "@testing-library/react";
import { renderWithProviders } from "../test/render";
import { stubApi } from "../test/api";
import type { Job, Recommendation } from "../shared/api/types";
import jobsSample from "../mocks/jobs.sample.json";
import recSample from "../mocks/recommendation.sample.json";
import modelsSample from "../mocks/models.sample.json";
import { WithProject } from "../app/project";
import Overview from "./Overview";
import Jobs from "./Jobs";
import Compare from "./compare/Compare";
import { VerdictTab } from "./job/VerdictTab";
import { passRateInUse, wrongAnswerWords, volumeWords, savingVolume } from "./forecastText";

afterEach(() => {
  localStorage.clear();
  vi.unstubAllGlobals();
});

const base = recSample as unknown as Recommendation;
const jobs = (jobsSample as unknown as Job[]).slice(0, 1);
// In use: acme-large at 95.0%. A second, worse model (80%) also ran many more checked calls.
const two: Recommendation = {
  ...base,
  verdict: "HOLD",
  recommended: base.current,
  forecast: null,
  models: base.models.map((m) =>
    m.model === "acme-large" ? { ...m, weighted_pass_rate: 0.95, n_runs: 100 } : { ...m, weighted_pass_rate: 0.8, n_runs: 500 },
  ),
};
const day = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
// pooled over both models: (95 + 400) / 600 = 82.5%, which is not what the model in use gets
const pt = (n: number, model: string, passed: number, failed: number) => ({ day: day(n), job: "invoice-extract", model, runs: passed + failed, passed, failed, spend_usd: 1, tokens_in: 1000, tokens_out: 100 });
const daily = [pt(1, "acme-large", 95, 5), pt(1, "acme-mini", 400, 100)];

describe("one pass rate for the model in use", () => {
  it("is the same on the Overview row, the Jobs list and the task page", async () => {
    expect(passRateInUse(two)).toBe(0.95);
    const stubs = {
      "/v1/jobs/invoice-extract/recommendation": two,
      "/v1/jobs": jobs,
      "/v1/insights/daily": daily,
      "/v1/news": { items: [], sources: [], your_models: [], updated_at: null, next_refresh_at: null },
    };
    stubApi(stubs);
    const overview = renderWithProviders(<Overview />);
    const row = (await screen.findAllByTitle("The name used in your code"))[0].closest("tr") as HTMLElement;
    expect(within(row).getByText("95.0%")).toBeInTheDocument();
    expect(within(row).queryByText("82.5%")).toBeNull();
    overview.unmount();

    stubApi(stubs);
    const list = renderWithProviders(<WithProject id="acme"><Jobs /></WithProject>);
    expect(await screen.findByText("95.0%")).toBeInTheDocument();
    expect(screen.getByText(/model in use/)).toBeInTheDocument();
    list.unmount();

    renderWithProviders(<VerdictTab rec={two} />);
    expect(screen.getAllByText("95.0%").length).toBeGreaterThan(0);
  });
});

describe("saving volume", () => {
  it("is the calls on the model in use, said next to the figure", () => {
    const f = { runs_per_month: 1000, monthly_saving_usd: 6.19, extra_failures_per_month: 1, extra_failures_low: -3, extra_failures_high: 5 };
    expect(volumeWords(f, "acme-large")).toBe("based on 1,000 calls a month on acme-large");
    renderWithProviders(<WithProject id="acme"><VerdictTab rec={{ ...base, forecast: f }} /></WithProject>);
    expect(screen.getByText("based on 1,000 calls a month on acme-large")).toBeInTheDocument();
    expect(savingVolume([{ ...base, forecast: f }, { ...base, verdict: "HOLD", forecast: null }])).toBe(1000);
  });
});

describe("wrong answers in words", () => {
  it("never needs a sign to be read", () => {
    const w = wrongAnswerWords({ extra_failures_per_month: 0, extra_failures_low: -38.8, extra_failures_high: 38.8 });
    expect(w.headline).toBe("about 0 fewer wrong answers a month");
    expect(w.range).toBe("could be up to 39 more or 39 fewer");
    expect(wrongAnswerWords({ extra_failures_per_month: 4.2, extra_failures_low: 1, extra_failures_high: 9 })).toEqual({ headline: "about 4 more wrong answers a month", range: "could be 1 to 9 more" });
    expect(wrongAnswerWords({ extra_failures_per_month: -4.2, extra_failures_low: -9, extra_failures_high: -1 })).toEqual({ headline: "about 4 fewer wrong answers a month", range: "could be 1 to 9 fewer" });
  });
});

describe("Compare under a week of data", () => {
  it("says 1 day, and calls the monthly figure a rough guess", async () => {
    stubApi({
      "/v1/jobs/invoice-extract/recommendation": base,
      "/v1/jobs": jobs,
      "/v1/models": modelsSample,
      "/v1/insights/daily": [pt(0, "acme-large", 9, 1)],
    });
    renderWithProviders(<WithProject id="acme"><Compare /></WithProject>);
    const line = await screen.findByTestId("evidence-line");
    expect(line).toHaveTextContent(/Based on 1 day of use/);
    expect(line).not.toHaveTextContent(/1 days/);
    expect(line).toHaveTextContent(/Still learning/);
    expect(line).toHaveTextContent(/rough guess/);
  });
});
