import { describe, expect, it } from "vitest";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render } from "@testing-library/react";
import { stubApi } from "../../test/api";
import { WithProject } from "../../app/project";
import JobWorkspace from "./JobWorkspace";

const job = { job_id: "j1", name: "invoice-extract", description: "Pull the total", check_kind: "SCHEMA", check_config: {}, retest_consent: false, run_count: 3 };

function show() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={["/p/acme/jobs/invoice-extract?tab=runs"]}>
        <WithProject id="acme">
          <Routes><Route path="/p/acme/jobs/:jobName" element={<JobWorkspace />} /></Routes>
        </WithProject>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("AI task page", () => {
  it("shows the friendly title, code-name chip, description and plain tab names", async () => {
    stubApi({ "/v1/jobs": [job], "/v1/jobs/invoice-extract/recommendation": new Response("{}", { status: 404 }), "/v1/runs": { items: [], next_cursor: null } });
    show();
    expect(await screen.findByRole("heading", { level: 1, name: "Invoice extract" })).toBeInTheDocument();
    expect(screen.getAllByText("invoice-extract").length).toBeGreaterThan(0);
    expect(await screen.findByText(/Pull the total/)).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Recommendation" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Trials on new models" })).toBeInTheDocument();
    expect(screen.getByText("About this task")).toBeInTheDocument();
    expect(screen.getByText(/follows the format you defined/)).toBeInTheDocument();
    expect(screen.getByText(/No calls this month yet|Loading this month/)).toBeInTheDocument();
  });

  it("saves an edited description with PATCH", async () => {
    const calls = stubApi({ "/v1/jobs/invoice-extract/recommendation": new Response("{}", { status: 404 }), "/v1/runs": { items: [], next_cursor: null }, "/v1/jobs/invoice-extract": { ...job, description: "New text" }, "/v1/jobs": [job] });
    show();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Edit" }));
    const box = screen.getByLabelText("What does this task do?");
    await user.clear(box);
    await user.type(box, "New text");
    await user.click(within(box.closest("form")!).getByRole("button", { name: "Save" }));
    await vi_waitFor(() => expect(calls).toContain("PATCH /v1/jobs/invoice-extract"));
  });
});

import { vi } from "vitest";
const vi_waitFor = vi.waitFor;
