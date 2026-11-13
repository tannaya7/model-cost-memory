/** The way through the app: landing, sign in, projects, a new project, then its dashboard. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { stubApi } from "../test/api";
import Landing from "./Landing";
import NewProject from "./NewProject";
import Projects from "./Projects";

afterEach(() => {
  vi.unstubAllGlobals();
});

function Where() {
  const { pathname } = useLocation();
  return <p data-testid="where">{pathname}</p>;
}

function at(path: string, routes: React.ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          {routes}
          <Route path="*" element={<Where />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const signedOut = new Response(JSON.stringify({ detail: "Sign in first" }), { status: 401 });
const user = { user_id: "u1", email: "ana@example.com", name: "Ana Lima", picture_url: null };
const project = {
  project_id: "invoices-1a2b", name: "Invoice assistant", webhook_url: null, webhook_secret: null,
  retest_monthly_cap_usd: 10, retest_allowed: true, key_prefix: "mcm_live_ab12", created_at: "2026-11-01T10:00:00Z",
  content_retention_days: 90,
};

describe("landing page", () => {
  it("explains the product to a visitor and offers sign-in", async () => {
    stubApi({ "/v1/me": signedOut, "/auth/config": { google: true, dev_login: false, demo_project_id: null } });
    at("/", <Route path="/" element={<Landing />} />);
    expect(await screen.findByRole("heading", { level: 1, name: /Stop paying for a bigger model/ })).toBeInTheDocument();
    expect(screen.getAllByRole("link", { name: /Sign in|Get started/ })[0]).toHaveAttribute("href", "/signin");
    expect(screen.getByRole("heading", { name: /From every AI call to a decision/ })).toBeInTheDocument();
  });

  it("stays the front door for a signed-in person, with a way to their projects", async () => {
    stubApi({ "/v1/me": user, "/auth/config": { google: true, dev_login: false, demo_project_id: null } });
    at("/", <Route path="/" element={<Landing />} />);
    expect(await screen.findByRole("link", { name: "Open your projects" })).toHaveAttribute("href", "/projects");
    expect(screen.getByRole("heading", { level: 1, name: /Stop paying for a bigger model/ })).toBeInTheDocument();
  });

  it("is not redirected away by a project key left in the browser", async () => {
    localStorage.setItem("mcm_api_key", "mcm_live_old_key_from_last_month");
    stubApi({ "/v1/me": signedOut, "/auth/config": { google: true, dev_login: false, demo_project_id: null } });
    at("/", <Route path="/" element={<Landing />} />);
    expect(await screen.findByRole("heading", { level: 1, name: /Stop paying for a bigger model/ })).toBeInTheDocument();
    expect(screen.queryByTestId("where")).not.toBeInTheDocument();
  });
});

describe("projects", () => {
  it("sends someone with no project straight to making one", async () => {
    stubApi({ "/v1/me": user, "/v1/projects": [] });
    at("/projects", <Route path="/projects" element={<Projects />} />);
    expect(await screen.findByTestId("where")).toHaveTextContent("/projects/new");
  });

  it("lists every project with its numbers, each opening its dashboard", async () => {
    stubApi({ "/v1/me": user, "/v1/projects": [project], "/v1/jobs": [{ job_id: "j", name: "invoice", run_count: 1200, runs_by_state: {} }] });
    at("/projects", <Route path="/projects" element={<Projects />} />);
    const card = await screen.findByRole("link", { name: /Invoice assistant/ });
    expect(card).toHaveAttribute("href", "/p/invoices-1a2b");
    await waitFor(() => expect(card).toHaveTextContent("1,200"));
    expect(screen.getByRole("heading", { name: /Welcome back, Ana/ })).toBeInTheDocument();
    for (const link of screen.getAllByRole("link", { name: /New project/ })) expect(link).toHaveAttribute("href", "/projects/new");
  });
});

describe("a new project", () => {
  it("shows the key once, asks that it is saved, then sets up the recorder and opens the dashboard", async () => {
    const calls = stubApi({
      "/v1/me": user,
      "/v1/projects": { project, api_key: "mcm_live_ab12cd34ef56gh78ij90" },
    });
    at("/projects/new", <Route path="/projects/new" element={<NewProject />} />);
    const u = userEvent.setup();
    await u.type(await screen.findByLabelText("Project name"), "Invoice assistant");
    await u.click(screen.getByRole("button", { name: /Create project/ }));

    expect(await screen.findByLabelText("Project key")).toHaveTextContent("mcm_live_ab12cd34ef56gh78ij90");
    expect(calls).toContain("POST /v1/projects");
    const next = screen.getByRole("button", { name: /Next: record runs/ });
    expect(next).toBeDisabled(); // not until the key is saved
    await u.click(screen.getByRole("checkbox", { name: /I have saved the key/ }));
    await u.click(next);

    expect(await screen.findByText(/Wrap the model call you already make/)).toBeInTheDocument();
    await u.click(screen.getByRole("button", { name: /Open the dashboard/ }));
    expect(await screen.findByTestId("where")).toHaveTextContent("/p/invoices-1a2b");
  });
});
