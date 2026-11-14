import { afterEach, describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import { renderWithProviders } from "../../test/render";
import { stubApi } from "../../test/api";
import type { Job, Recommendation } from "../../shared/api/types";
import jobsSample from "../../mocks/jobs.sample.json";
import recSample from "../../mocks/recommendation.sample.json";
import modelsSample from "../../mocks/models.sample.json";
import { WithProject } from "../../app/project";
import Compare from "./Compare";

vi.mock("./profile/ProfileSuggestPanel", () => ({ ProfileSuggestPanel: ({ job }: { job: string }) => <div>profile panel for {job}</div> }));
vi.mock("./profile/Disclaimer", () => ({ SuggestionDisclaimer: ({ from, to }: { from: string; to: string }) => <p>disclaimer {from} to {to}</p> }));
vi.mock("./profile/modelLinks", () => ({ modelLink: () => ({ url: "https://example.com/m", label: "Read about it" }) }));

afterEach(() => {
  localStorage.clear();
  vi.unstubAllGlobals();
});

const jobs = jobsSample as unknown as Job[];
const rec = recSample as unknown as Recommendation;
const day = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
const point = (n: number) => ({ day: day(n), job: "invoice-extract", model: rec.models[0].model, runs: 10, passed: 9, failed: 1, spend_usd: 1, tokens_in: 10_000, tokens_out: 2_000 });

describe("Compare", () => {
  it("states the evidence and suggests models for a checked job", async () => {
    stubApi({
      "/v1/jobs/invoice-extract/recommendation": rec,
      "/v1/jobs": jobs,
      "/v1/models": modelsSample,
      "/v1/insights/daily": [point(3), point(2), point(1)],
    });
    renderWithProviders(<WithProject id="acme"><Compare /></WithProject>);
    expect(await screen.findByText(/Based on 3 days of use: 30 AI calls/)).toBeInTheDocument();
    expect(screen.getByText("Too early to be sure")).toBeInTheDocument();
    expect(await screen.findByRole("heading", { name: "Suggestions" })).toBeInTheDocument();
    expect(screen.getAllByText(/disclaimer/).length).toBeGreaterThan(0);
  });

  it("explains an unchecked job and shows the profile panel instead of a quality comparison", async () => {
    const unchecked = [{ ...jobs[0], name: "free-text", check_kind: "LATE_LABEL" }];
    stubApi({
      "/v1/jobs/free-text/recommendation": new Response("{}", { status: 404 }),
      "/v1/jobs": unchecked,
      "/v1/models": modelsSample,
      "/v1/insights/daily": [],
    });
    renderWithProviders(<WithProject id="acme"><Compare /></WithProject>);
    expect(await screen.findByText(/no way to check answers, so we cannot compare quality/)).toBeInTheDocument();
    expect(screen.getByText("profile panel for free-text")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Suggestions" })).not.toBeInTheDocument();
  });
});
