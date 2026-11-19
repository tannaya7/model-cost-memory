/** Automatic trials: off by default, and turning them on says plainly that prompts go to the provider and money is spent unasked. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders } from "../test/render";
import { WithProject } from "../app/project";
import type { Project } from "../shared/api/types";
import { AutoTrialsSection } from "./Settings";

afterEach(() => {
  localStorage.clear();
  vi.unstubAllGlobals();
});

const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { "content-type": "application/json" } });

function mount(project: Partial<Project> = {}) {
  const patches: Array<Record<string, unknown>> = [];
  const p = { project_id: "acme", name: "Acme", slug: "acme", billing_mode: "per_use", auto_retests: false, ...project } as Project;
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (url.startsWith("/v1/projects/acme")) {
      if (init?.method === "PATCH") {
        const b = JSON.parse(String(init.body));
        patches.push(b);
        Object.assign(p, b);
      }
      return json({ ...p });
    }
    return json([]);
  }));
  renderWithProviders(<WithProject id="acme"><AutoTrialsSection project={p} /></WithProject>);
  return { patches };
}

describe("automatic trials", () => {
  it("are off by default and say that every trial normally needs a confirmation", () => {
    mount();
    expect(screen.getByRole("checkbox", { name: /Let trials start by themselves/ })).not.toBeChecked();
    expect(screen.getByText(/starts only after you review and confirm it/)).toBeInTheDocument();
  });

  it("turning them on first says what is sent and spent, and sends nothing until applied", async () => {
    const { patches } = mount();
    await userEvent.click(screen.getByRole("checkbox", { name: /Let trials start by themselves/ }));
    expect(screen.getByText(/sent to the provider behind your stored key, and your own money spent, without asking each time/)).toBeInTheDocument();
    expect(patches).toHaveLength(0);
    await userEvent.click(screen.getByRole("button", { name: "Allow automatic trials" }));
    await waitFor(() => expect(patches).toEqual([{ auto_retests: true }]));
  });
});
