/** Signing in, and switching to another account: the person is sent on if already signed in, unless they asked to switch; nothing from the
 *  first account survives the switch in this browser. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { stubApi } from "../test/api";
import { getActiveProject, setActiveProject } from "../shared/api/apiFetch";
import { queryClient } from "../shared/api/queryClient";
import SignIn from "./SignIn";

afterEach(() => {
  vi.unstubAllGlobals();
  queryClient.clear();
  setActiveProject("");
});

const me = { user_id: "u1", email: "ana@example.com", name: "Ana", ui_flags: { welcome_seen: true } };

function open(url: string, signedIn: boolean, config = { google: true, dev_login: true, demo_project_id: null }) {
  const calls = stubApi({
    "/auth/config": config,
    "/auth/dev/login": { ...me, email: "ben@example.com" },
    "/v1/me": signedIn ? me : new Response(JSON.stringify({ detail: "no" }), { status: 401, headers: { "content-type": "application/json" } }),
  });
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[url]}>
        <Routes>
          <Route path="/signin" element={<SignIn />} />
          <Route path="/projects" element={<p>your projects</p>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return calls;
}

describe("sign-in and switching accounts", () => {
  it("sends a signed-in person straight on, as before", async () => {
    open("/signin", true);
    expect(await screen.findByText("your projects")).toBeInTheDocument();
  });

  it("stays on the page for someone who asked to switch, says who they are now and that accounts stay separate", async () => {
    open("/signin?switch=1", true);
    const note = await screen.findByRole("status");
    expect(note).toHaveTextContent("ana@example.com");
    expect(note).toHaveTextContent("Each account keeps its own projects and teams");
    expect(screen.queryByText("your projects")).toBeNull();
  });

  it("asks Google for its account chooser only when switching", async () => {
    const assign = vi.fn();
    vi.stubGlobal("location", { ...window.location, assign });
    open("/signin?switch=1&next=%2Fprojects", true);
    await userEvent.click(await screen.findByRole("button", { name: /Continue with Google/ }));
    expect(assign).toHaveBeenLastCalledWith("/auth/google/login?next=%2Fprojects&switch=true");
  });

  it("does not ask for the chooser on an ordinary sign-in", async () => {
    const assign = vi.fn();
    vi.stubGlobal("location", { ...window.location, assign });
    open("/signin?next=%2Fprojects", false);
    await userEvent.click(await screen.findByRole("button", { name: /Continue with Google/ }));
    expect(assign).toHaveBeenLastCalledWith("/auth/google/login?next=%2Fprojects");
  });

  it("clears everything the first account had cached, and the project it had open, when another signs in", async () => {
    queryClient.setQueryData(["projects"], [{ project_id: "ana-private" }]);
    queryClient.setQueryData(["jobs"], [{ name: "ana-secret-task" }]);
    setActiveProject("ana-private");
    open("/signin?switch=1", true);
    await userEvent.type(await screen.findByLabelText("Development sign-in"), "ben@example.com");
    await userEvent.click(screen.getByRole("button", { name: "Sign in" }));
    await waitFor(() => expect(screen.getByText("your projects")).toBeInTheDocument());
    expect(queryClient.getQueryData(["projects"])).toBeUndefined();
    expect(queryClient.getQueryData(["jobs"])).toBeUndefined();
    expect(getActiveProject()).toBe("");
  });
});
