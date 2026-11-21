import { afterEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders } from "../../test/render";
import { WithProject } from "../../app/project";
import { FirstResults, firstResultsReady } from "./FirstResults";

afterEach(() => {
  localStorage.clear();
  vi.unstubAllGlobals();
});

describe("firstResultsReady", () => {
  const base = { owned: true, flagsLoaded: true, flags: {}, checked: 25 };
  it("shows at the evidence floor of 25, not before", () => {
    expect(firstResultsReady(base)).toBe(true);
    expect(firstResultsReady({ ...base, checked: 24 })).toBe(false);
    expect(firstResultsReady({ ...base, checked: 10, floor: 10 })).toBe(true);
  });
  it("shows once only", () => expect(firstResultsReady({ ...base, flags: { first_results_seen: true } })).toBe(false));
  it("waits for the flags and ignores the demo", () => {
    expect(firstResultsReady({ ...base, flagsLoaded: false })).toBe(false);
    expect(firstResultsReady({ ...base, owned: false })).toBe(false);
  });
});

function stub(checked: number, seen = false) {
  const me = { user_id: "u1", email: "a@b.c", name: null, picture_url: null, ui_flags: seen ? { first_results_seen: true } : {} };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const body = init?.method === "PATCH" ? {} : url.startsWith("/v1/me") ? me : [{ day: "2026-11-01", job: "j", model: "m", runs: checked, passed: checked, failed: 0 }];
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    }),
  );
}

const view = () => renderWithProviders(<WithProject id="p1"><FirstResults /></WithProject>);

describe("FirstResults callout", () => {
  it("appears with honest wording and goes away on Got it", async () => {
    stub(30);
    view();
    expect(await screen.findByText("Your first results are in")).toBeInTheDocument();
    expect(screen.getByText(/Nothing changes unless you decide/)).toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole("button", { name: "Got it" }));
    await waitFor(() => expect(screen.queryByText("Your first results are in")).toBeNull());
  });
  it("stays away below the floor", async () => {
    stub(24);
    view();
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByText("Your first results are in")).toBeNull();
  });
  it("stays away once seen", async () => {
    stub(30, true);
    view();
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByText("Your first results are in")).toBeNull();
  });
});
