import { describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";
import { renderWithProviders } from "../test/render";
import { stubApi } from "../test/api";
import { WithProject } from "../app/project";
import Jobs from "./Jobs";

const job = { job_id: "j1", name: "invoice-extract", description: null, check_kind: "ANSWER_KEY", check_config: {}, retest_consent: false, run_count: 12 };

describe("AI tasks list", () => {
  it("shows the friendly title, the code name, and asks for a description when there is none", async () => {
    stubApi({ "/v1/jobs": [job], "/v1/jobs/invoice-extract/recommendation": new Response("{}", { status: 404 }) });
    renderWithProviders(<WithProject id="acme"><Jobs /></WithProject>);
    expect(await screen.findByText("Invoice extract")).toBeInTheDocument();
    expect(screen.getByText("invoice-extract")).toBeInTheDocument();
    expect(screen.getByText(/No description yet/)).toBeInTheDocument();
    expect(screen.getByText(/12 AI calls/)).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 1, name: "AI tasks" })).toBeInTheDocument();
  });

  it("shows the description when there is one", async () => {
    stubApi({ "/v1/jobs": [{ ...job, description: "Pull the total out of an invoice" }], "/v1/jobs/invoice-extract/recommendation": new Response("{}", { status: 404 }) });
    renderWithProviders(<WithProject id="acme"><Jobs /></WithProject>);
    expect(await screen.findByText("Pull the total out of an invoice")).toBeInTheDocument();
    expect(screen.queryByText(/No description yet/)).toBeNull();
  });

  it("explains what a task is when there are none", async () => {
    stubApi({ "/v1/jobs": [], "/v1/jobs/invoice-extract/recommendation": new Response("{}", { status: 404 }) });
    renderWithProviders(<WithProject id="acme"><Jobs /></WithProject>);
    expect(await screen.findByText("No AI tasks yet")).toBeInTheDocument();
    expect(screen.getByText(/You create a task here first/)).toBeInTheDocument();
  });
});
