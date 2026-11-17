import { afterEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders } from "../../../test/render";
import { RetestStartPanel } from "./RetestStartPanel";

afterEach(() => vi.unstubAllGlobals());

const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });

function api(failStart = false) {
  const calls: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    calls.push(`${method} ${url}`);
    if (url === "/v1/jobs") return json([{ job_id: "j1", name: "invoice-extract", retest_consent: true, run_count: 90 }]);
    if (url.startsWith("/v1/retest/limits")) return json({ monthly_cap_usd: 10, spent_this_month_usd: 1, cap_remaining_usd: 9, provider_key: { provider: "gemini", key_hint: "abcd" } });
    if (url.startsWith("/v1/models")) return json({ items: [{ model: "gem-mini", provider: "gemini", status: "ACTIVE", price_in_per_mtok: 0.1, price_out_per_mtok: 0.4 }], total: 1 });
    if (method === "POST") return failStart ? json({ detail: "Provider refused" }, 500) : json({ retest_id: "t1", job: "invoice-extract" }, 202);
    return json([]);
  }));
  return { starts: () => calls.filter((c) => c.startsWith("POST")) };
}

describe("starting a trial", () => {
  it("the button only opens a review with provider, model, cost cap and budget; nothing is sent until Start trial", async () => {
    const { starts } = api();
    const user = userEvent.setup();
    renderWithProviders(<RetestStartPanel />);
    const open = await screen.findByRole("button", { name: "Review and start a trial" });
    await waitFor(() => expect(open).toBeEnabled());
    await user.click(open);
    const box = screen.getByRole("group", { name: "Start this trial" });
    expect(box).toHaveTextContent("gem-mini");
    expect(box).toHaveTextContent("(gemini)");
    expect(box).toHaveTextContent("It costs up to $2.00, within your trial budget of $10.00 a month ($9.00 left). The budget is checked before every call.");
    expect(starts()).toHaveLength(0);
    await user.click(screen.getByRole("button", { name: "Not now" }));
    expect(screen.queryByRole("group", { name: "Start this trial" })).toBeNull();
    expect(starts()).toHaveLength(0);
    await user.click(screen.getByRole("button", { name: "Review and start a trial" }));
    await user.click(screen.getByRole("button", { name: "Start trial" }));
    await waitFor(() => expect(starts()).toEqual(["POST /v1/jobs/invoice-extract/retest"]));
  });

  it("a failed start shows the reason as an alert and keeps the form", async () => {
    api(true);
    const user = userEvent.setup();
    renderWithProviders(<RetestStartPanel />);
    const open = await screen.findByRole("button", { name: "Review and start a trial" });
    await waitFor(() => expect(open).toBeEnabled());
    await user.click(open);
    await user.click(screen.getByRole("button", { name: "Start trial" }));
    expect(await screen.findByText("Provider refused")).toBeInTheDocument();
    expect(screen.getByLabelText(/Most this trial may spend/)).toHaveValue(2);
  });
});
