import { afterEach, describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
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
  it("has four destinations instead of a long menu", () => {
    setup();
    const main = screen.getAllByRole("navigation", { name: "Main" })[0];
    const links = [...main.querySelectorAll("a")].map((a) => a.textContent?.trim());
    expect(links).toEqual(["Overview", "Jobs", "Models", "Activity"]);
  });

  it("jumps anywhere from the keyboard with Ctrl K", async () => {
    setup();
    const user = userEvent.setup();
    await user.keyboard("{Control>}k{/Control}");
    const search = await screen.findByRole("textbox", { name: "Search" });
    await user.type(search, "invoice");
    expect(await screen.findByText("invoice-extract")).toBeInTheDocument();
    await user.clear(search);
    await user.type(search, "retention");
    expect(screen.getByText("Settings")).toBeInTheDocument();
  });
});
