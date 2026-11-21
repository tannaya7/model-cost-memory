import { afterEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders } from "../../../test/render";
import { LimitCard } from "./LimitCard";

afterEach(() => vi.unstubAllGlobals());

const limit = { limit_id: "l1", name: "Weekly", window_hours: 168, measure: "PERCENT", size: null, used: 10, model: null, state: "OK", share_used: 0.1, rate_per_hour: 1, hours_to_reset: 100, hours_to_full: null, message: "Fine", suggestions: [] } as never;

function api(failWith?: { method: string; status: number; detail: string }) {
  const calls: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    calls.push(`${method} ${url}`);
    if (failWith && failWith.method === method) return new Response(JSON.stringify({ detail: failWith.detail }), { status: failWith.status, headers: { "content-type": "application/json" } });
    return method === "DELETE" ? new Response(null, { status: 204 }) : new Response(JSON.stringify([]), { status: 200, headers: { "content-type": "application/json" } });
  }));
  return { writes: () => calls.filter((c) => !c.startsWith("GET")) };
}

describe("a usage limit card", () => {
  it("Remove asks first, sends nothing until Stop tracking, then one DELETE and a toast", async () => {
    const { writes } = api();
    const user = userEvent.setup();
    renderWithProviders(<LimitCard limit={limit} />);
    await user.click(screen.getByRole("button", { name: "Remove" }));
    expect(screen.getByRole("group", { name: "Stop tracking Weekly" })).toHaveTextContent("Stop tracking Weekly? Warnings for it stop. Your recorded AI calls are not touched.");
    expect(writes()).toHaveLength(0);
    await user.click(screen.getByRole("button", { name: "Keep it" }));
    expect(writes()).toHaveLength(0);
    await user.click(screen.getByRole("button", { name: "Remove" }));
    await user.click(screen.getByRole("button", { name: "Stop tracking" }));
    const toast = (await screen.findByText("Stopped tracking Weekly")).closest("[role=status]");
    expect(toast).not.toBeNull();
    expect(writes()).toEqual(["DELETE /v1/limits/l1"]);
  });

  it("a failed remove shows the reason in an alert and keeps the confirm open", async () => {
    api({ method: "DELETE", status: 500, detail: "Server said no" });
    const user = userEvent.setup();
    renderWithProviders(<LimitCard limit={limit} />);
    await user.click(screen.getByRole("button", { name: "Remove" }));
    await user.click(screen.getByRole("button", { name: "Stop tracking" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Server said no");
    expect(screen.getByRole("group", { name: "Stop tracking Weekly" })).toBeInTheDocument();
  });

  it("Update: a bad number shows an error and sends nothing; a failure shows the reason and keeps the input", async () => {
    const { writes } = api({ method: "PUT", status: 500, detail: "Could not reach the plan" });
    const user = userEvent.setup();
    renderWithProviders(<LimitCard limit={limit} />);
    const box = screen.getByLabelText("Your plan shows");
    await user.type(box, "250");
    await user.click(screen.getByRole("button", { name: "Update" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Enter a number from 0 to 100.");
    expect(writes()).toHaveLength(0);
    await user.clear(box);
    await user.type(box, "40");
    await user.click(screen.getByRole("button", { name: "Update" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Could not reach the plan"));
    expect(box).toHaveValue("40");
  });

  it("a good update sends one PUT and toasts", async () => {
    const { writes } = api();
    const user = userEvent.setup();
    renderWithProviders(<LimitCard limit={limit} />);
    await user.type(screen.getByLabelText("Your plan shows"), "40");
    await user.click(screen.getByRole("button", { name: "Update" }));
    expect(await screen.findByText("Weekly updated to 40% used")).toBeInTheDocument();
    expect(writes()).toEqual(["PUT /v1/limits/l1/used"]);
  });
});
