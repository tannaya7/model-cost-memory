import { afterEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders } from "../test/render";
import { stubApi } from "../test/api";
import { WithProject } from "./project";
import { Frame } from "./Frame";

afterEach(() => {
  vi.unstubAllGlobals();
});

function setup() {
  stubApi({ "/v1/jobs": [{ job_id: "1", name: "invoice-extract", run_count: 10, runs_by_state: {} }] });
  renderWithProviders(<Frame />);
}

describe("Frame", () => {
  it("keeps the ordinary destinations short and sets the two smart features apart", () => {
    setup();
    const main = screen.getAllByRole("navigation", { name: "Main" })[0];
    expect([...main.querySelectorAll("a")].map((a) => a.textContent?.trim())).toEqual(["Overview", "AI tasks", "Models", "Activity"]);
    const smart = screen.getByRole("navigation", { name: "Smart tools" });
    expect([...smart.querySelectorAll("a")].map((a) => a.querySelector("span > span")?.textContent)).toEqual(["Smart budget", "Smart compare"]);
    expect(within(smart).getByRole("link", { name: /Smart budget/ })).toHaveAttribute("href", expect.stringMatching(/\/budget$/));
    expect(within(smart).getByRole("link", { name: /Smart compare/ })).toHaveAttribute("href", expect.stringMatching(/\/compare$/));
  });

  it("puts every main place in the phone's bottom bar too, in a row that scrolls sideways", () => {
    setup();
    const phone = screen.getAllByRole("navigation", { name: "Main" })[1];
    expect([...phone.querySelectorAll("a")].map((a) => a.textContent?.trim())).toEqual([
      "Overview", "AI tasks", "Smart budget", "Smart compare", "MCP & Agents", "Cost analysis", "Cost planner", "Data coverage", "Models", "Activity",
    ]);
    expect(phone.querySelector("ul")).toHaveClass("overflow-x-auto");
  });

  it("gives MCP & Agents and Cost analysis their own top-level places, reachable by link", () => {
    setup();
    const analysis = screen.getByRole("navigation", { name: "Analysis" });
    const links = within(analysis).getAllByRole("link");
    expect(links.map((a) => a.querySelector("span > span")?.textContent)).toEqual(["MCP & Agents", "Cost analysis", "Cost planner", "Data coverage"]);
    expect(within(analysis).getByRole("link", { name: /MCP & Agents/ })).toHaveAttribute("href", expect.stringMatching(/\/agents$/));
    expect(within(analysis).getByRole("link", { name: /Cost analysis/ })).toHaveAttribute("href", expect.stringMatching(/\/costs$/));
    expect(within(analysis).getByRole("link", { name: /Cost planner/ })).toHaveAttribute("href", expect.stringMatching(/\/planner$/));
    expect(within(analysis).getByRole("link", { name: /Data coverage/ })).toHaveAttribute("href", expect.stringMatching(/\/coverage$/));
  });

  it("finds both new places from the search box", async () => {
    setup();
    const user = userEvent.setup();
    await user.keyboard("{Control>}k{/Control}");
    const search = await screen.findByRole("combobox", { name: "Search" });
    await user.type(search, "agents");
    expect(within(screen.getByRole("dialog", { name: "Go to" })).getByText("MCP & Agents")).toBeInTheDocument();
    await user.clear(search);
    await user.type(search, "feature labels");
    expect(within(screen.getByRole("dialog", { name: "Go to" })).getByText("Cost analysis")).toBeInTheDocument();
  });

  it("gives a company its own entry, and shows none to someone with no company", async () => {
    stubApi({
      "/v1/workspaces": [
        { kind: "personal", org_id: null, name: "You", role: "owner", member_count: 1, project_count: 1 },
        { kind: "company", org_id: "11111111-1111-1111-1111-111111111111", name: "Acme", role: "member", member_count: 4, project_count: 2 },
      ],
      "/v1/me": { user_id: "u", email: "a@example.com", name: null, picture_url: null, ui_flags: {} },
      "/v1/jobs": [],
    });
    renderWithProviders(<Frame />);
    const company = await screen.findByRole("navigation", { name: "Company" });
    const link = within(company).getByRole("link", { name: /Company portal/ });
    expect(link).toHaveAttribute("href", "/company/11111111-1111-1111-1111-111111111111");
    expect(link).toHaveTextContent("Acme");
  });

  it("has no company entry for someone who is not in a company", async () => {
    stubApi({ "/v1/workspaces": [{ kind: "personal", org_id: null, name: "You", role: "owner", member_count: 1, project_count: 1 }], "/v1/me": { user_id: "u", email: "a@example.com", name: null, picture_url: null, ui_flags: {} }, "/v1/jobs": [] });
    renderWithProviders(<Frame />);
    await waitFor(() => expect(screen.getByRole("navigation", { name: "Smart tools" })).toBeInTheDocument());
    expect(screen.queryByRole("navigation", { name: "Company" })).toBeNull();
  });

  it("jumps anywhere from the keyboard with Ctrl K", async () => {
    setup();
    const user = userEvent.setup();
    await user.keyboard("{Control>}k{/Control}");
    const search = await screen.findByRole("combobox", { name: "Search" });
    await user.type(search, "invoice");
    expect(await screen.findByText("invoice-extract")).toBeInTheDocument();
    expect(screen.getByText("Invoice extract")).toBeInTheDocument();
    await user.clear(search);
    await user.type(search, "Invoice ext");
    expect(await screen.findByText("Invoice extract")).toBeInTheDocument();
    await user.clear(search);
    await user.type(search, "retention");
    expect(within(screen.getByRole("dialog", { name: "Go to" })).getByText("Settings")).toBeInTheDocument();
  });

  it("keeps keyboard focus in the palette, names its list and closes on Escape from anywhere", async () => {
    setup();
    const user = userEvent.setup();
    await user.keyboard("{Control>}k{/Control}");
    const dialog = await screen.findByRole("dialog", { name: "Go to" });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    const search = within(dialog).getByRole("combobox", { name: "Search" });
    expect(search).toHaveFocus();
    expect(within(dialog).getByRole("listbox")).toBeInTheDocument();
    const first = within(dialog).getAllByRole("option")[0];
    expect(search).toHaveAttribute("aria-activedescendant", first.id);
    for (let i = 0; i < 4; i++) {
      await user.tab();
      expect(dialog.contains(document.activeElement)).toBe(true);
    }
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Go to" })).toBeNull());
  });

  it("says it is loading while the project list has not arrived", () => {
    vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));
    renderWithProviders(<Frame />);
    expect(screen.getAllByText("Loading projects…").length).toBeGreaterThan(0);
  });

  it("names the page-loading placeholder in words", () => {
    vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));
    renderWithProviders(<Frame />);
    expect(screen.getAllByRole("status").some((el) => /Loading/.test(el.textContent ?? ""))).toBe(true);
  });

  describe("the line between personal and company", () => {
    const projects = [
      { project_id: "mine", name: "Journal", slug: "journal", organisation_id: null, role: "owner" },
      { project_id: "teamapp", name: "Support bot", slug: "support-bot", organisation_id: "11111111-1111-1111-1111-111111111111", role: "member" },
    ];
    const spaces = [
      { kind: "personal", org_id: null, name: "You", role: "owner", member_count: 1, project_count: 1 },
      { kind: "company", org_id: "11111111-1111-1111-1111-111111111111", name: "Acme", role: "member", member_count: 4, project_count: 1 },
    ];
    const mount = (id: string) => {
      stubApi({ "/v1/workspaces": spaces, "/v1/projects": projects, "/v1/me": { user_id: "u", email: "a@example.com", name: "Ana", picture_url: null, ui_flags: {} }, "/v1/jobs": [] });
      renderWithProviders(<WithProject id={id}><Frame /></WithProject>);
    };

    it("labels a personal project Personal, and a company project with the company's name", async () => {
      mount("mine");
      expect((await screen.findAllByTestId("workspace-label"))[0]).toHaveTextContent("Personal");
    });

    it("says which company a project belongs to", async () => {
      mount("teamapp");
      expect((await screen.findAllByTestId("workspace-label"))[0]).toHaveTextContent("Acme");
    });

    it("shows each project's side of the line in the switcher list", async () => {
      mount("mine");
      const user = userEvent.setup();
      await user.click((await screen.findAllByRole("button", { name: /Journal/ }))[0]);
      const list = (await screen.findAllByRole("button", { name: /Support bot/ }))[0];
      expect(list).toHaveTextContent("Acme");
      expect(screen.getAllByRole("button", { name: /Journal/ }).some((b) => b.textContent?.includes("Personal"))).toBe(true);
    });

    it("offers Switch account, which opens the sign-in page in switching mode", async () => {
      mount("mine");
      const user = userEvent.setup();
      await user.click(await screen.findByRole("button", { name: "Account and settings" }));
      expect(await screen.findByRole("link", { name: "Switch account" })).toHaveAttribute("href", "/signin?switch=1&next=%2Fprojects");
    });
  });
});
