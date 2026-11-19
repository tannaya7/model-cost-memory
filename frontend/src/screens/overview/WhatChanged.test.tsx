/** "What changed": measured differences with coverage and missing data, how they add up, and what was recorded at the same
 * time. Never a cause; never a zero for something unknown; no dollars for a flat-fee plan. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { WithProject } from "../../app/project";
import { renderWithProviders } from "../../test/render";
import type { Changes, ChangeObservation } from "../../features/insights/api/changesApi";
import { ChangesBody, changeText, splitSentence, valueText, WhatChanged } from "./WhatChanged";
import type { ShellProps } from "./widgets";

afterEach(() => vi.unstubAllGlobals());

const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });

const obs = (o: Partial<ChangeObservation> & { key: string }): ChangeObservation => ({
  label: o.key, unit: "count", before: 100, after: 150, change: 50, change_pct: 50, size: "notable", note: null, ...o,
});

const period = (o: Record<string, unknown> = {}) => ({
  start: "2026-11-11", end: "2026-11-18", days: 7, calls: 150, tokens_in: 150_000, tokens_out: 30_000, cache_read_tokens: 10_000, priced_calls: 150,
  spend_usd: 3, calls_with_usage: 150, calls_with_task_id: 90, days_with_calls: 7, ...o,
});

const answer = (o: Partial<Changes> = {}): Changes => ({
  days: 7, mode: "per_use", comparable: true,
  current: period(), previous: period({ start: "2026-11-04", end: "2026-11-11", calls: 100, spend_usd: 2 }),
  observations: [obs({ key: "calls", label: "AI calls" }), obs({ key: "tokens_out", label: "Output tokens", size: "small", change_pct: 4, before: 100, after: 104, change: 4 })],
  model_mix: [], task_mix: [], splits: [], events: [], notes: [],
  not_recorded: ["Changes to this project's settings and to your own code or prompts outside what you tag are not recorded here, so they cannot be listed."],
  basis: "Measured from this project's own calls. It cannot show why: a recorded change can coincide with a difference without causing it.", ...o,
} as Changes);

function mount(body: unknown, status = 200, days = 7) {
  const urls: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    urls.push(url);
    return url.startsWith("/v1/insights/changes") ? json(body, status) : json([]);
  }));
  renderWithProviders(<WithProject id="acme"><ChangesBody days={days} /></WithProject>);
  return urls;
}

describe("values and changes are shown in their own unit and never as a made-up zero", () => {
  const o = (u: ChangeObservation["unit"]) => ({ unit: u });
  it("not known is said, not shown as 0", () => {
    expect(valueText(o("count"), null)).toBe("not known");
    expect(valueText(o("usd"), null)).toBe("not known");
  });
  it("a real zero stays a zero", () => expect(valueText(o("count"), 0)).toBe("0"));
  it("shares are percents and the move is in points, never a percentage of a percentage", () => {
    const s = obs({ key: "cache_share", unit: "share", before: 17.2, after: 24.8, change: 7.6, change_pct: null });
    expect(valueText(s, 24.8)).toBe("24.8%");
    expect(changeText(s)).toBe("+7.6 points");
  });
  it("amounts move in percent, with a real minus sign", () => {
    expect(changeText(obs({ key: "a", change: 50, change_pct: 50.4 }))).toBe("+50%");
    expect(changeText(obs({ key: "a", change: -20, change_pct: -13.8 }))).toBe("−14%");
  });
  it("too few calls says so instead of a percentage", () => expect(changeText(obs({ key: "a", size: "unknown", change_pct: null }))).toBe("too few calls to say how much"));
  it("a missing change says not known", () => expect(changeText(obs({ key: "a", size: "small", change: null, change_pct: null }))).toBe("not known"));
});

describe("how it adds up", () => {
  it("states the parts as arithmetic with their signs and the unit", () => {
    const t = splitSentence({ what: "spend_usd", total_change: 22.3, from_calls: 49.5, from_mix: -31.2, from_per_call: 4 });
    expect(t).toBe("Spend rose by $22.30: +$49.50 from the number of calls, −$31.20 from calls moving between models, +$4.00 from what a call costs on a model used in both periods.");
    const k = splitSentence({ what: "tokens", total_change: -1200, from_calls: -1000, from_mix: 0, from_per_call: -200 });
    expect(k).toMatch(/^Tokens fell by 1,200: −1,000 from the number of calls/);
  });
  it("never uses a causal word", () => {
    for (const w of ["spend_usd", "tokens"] as const) expect(splitSentence({ what: w, total_change: 5, from_calls: 1, from_mix: 2, from_per_call: 2 })).not.toMatch(/\b(because|caused|due to|result of|led to)\b/i);
  });
});

describe("the card", () => {
  it("shows the two periods, whole days, with their call counts", async () => {
    mount(answer());
    expect(await screen.findByTestId("changes-periods")).toHaveTextContent("11 Nov 2026 to 17 Nov 2026 (150 calls) compared with 4 Nov to 10 Nov 2026 (100 calls). Whole UTC days only.");
  });

  it("lists notable changes first and keeps the small ones behind a disclosure", async () => {
    mount(answer());
    const box = await screen.findByTestId("what-changed");
    const sections = within(box).getByRole("region", { name: "What changed" });
    expect(sections).toHaveTextContent("AI calls");
    expect(sections).toHaveTextContent("100 → 150 (+50%)");
    expect(within(sections).getByText("Smaller or unclear changes (1)")).toBeInTheDocument();
  });

  it("when nothing is notable it says so instead of an empty list", async () => {
    mount(answer({ observations: [obs({ key: "calls", size: "small", change_pct: 2 })] }));
    expect(await screen.findByTestId("nothing-notable")).toHaveTextContent("Nothing moved by 20% or more");
  });

  it("with too few calls it says no change can be called notable", async () => {
    mount(answer({ comparable: false, observations: [obs({ key: "calls", size: "unknown", change_pct: null })], notes: ["Only 5 calls in the 7 days before: too few for a percentage change (we need 20)."] }));
    expect(await screen.findByTestId("nothing-notable")).toHaveTextContent("Too few calls in one of the periods");
    expect(screen.getByTestId("coverage-notes")).toHaveTextContent("Only 5 calls in the 7 days before");
  });

  it("with no calls in either period it says there is nothing to compare, not a blank card", async () => {
    mount(answer({ comparable: false, observations: [], current: period({ calls: 0 }), previous: period({ calls: 0 }), notes: ["There were no calls in the 7 days before, so there is nothing to compare with yet."] }));
    expect(await screen.findByText(/No AI calls in either period yet, so there is nothing to compare/)).toBeInTheDocument();
  });

  it("names what is missing: unpriced calls, days without calls, calls without token counts", async () => {
    mount(answer({ notes: ["318 calls in the last 7 days have no known price, so spend leaves them out.", "In the last 7 days, 2 had no calls at all.", "12 calls in the last 7 days report no token counts, so their tokens are not counted."] }));
    const notes = await screen.findByTestId("coverage-notes");
    expect(notes).toHaveTextContent("318 calls in the last 7 days have no known price");
    expect(notes).toHaveTextContent("2 had no calls at all");
    expect(notes).toHaveTextContent("report no token counts");
  });

  it("shows the share of calls by model and links a task to its page", async () => {
    mount(answer({ model_mix: [{ name: "mini", before_share: 12, after_share: 40, change_points: 28, calls_before: 12, calls_after: 60 }], task_mix: [{ name: "invoice-extract", before_share: null, after_share: 30, change_points: null, calls_before: 0, calls_after: 45 }] }));
    const rows = await screen.findAllByTestId("mix-row");
    expect(rows[0]).toHaveTextContent("mini: 12% → 40% of calls (+28 points)");
    expect(rows[1]).toHaveTextContent("invoice-extract: no calls → 30% of calls");
    expect(within(rows[1]).getByRole("link", { name: "invoice-extract" }).getAttribute("href")).toContain("/jobs/invoice-extract");
  });
});

describe("recorded at the same time is never a cause", () => {
  const events: Changes["events"] = [
    { kind: "new_model", on: "2026-11-14", label: "mini appeared in your calls for the first time", link: "same_time", evidence: null, relates_to: ["model_mix"] },
    { kind: "prompt_version", on: "2026-11-15", label: "Prompt version v3 of invoice-extract appeared", link: "concentrated", evidence: "In this period, calls on v3 sent 980 input tokens on average and the other invoice-extract calls 1,410. That fits the change. It does not show the wording is the reason for it.", relates_to: ["tokens_in_per_call"] },
  ];

  it("an event that merely coincides says it does not show an effect", async () => {
    mount(answer({ events }));
    const [first, second] = await screen.findAllByTestId("event");
    expect(first).toHaveTextContent("14 Nov: mini appeared in your calls for the first time. It happened in the same period. That does not show it affected the numbers above.");
    expect(second).toHaveTextContent("calls on v3 sent 980 input tokens on average");
    expect(second).toHaveTextContent("It does not show the wording is the reason for it.");
  });

  it("no text on the card ever claims a cause", async () => {
    mount(answer({ events, splits: [{ what: "spend_usd", total_change: 5, from_calls: 1, from_mix: 2, from_per_call: 2 }], model_mix: [{ name: "mini", before_share: 1, after_share: 40, change_points: 39, calls_before: 1, calls_after: 60 }] }));
    await screen.findByTestId("what-changed");
    expect(document.body.textContent).not.toMatch(/\b(because|caused|due to|result of|thanks to|led to|so that|explains why)\b/i);
  });

  it("says what it cannot see, and that the figures cannot show why", async () => {
    const user = userEvent.setup();
    mount(answer());
    await user.click(await screen.findByText("What this can and cannot tell you"));
    expect(screen.getByText(/It cannot show why: a recorded change can coincide with a difference without causing it/)).toBeInTheDocument();
    expect(screen.getByText(/settings and to your own code or prompts outside what you tag are not recorded here/)).toBeInTheDocument();
  });
});

describe("a flat-fee plan has no dollars", () => {
  it("shows tokens and no dollar figure when the server sends none", async () => {
    mount(answer({ mode: "subscription", current: period({ spend_usd: null }), previous: period({ spend_usd: null }), observations: [obs({ key: "tokens_in", label: "Input tokens", unit: "tokens", before: 1000, after: 1500 })] }));
    await screen.findByTestId("what-changed");
    expect(document.body.textContent).not.toMatch(/\$/);
    expect(screen.getByText("Input tokens")).toBeInTheDocument();
  });
});

describe("loading, failing and choosing a length", () => {
  it("a failed request says so with a way to retry", async () => {
    mount({ detail: "boom" }, 500);
    expect(await screen.findByRole("alert")).toBeInTheDocument();
  });

  it("an answer that is not a changes object is a failure, never an empty card", async () => {
    mount([]);
    expect(await screen.findByRole("alert")).toBeInTheDocument();
  });

  it("choosing 14 days asks for 14 days", async () => {
    const urls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      urls.push(url);
      return url.startsWith("/v1/insights/changes") ? json(answer()) : json([]);
    }));
    const shell = { id: "what-changed", first: false, last: false, onMove: () => {}, onRemove: () => {} } as unknown as ShellProps;
    const user = userEvent.setup();
    renderWithProviders(<WithProject id="acme"><WhatChanged shell={shell} /></WithProject>);
    await user.click(await screen.findByRole("tab", { name: "14 days" }));
    await waitFor(() => expect(urls.some((u) => u.includes("days=14"))).toBe(true));
    expect(urls[0]).toContain("days=7");
  });
});
