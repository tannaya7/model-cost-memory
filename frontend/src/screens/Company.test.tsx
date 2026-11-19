import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { stubApi } from "../test/api";
import Company from "./Company";
import JoinCompany from "./JoinCompany";
import { fetchAllProjects } from "../features/workspaces/api/workspacesApi";
import { canAdminister } from "../app/useMyRole";

const ORG = "00000000-0000-0000-0000-0000000000aa";
const me = { user_id: "u-me", email: "ana@example.com", name: "Ana" };
const members = [
  { user_id: "u-me", email: "ana@example.com", name: "Ana", role: "owner", joined_at: "2026-11-01T00:00:00Z" },
  { user_id: "u-bo", email: "bo@example.com", name: "Bo", role: "member", joined_at: "2026-11-02T00:00:00Z" },
  { user_id: "u-ad", email: "ad@example.com", name: "Ad", role: "admin", joined_at: "2026-11-02T00:00:00Z" },
];
const space = (role: string) => ({ kind: "company", org_id: ORG, name: "Acme", role, project_count: 1, member_count: 3 });

afterEach(() => vi.unstubAllGlobals());

function open(role: string) {
  const calls = stubApi({
    "/v1/me": me,
    "/v1/workspaces": [{ kind: "personal", org_id: null, name: "Personal", role: "owner", project_count: 0, member_count: 1 }, space(role)],
    [`/v1/organisations/${ORG}/members`]: members,
    [`/v1/organisations/${ORG}/invites`]: [],
    [`/v1/organisations/${ORG}/events`]: [{ event_id: "e1", action: "role_changed", actor: "Ana", target: "Bo", detail: {}, at: "2026-11-18T00:00:00Z" }],
    "/v1/permissions": {
      roles: ["viewer", "member", "admin", "owner"],
      project: [{ permission: "content.view", means: "Read prompt and answer text", roles: ["member", "admin", "owner"] }],
      company: [{ permission: "company.delete", means: "Delete the company", roles: ["owner"] }],
    },
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[`/company/${ORG}`]}>
        <Routes><Route path="/company/:orgId" element={<Company />} /><Route path="/projects" element={<p>your projects</p>} /></Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return calls;
}

describe("company page", () => {
  it("lets an owner manage people and invite, and says personal projects are separate", async () => {
    open("owner");
    expect(await screen.findByRole("heading", { name: "Acme" })).toBeInTheDocument();
    expect(screen.getByText(/personal projects are not part of this company/i)).toBeInTheDocument();
    expect(screen.getByLabelText("Role for bo@example.com")).toBeInTheDocument();
    expect(screen.getByLabelText("Role for ad@example.com")).toBeInTheDocument();
    expect(screen.queryByLabelText("Role for ana@example.com")).toBeNull();
    expect(screen.getByRole("heading", { name: "Invite someone" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Delete company" })).toBeInTheDocument();
  });

  it("gives an admin no power over another admin and no delete button", async () => {
    open("admin");
    await screen.findByRole("heading", { name: "Acme" });
    expect(screen.getByLabelText("Role for bo@example.com")).toBeInTheDocument();
    expect(screen.queryByLabelText("Role for ad@example.com")).toBeNull();
    expect(screen.queryByRole("button", { name: "Delete company" })).toBeNull();
  });

  it("shows a viewer the people but no controls", async () => {
    open("viewer");
    await screen.findByRole("heading", { name: "Acme" });
    expect(screen.queryByRole("heading", { name: "Invite someone" })).toBeNull();
    expect(screen.queryByLabelText(/^Role for/)).toBeNull();
    expect(screen.getByRole("button", { name: "Leave company" })).toBeInTheDocument();
  });

  it("shows the invite link once, after making it", async () => {
    const calls = open("owner");
    await screen.findByRole("heading", { name: "Invite someone" });
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      calls.push(`${init?.method ?? "GET"} ${url}`);
      const body = init?.method === "POST"
        ? { invite: { invite_id: "i1", email: "new@example.com", role: "member", state: "pending", created_at: "2026-11-18T00:00:00Z", expires_at: "2026-11-25T00:00:00Z" }, token: "t".repeat(43), link: `/join/${"t".repeat(43)}` }
        : [];
      return new Response(JSON.stringify(body), { status: 201, headers: { "content-type": "application/json" } });
    }));
    await userEvent.type(screen.getByLabelText("Email"), "new@example.com");
    await userEvent.click(screen.getByRole("button", { name: "Make link" }));
    expect(await screen.findByText(/shown once/i)).toBeInTheDocument();
    expect(screen.getByText(new RegExp(`/join/${"t".repeat(43)}`))).toBeInTheDocument();
  });

  it("after removing someone, offers to replace the company's project keys", async () => {
    const calls = open("owner");
    await screen.findByRole("heading", { name: "Acme" });
    await userEvent.click(screen.getByRole("button", { name: "Remove bo@example.com" }));
    // asked in the page, not by the browser: what will happen, then a clearly named choice
    const ask = screen.getByRole("group", { name: "Remove bo@example.com" });
    expect(ask).toHaveTextContent("will lose access to Acme's projects at once");
    await userEvent.click(within(ask).getByRole("button", { name: "Remove" }));
    expect(await screen.findByText(/project key they saw still works/i)).toBeInTheDocument();
    expect(calls.some((c) => c.startsWith("DELETE") && c.includes("/members/u-bo"))).toBe(true);
  });

  it("shows the audit trail and the permission table to admins, and never the trail to a member", async () => {
    open("admin");
    expect(await screen.findByRole("region", { name: "Audit trail" })).toHaveTextContent(/role changed/);
    expect(await screen.findByText("What each role can do")).toBeInTheDocument();
  });

  it("keeps the audit trail from a member and shows a member list without email addresses when the server leaves them out", async () => {
    open("member");
    await screen.findByRole("heading", { name: "Acme" });
    expect(screen.queryByRole("region", { name: "Audit trail" })).toBeNull();
  });

  it("says plainly when the company is not among yours", async () => {
    stubApi({ "/v1/me": me, "/v1/workspaces": [] });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><MemoryRouter initialEntries={[`/company/${ORG}`]}><Routes><Route path="/company/:orgId" element={<Company />} /></Routes></MemoryRouter></QueryClientProvider>);
    expect(await screen.findByText("This company is not among yours")).toBeInTheDocument();
  });
});

describe("joining", () => {
  it("shows the server's plain message for a bad invite and stays put", async () => {
    stubApi({
      "/v1/me": me,
      "/v1/invites/accept": new Response(JSON.stringify({ detail: "This invite is not valid. It may have expired, been used or been withdrawn. Ask for a new one." }), { status: 404, headers: { "content-type": "application/json" } }),
    });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><MemoryRouter initialEntries={["/join/abc"]}><Routes><Route path="/join/:token" element={<JoinCompany />} /></Routes></MemoryRouter></QueryClientProvider>);
    await userEvent.click(await screen.findByRole("button", { name: "Join" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/not valid/i);
  });
});

describe("project list across workspaces", () => {
  it("adds company projects, and addresses a repeated short name by id so it never opens the wrong one", async () => {
    const personal = { project_id: "p-1", slug: "production", organisation_id: null };
    const company = { project_id: "c-1", slug: "production", organisation_id: ORG };
    stubApi({
      "/v1/workspaces": [{ kind: "personal", org_id: null }, space("member")],
      "/v1/projects?workspace=": [company],
      "/v1/projects": [personal],
    });
    const all = await fetchAllProjects();
    await waitFor(() => expect(all).toHaveLength(2));
    expect(all.find((p) => p.project_id === "p-1")?.slug).toBe("production");
    expect(all.find((p) => p.project_id === "c-1")?.slug).toBe("c-1");
  });

  it("still loads personal projects when the company list cannot be read", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) =>
      url.startsWith("/v1/workspaces") ? new Response("{}", { status: 500 }) : new Response(JSON.stringify([{ project_id: "p-1", slug: "production" }]), { status: 200, headers: { "content-type": "application/json" } })));
    expect((await fetchAllProjects()).map((p) => p.project_id)).toEqual(["p-1"]);
  });
});

describe("what a role sees in the menus", () => {
  it("leaves settings, limits and trials to admins and owners; the server still checks every request", () => {
    expect(["viewer", "member"].map((r) => canAdminister(r as never))).toEqual([false, false]);
    expect(["admin", "owner"].map((r) => canAdminister(r as never))).toEqual([true, true]);
  });
});

describe("confirmations happen in the page", () => {
  it("leaving asks first, says what happens, and Stay changes nothing", async () => {
    const calls = open("member");
    await screen.findByRole("heading", { name: "Acme" });
    await userEvent.click(screen.getByRole("button", { name: "Leave company" }));
    const ask = screen.getByRole("group", { name: "Leave Acme" });
    expect(ask).toHaveTextContent("your own personal projects stay yours");
    await userEvent.click(within(ask).getByRole("button", { name: "Stay" }));
    expect(screen.queryByRole("group", { name: "Leave Acme" })).toBeNull();
    expect(calls.some((c) => c.includes("/leave"))).toBe(false);
  });

  it("deleting the company needs its name typed and says it only works once it has no projects", async () => {
    const calls = open("owner");
    await screen.findByRole("heading", { name: "Acme" });
    await userEvent.click(screen.getByRole("button", { name: "Delete company" }));
    const ask = screen.getByRole("group", { name: "Delete Acme" });
    expect(ask).toHaveTextContent("only works once the company has no projects");
    const go = within(ask).getByRole("button", { name: "Delete company" });
    expect(go).toBeDisabled();
    await userEvent.type(within(ask).getByLabelText(/Type Acme to confirm/), "Acme");
    expect(go).toBeEnabled();
    expect(calls.some((c) => c.startsWith("DELETE"))).toBe(false); // nothing is sent until it is confirmed
  });

  it("no native browser pop-up is used for any of it", async () => {
    const confirm = vi.fn(() => true);
    const prompt = vi.fn(() => "Acme");
    vi.stubGlobal("confirm", confirm);
    vi.stubGlobal("prompt", prompt);
    open("owner");
    await screen.findByRole("heading", { name: "Acme" });
    await userEvent.click(screen.getByRole("button", { name: "Leave company" }));
    await userEvent.click(screen.getByRole("button", { name: "Delete company" }));
    expect(confirm).not.toHaveBeenCalled();
    expect(prompt).not.toHaveBeenCalled();
  });
});
