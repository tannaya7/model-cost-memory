import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { stubApi } from "../test/api";
import { ProjectScope, WithProject, useP } from "./project";
import { findProject, projectPath } from "../shared/projectPath";

const UUID = "00000000-0000-0000-0000-000000000001";
const prod = { project_id: UUID, slug: "production", name: "production", created_at: "2026-09-01T00:00:00Z" };
const stage = { project_id: "00000000-0000-0000-0000-000000000002", slug: "staging", name: "staging", created_at: "2026-09-02T00:00:00Z" };
const user = { user_id: "u1", email: "ana@example.com", name: "Ana" };

afterEach(() => vi.unstubAllGlobals());

function open(url: string) {
  stubApi({
    "/v1/me": user,
    "/v1/projects": [prod, stage],
    [`/v1/projects/${UUID}`]: prod,
  });
  const router = createMemoryRouter(
    [{
      path: "/p/:projectRef",
      element: <ProjectScope />,
      children: [{ index: true, element: <p>overview here</p> }, { path: "jobs/:jobName", element: <p>job here</p> }],
    }, { path: "/projects", element: <p>your projects</p> }],
    { initialEntries: [url] },
  );
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><RouterProvider router={router} /></QueryClientProvider>);
  return router;
}

describe("short project names in the address", () => {
  it("opens a project by its short name and keeps the address short", async () => {
    const router = open("/p/production");
    expect(await screen.findByText("overview here")).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/p/production");
  });

  it("sends an old link with the long id to the short name, keeping the rest of the path", async () => {
    const router = open(`/p/${UUID}/jobs/invoice-extract?tab=runs`);
    expect(await screen.findByText("job here")).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/p/production/jobs/invoice-extract");
    expect(router.state.location.search).toBe("?tab=runs");
    expect(router.state.location.pathname).not.toContain(UUID);
  });

  it("shows the not-found state for a name that is not among your projects", async () => {
    const router = open("/p/not-mine");
    expect(await screen.findByText("This project is not among yours")).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/p/not-mine");
  });

  it("builds every link from the short name", () => {
    expect(projectPath(prod)).toBe("/p/production");
    expect(projectPath(prod, "/jobs")).toBe("/p/production/jobs");
    expect(projectPath("demo")).toBe("/p/demo");
    expect(findProject([prod, stage], UUID)).toBe(prod);
    expect(findProject([prod, stage], "staging")).toBe(stage);
    expect(findProject([prod, stage], "nope")).toBeUndefined();
    function Probe() {
      return <a href={useP()("/jobs")}>probe</a>;
    }
    render(<WithProject id={UUID} slug="production"><Probe /></WithProject>);
    expect(screen.getByText("probe")).toHaveAttribute("href", "/p/production/jobs");
  });
});
