import { afterEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders } from "../test/render";
import { stubApi } from "../test/api";
import { Frame } from "./Frame";

afterEach(() => {
  vi.unstubAllGlobals();
});

function setup() {
  stubApi({ "/v1/jobs": [{ job_id: "1", name: "invoice-extract", run_count: 10, runs_by_state: {} }] });
  renderWithProviders(<Frame />);
}

describe("Frame", () => {
  it("has five destinations instead of a long menu", () => {
    setup();
    const main = screen.getAllByRole("navigation", { name: "Main" })[0];
    const links = [...main.querySelectorAll("a")].map((a) => a.textContent?.trim());
    expect(links).toEqual(["Overview", "AI tasks", "Models", "Compare", "Activity"]);
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
});
