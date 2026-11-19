import { afterEach, describe, expect, it, vi } from "vitest";
import { screen, within } from "@testing-library/react";
import { renderWithProviders } from "../test/render";
import { stubApi } from "../test/api";
import { WithProject } from "../app/project";
import Jobs from "./Jobs";

afterEach(() => vi.unstubAllGlobals());

const base = { description: "Pull the total out of an invoice", check_kind: "LATE_LABEL", check_config: {}, retest_consent: false, runs_by_state: {} };

describe("a task that has no AI calls yet", () => {
  it("is listed, and says what it is waiting for and the exact name the app must use", async () => {
    stubApi({ "/v1/jobs": [{ ...base, job_id: "j1", name: "read-invoices", run_count: 0 }], "/v1/jobs/read-invoices/recommendation": new Response("{}", { status: 404 }) });
    renderWithProviders(<WithProject id="acme"><Jobs /></WithProject>);
    expect(await screen.findByText("Read invoices")).toBeInTheDocument();
    const note = await screen.findByTestId("waiting-for-first-call");
    expect(note).toHaveTextContent("Waiting for its first AI call.");
    expect(within(note).getByText("read-invoices")).toBeInTheDocument();
    expect(note).toHaveTextContent("until then there is nothing to measure or recommend");
    expect(screen.queryByText("No AI tasks yet")).toBeNull();
  });

  it("shows no waiting note once calls have arrived", async () => {
    stubApi({ "/v1/jobs": [{ ...base, job_id: "j1", name: "read-invoices", run_count: 12 }], "/v1/jobs/read-invoices/recommendation": new Response("{}", { status: 404 }) });
    renderWithProviders(<WithProject id="acme"><Jobs /></WithProject>);
    await screen.findByText("Read invoices");
    expect(screen.queryByTestId("waiting-for-first-call")).toBeNull();
  });
});
