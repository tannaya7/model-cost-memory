import { afterEach, describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders } from "../../../test/render";
import { RunLabelForm } from "./RunLabelForm";

afterEach(() => vi.unstubAllGlobals());

describe("labelling a run", () => {
  it("says a label cannot be changed, sends one request on Save, and toasts", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      calls.push(`${init?.method ?? "GET"} ${url}`);
      return new Response(JSON.stringify({ run_id: "r1" }), { status: 200, headers: { "content-type": "application/json" } });
    }));
    const user = userEvent.setup();
    renderWithProviders(<RunLabelForm runId="r1" />);
    expect(screen.getByText(/A label cannot be changed afterwards/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Pass" }));
    expect(calls.filter((c) => c.startsWith("POST"))).toHaveLength(0);
    await user.click(screen.getByRole("button", { name: "Save label" }));
    const toast = (await screen.findByText("Labelled pass. It now counts toward the pass rate.")).closest("[role=status]");
    expect(toast).not.toBeNull();
    expect(calls.filter((c) => c.startsWith("POST"))).toEqual(["POST /v1/runs/r1/label"]);
  });
});
