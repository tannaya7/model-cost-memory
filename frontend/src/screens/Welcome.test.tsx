import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { stubApi } from "../test/api";
import { RequireUser } from "../app/project";
import Welcome from "./Welcome";

afterEach(() => vi.unstubAllGlobals());

const user = (flags?: Record<string, boolean>) => ({ user_id: "u1", email: "ana@example.com", name: "Ana Lee", ui_flags: flags });

function open(url: string, me: unknown) {
  const calls = stubApi({ "/v1/me/ui-flags": {}, "/v1/me": me });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[url]}>
        <Routes>
          <Route element={<RequireUser />}>
            <Route path="/welcome" element={<Welcome />} />
            <Route path="/projects" element={<p>your projects</p>} />
            <Route path="/projects/new" element={<p>new project</p>} />
          </Route>
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return calls;
}

describe("welcome after the first Google sign-in", () => {
  it("sends a first-time person to the welcome page, then on to where they were going", async () => {
    const calls = open("/projects/new", user({}));
    expect(await screen.findByRole("heading", { name: "Welcome, Ana" })).toBeInTheDocument();
    expect(screen.getByText("ana@example.com")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(await screen.findByText("new project")).toBeInTheDocument();
    expect(calls.some((c) => c.startsWith("PATCH") && c.includes("/v1/me/ui-flags"))).toBe(true);
  });

  it("does not show it again once seen, or when the server sent no flags", async () => {
    open("/projects", user({ welcome_seen: true }));
    expect(await screen.findByText("your projects")).toBeInTheDocument();
  });

  it("never blocks someone whose server sent no flags at all", async () => {
    open("/projects", user(undefined));
    expect(await screen.findByText("your projects")).toBeInTheDocument();
  });

  it("will not follow a next address that leaves the site", async () => {
    open("/welcome?next=//evil.example", user({}));
    await userEvent.click(await screen.findByRole("button", { name: "Continue" }));
    expect(await screen.findByText("your projects")).toBeInTheDocument();
  });
});
