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
const CODE = "Abc123_-Abc123_-Abc123_-Abc123_-Abc123_-xyz";

function open(url: string, me: unknown) {
  const calls = stubApi({
    "/v1/me/ui-flags": {},
    "/v1/me": me,
    "/v1/organisations": { org_id: "11111111-1111-1111-1111-111111111111", name: "Our team", role: "owner" },
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[url]}>
        <Routes>
          <Route element={<RequireUser />}>
            <Route path="/welcome" element={<Welcome />} />
            <Route path="/projects" element={<p>your projects</p>} />
            <Route path="/projects/new" element={<p>new project</p>} />
            <Route path="/join/:token" element={<p>join page</p>} />
            <Route path="/company/:id" element={<p>company page</p>} />
          </Route>
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return calls;
}

describe("welcome after a first sign-in", () => {
  it("sends a first-time person to the welcome page, then on to where they were going", async () => {
    const calls = open("/projects/new", user({}));
    expect(await screen.findByRole("heading", { name: "Welcome, Ana" })).toBeInTheDocument();
    expect(screen.getByText("ana@example.com")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /Just for me/ }));
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
    await userEvent.click(await screen.findByRole("button", { name: /Just for me/ }));
    expect(await screen.findByText("your projects")).toBeInTheDocument();
  });

  it("asks the same plain question of everyone and never decides from the email", async () => {
    open("/welcome", { ...user({}), email: "ana@bigcompany.example" });
    expect(await screen.findByRole("heading", { name: "How will you use this?" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Just for me/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /With a team or company/ })).toBeInTheDocument();
    expect(screen.getByText(/A work email is fine for this/)).toBeInTheDocument();
    for (const button of screen.getAllByRole("button")) expect(button).not.toHaveTextContent(/bigcompany/i); // the domain is never turned into a suggestion
  });

  it("takes a pasted invite link to the join page", async () => {
    const calls = open("/welcome", user({}));
    await userEvent.click(await screen.findByRole("button", { name: /With a team or company/ }));
    await userEvent.type(screen.getByLabelText("I have an invite"), `https://app.example.com/join/${CODE}`);
    await userEvent.click(screen.getByRole("button", { name: "Use this invite" }));
    expect(await screen.findByText("join page")).toBeInTheDocument();
    expect(calls.some((c) => c.startsWith("PATCH") && c.includes("/v1/me/ui-flags"))).toBe(true);
  });

  it("explains a bad invite in plain words and goes nowhere", async () => {
    open("/welcome", user({}));
    await userEvent.click(await screen.findByRole("button", { name: /With a team or company/ }));
    await userEvent.type(screen.getByLabelText("I have an invite"), "hello");
    await userEvent.click(screen.getByRole("button", { name: "Use this invite" }));
    expect(screen.getByRole("alert")).toHaveTextContent("does not look like an invite");
    expect(screen.queryByText("join page")).toBeNull();
  });

  it("starts a team, makes the person its owner and opens it, for a team of any size", async () => {
    const calls = open("/welcome", user({}));
    expect(await screen.findByText(/for 3 people or 300/)).toBeInTheDocument();
    await userEvent.click(await screen.findByRole("button", { name: /With a team or company/ }));
    await userEvent.type(screen.getByLabelText("Start a team or company"), "Our team");
    await userEvent.click(screen.getByRole("button", { name: "Start it" }));
    expect(await screen.findByText("company page")).toBeInTheDocument();
    expect(calls.some((c) => c.startsWith("POST") && c.includes("/v1/organisations"))).toBe(true);
  });

  it("can go back, and says nothing is permanent", async () => {
    open("/welcome", user({}));
    expect(await screen.findByText(/Nothing here is permanent/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /With a team or company/ }));
    await userEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.getByRole("heading", { name: "How will you use this?" })).toBeInTheDocument();
  });
});
