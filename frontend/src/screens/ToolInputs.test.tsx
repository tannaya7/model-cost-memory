import { afterEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders } from "../test/render";
import { WithProject } from "../app/project";
import type { Project } from "../shared/api/types";
import { KeysSection, ToolInputsSection } from "./Settings";
import { AgentsView } from "./overview/AgentsView";
import type { Ctx, ShellProps } from "./overview/widgets";

afterEach(() => vi.unstubAllGlobals());

const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });

function account(on: boolean, opts: { failPatch?: boolean; failDelete?: boolean } = {}) {
  const project = { project_id: "acme", name: "Acme", content_retention_days: 90, store_tool_arguments: on } as unknown as Project;
  const calls: { method: string; url: string; body?: unknown }[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    calls.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (url.endsWith("/tool-inputs")) return opts.failDelete ? json({ detail: "boom" }, 500) : json({ runs_cleared: 3 });
    if (url.startsWith("/v1/projects/acme")) {
      if (method === "PATCH") {
        if (opts.failPatch) return json({ detail: "Could not save that" }, 500);
        project.store_tool_arguments = JSON.parse(String(init?.body)).store_tool_arguments;
      }
      return json({ ...project });
    }
    return json([]);
  }));
  return { project, calls };
}

const mount = (project: Project) => renderWithProviders(<WithProject id="acme"><ToolInputsSection project={project} /></WithProject>);

describe("Settings: keep the inputs of tool calls", () => {
  it("is off by default, warns about private data and sends nothing until used", () => {
    const { project, calls } = account(false);
    mount(project);
    const sw = screen.getByRole("switch", { name: /Keep the inputs of tool calls/ });
    expect(sw).not.toBeChecked();
    expect(screen.getByText("Off: tool inputs are not stored")).toBeInTheDocument();
    expect(screen.getByRole("note")).toHaveTextContent(/customer names, file contents or secrets/);
    expect(calls.filter((c) => c.method !== "GET")).toHaveLength(0);
  });

  it("turns on with only that field and shows the on state", async () => {
    const { project, calls } = account(false);
    const user = userEvent.setup();
    mount(project);
    await user.click(screen.getByRole("switch"));
    await waitFor(() => expect(calls.find((c) => c.method === "PATCH")?.body).toEqual({ store_tool_arguments: true }));
  });

  it("shows the on state and turns off", async () => {
    const { project, calls } = account(true);
    const user = userEvent.setup();
    mount(project);
    expect(screen.getByRole("switch")).toBeChecked();
    expect(screen.getByText(/stops storing new inputs/)).toBeInTheDocument();
    await user.click(screen.getByRole("switch"));
    await waitFor(() => expect(calls.find((c) => c.method === "PATCH")?.body).toEqual({ store_tool_arguments: false }));
  });

  it("shows Saving while the change is in flight and an error if it fails", async () => {
    const { project } = account(false, { failPatch: true });
    const user = userEvent.setup();
    mount(project);
    await user.click(screen.getByRole("switch"));
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not save that");
  });

  it("asks before deleting stored inputs, then says how many calls were cleaned", async () => {
    const { project, calls } = account(false);
    const user = userEvent.setup();
    mount(project);
    await user.click(screen.getByRole("button", { name: "Delete stored tool inputs" }));
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
    await user.click(screen.getByRole("button", { name: "Yes, delete them" }));
    expect(await screen.findByText(/Removed from 3 calls/)).toBeInTheDocument();
    expect(calls.find((c) => c.method === "DELETE")?.url).toBe("/v1/projects/acme/tool-inputs");
  });

  it("shows an error when deleting fails", async () => {
    const { project } = account(false, { failDelete: true });
    const user = userEvent.setup();
    mount(project);
    await user.click(screen.getByRole("button", { name: "Delete stored tool inputs" }));
    await user.click(screen.getByRole("button", { name: "Yes, delete them" }));
    expect(await screen.findByRole("alert")).toBeInTheDocument();
  });
});

describe("possible-loop hint", () => {
  const shell = { id: "agents", first: false, last: false, onMove: () => {}, onRemove: () => {} } as unknown as ShellProps;
  const ctx = { days: 30 } as unknown as Ctx;
  const insights = (uses: boolean) => ({
    agents: [{ agent: "researcher", runs: 30, tokens_in: 1000, tokens_out: 100, cache_read_tokens: 0, spend_usd: 2.5, share: 1, models: ["m"], uses_tools: true, works_like_agent: "yes", tool_source: "tool_list", tool_servers: [], top_tools: [], steps_per_task: 4 }], tools: [], kinds: { calls: 30, uses_tools: true, works_like_agent: "yes", tool_source: "tool_list", tool_servers: [], multi_agent: false },
    traces: [{ trace_id: "t1", calls: 9, tokens: 5000, spend_usd: 1.2, agents: 1, repeated_prompts: false, agent_names: [], multi_agent: false, possible_loop: { step: "the search tool", repeats: 5, cost_usd: 0.4, uses_arguments: uses } }],
  });
  function api(on: boolean, uses: boolean) {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url.startsWith("/v1/insights/agents")) return json(insights(uses));
      if (url.startsWith("/v1/projects/acme")) return json({ project_id: "acme", name: "A", store_tool_arguments: on });
      return json([]);
    }));
  }
  const show = () => renderWithProviders(<WithProject id="acme"><AgentsView ctx={ctx} shell={shell} /></WithProject>);

  it("points to the switch when it is off and the loop used no inputs", async () => {
    api(false, false);
    show();
    expect(await screen.findByRole("link", { name: /turn on keeping tool inputs/ })).toHaveAttribute("href", "/settings#tool-inputs");
  });
  it("stays quiet when the switch is on or the loop already used inputs", async () => {
    api(true, false);
    const { unmount } = show();
    await screen.findByText(/Possible loop:/);
    await waitFor(() => expect(screen.queryByRole("link", { name: /turn on keeping/ })).toBeNull());
    unmount();
    api(false, true);
    show();
    await screen.findByText(/Possible loop:/);
    expect(screen.queryByRole("link", { name: /turn on keeping/ })).toBeNull();
  });
});

describe("Settings: API keys box", () => {
  const proj = { project_id: "acme", name: "Acme", key_prefix: "mcm_live_ab" } as unknown as Project;
  it("hides the paste-a-key box for a signed-in owner", () => {
    renderWithProviders(<WithProject id="acme"><KeysSection project={proj} mode="owned" /></WithProject>);
    expect(screen.getByText(/Live key/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Reset to demo key" })).not.toBeInTheDocument();
  });
  it("keeps it for a project-key visitor and the public demo", () => {
    for (const mode of ["key", "demo"] as const) {
      const { unmount } = renderWithProviders(<WithProject id={mode}><KeysSection project={null} mode={mode} /></WithProject>);
      expect(screen.getByRole("button", { name: "Reset to demo key" })).toBeInTheDocument();
      unmount();
    }
  });
});
