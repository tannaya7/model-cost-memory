/** The month widget: what has been spent (a fact) and the forecast (an estimate) are kept apart, and when there is no
 * forecast it says why instead of guessing. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders } from "../../test/render";
import { WithProject } from "../../app/project";
import { projectionFixture } from "../../test/projection";
import { MonthProjection } from "./moneyWidgets";

afterEach(() => {
  localStorage.clear();
  vi.unstubAllGlobals();
});

const shell = { id: "projection", first: false, last: false, onMove: () => {}, onRemove: () => {} } as never;
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });

function mount(projection: unknown, budget: number | null = null, status = 200) {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (url.startsWith("/v1/projects/acme")) return json({ project_id: "acme", name: "Acme", monthly_budget_usd: budget });
    if (url.startsWith("/v1/insights/projection")) return json(projection, status);
    return json([]);
  }));
  return renderWithProviders(<WithProject id="acme"><MonthProjection shell={shell} /></WithProject>);
}

describe("spent so far and the forecast are separate", () => {
  it("shows what was spent as a fact, and the forecast as an estimate range that is not spend", async () => {
    mount(projectionFixture({ actual_usd: 41.25, projected_low_usd: 90, projected_likely_usd: 110, projected_high_usd: 150 }));
    const actual = await screen.findByTestId("actual");
    expect(actual).toHaveTextContent("Spent so far this month");
    expect(actual).toHaveTextContent("recorded calls at list prices, in US dollars");
    expect(actual.textContent).not.toMatch(/estimate|forecast/i);
    const forecast = screen.getByTestId("forecast");
    expect(forecast).toHaveTextContent("Forecast for 30 Nov");
    expect(forecast).toHaveTextContent("estimate");
    expect(forecast).toHaveTextContent("$90.00 to $150");
    expect(forecast).toHaveTextContent("likely $110, from your last 7 full days. Not spend that has happened.");
    expect(within(forecast).queryByText(/41\.25/)).toBeNull();
  });

  it("names the timezone, the first and last day, the day of the month and the currency", async () => {
    mount(projectionFixture({ timezone: "Pacific/Auckland", first_day: "2026-11-01", last_day: "2026-11-30", day_of_month: 18 }));
    const actual = await screen.findByTestId("actual");
    expect(actual).toHaveTextContent("in US dollars");
    expect(actual).toHaveTextContent("day 18 of 30");
    expect(actual).toHaveTextContent("counted in Pacific/Auckland");
    expect(await screen.findByText("1 Nov to 30 Nov 2026 (Pacific/Auckland)")).toBeInTheDocument();
  });

  it("a leap February is 29 days", async () => {
    mount(projectionFixture({ month: "2028-02", first_day: "2028-02-01", last_day: "2028-02-29", days_in_month: 29, day_of_month: 28 }));
    expect(await screen.findByTestId("actual")).toHaveTextContent("day 28 of 29");
    expect(screen.getByTestId("forecast")).toHaveTextContent("Forecast for 29 Feb");
  });

  it("discloses calls with no price, and says the newest calls and provider billing can be late", async () => {
    mount(projectionFixture({ unpriced_runs: 12 }));
    expect(await screen.findByText(/12 AI calls not counted: no known price/)).toBeInTheDocument();
    expect(screen.getByTestId("data-through")).toHaveTextContent("Data through");
    expect(screen.getByTestId("data-through")).toHaveTextContent("The newest calls, and any delay on your provider's own billing, can be missing.");
  });

  it("puts the rule behind the help button, in plain words", async () => {
    mount(projectionFixture());
    await screen.findByTestId("actual");
    await userEvent.setup().click(screen.getByRole("button", { name: "What does this mean?" }));
    const rule = await screen.findByText(/Spent so far is a fact/);
    for (const part of ["last 7 full days", "lowest and highest", "at least 5 of the last 7 days", "no call is recorded for 48 hours", "project's timezone", "not counted", "provider billing delays"]) {
      expect(rule.textContent).toContain(part);
    }
  });
});

describe("no forecast from a short, sparse or silent history", () => {
  it.each([
    ["too_new", { history_days: 5 }, "Needs 7 full days since your first priced call. You have 5."],
    ["sparse", { history_days: 30, active_days: 3 }, "Spend on only 3 of the last 7 days. It needs at least 5, so the pace is not reliable yet."],
  ] as const)("%s: says why there is no forecast and shows no range", async (reason, extra, text) => {
    mount(projectionFixture({ state: "not_enough_history", reason, projected_low_usd: null, projected_likely_usd: null, projected_high_usd: null, ...extra }));
    const forecast = await screen.findByTestId("forecast");
    expect(forecast).toHaveTextContent("No forecast yet");
    expect(screen.getByTestId("why-no-forecast")).toHaveTextContent(text);
    expect(forecast.textContent).not.toMatch(/\$|estimate|likely/);
    expect(screen.getByTestId("actual")).toHaveTextContent("Spent so far this month"); // the fact is still shown
  });

  it("paused: says no call has been recorded and that the recent pace would be wrong", async () => {
    mount(projectionFixture({ state: "paused", reason: "no_recent_calls", projected_low_usd: null, projected_likely_usd: null, projected_high_usd: null, data_through: new Date(Date.now() - 5 * 86_400_000).toISOString() }));
    expect(await screen.findByText("Forecast paused")).toBeInTheDocument();
    expect(screen.getByTestId("why-no-forecast")).toHaveTextContent(/No call has been recorded since .*so the recent pace would be wrong\./);
  });

  it("no spend yet: an explanation, not a blank card", async () => {
    mount(projectionFixture({ state: "no_spend", actual_usd: 0, projected_low_usd: null, projected_likely_usd: null, projected_high_usd: null }));
    expect(await screen.findByText("No spend this month yet")).toBeInTheDocument();
  });

  it("an answer that cannot be read says so and never leaves the card empty", async () => {
    mount([]);
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not load this month's figures. Try again in a moment.");
  });

  it("a server error says so too", async () => {
    mount({ detail: "boom" }, null, 500);
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not load this month's figures");
  });
});

describe("against a monthly limit", () => {
  const range = (low: number, high: number, actual = 40) => projectionFixture({ actual_usd: actual, projected_low_usd: low, projected_likely_usd: (low + high) / 2, projected_high_usd: high });

  it("over: even the LOW end is above the limit", async () => {
    mount(range(130, 200), 100);
    expect(await screen.findByText("Forecast over your limit")).toBeInTheDocument();
    expect(screen.getByText(/Even the low end of the forecast \(\$130\) is above \$100\./)).toBeInTheDocument();
  });

  it("may go over: only the high end is above the limit", async () => {
    mount(range(80, 140), 100);
    expect(await screen.findByText("Forecast may go over")).toBeInTheDocument();
    expect(screen.getByText(/The high end \(\$140\) is above your \$100 limit\. The low end is not\./)).toBeInTheDocument();
  });

  it("on track: the whole range is below the limit", async () => {
    mount(range(60, 90), 200);
    expect(await screen.findByText("On track")).toBeInTheDocument();
    expect(screen.getByText(/The whole forecast range is below your \$200 limit\./)).toBeInTheDocument();
  });

  it("close: 85% or more is already spent, said as spend that has happened", async () => {
    mount(range(190, 200, 180), 200);
    expect(await screen.findByText("Close to your monthly limit")).toBeInTheDocument();
    expect(screen.getByText(/90% of your limit is already spent\./)).toBeInTheDocument();
  });

  it("over the limit already: the fact comes first, whatever the forecast", async () => {
    mount(range(300, 400, 250), 200);
    expect(await screen.findByText("Over your monthly limit")).toBeInTheDocument();
    expect(screen.getByText(/\$250 is already spent against your \$200 limit\./)).toBeInTheDocument();
  });

  it("with no forecast it does not pretend to know whether the limit will hold", async () => {
    mount(projectionFixture({ state: "not_enough_history", reason: "too_new", history_days: 3, projected_low_usd: null, projected_likely_usd: null, projected_high_usd: null }), 100);
    expect(await screen.findByText("No forecast yet", { selector: "span" })).toBeInTheDocument();
    expect(screen.getByText(/So we cannot say yet whether you will stay within \$100\./)).toBeInTheDocument();
  });

  it("no limit set: no status chip", async () => {
    mount(range(60, 90), null);
    await screen.findByTestId("forecast");
    for (const chip of ["On track", "Forecast over your limit", "Forecast may go over", "Close to your monthly limit"]) expect(screen.queryByText(chip)).toBeNull();
  });
});

describe("nothing here blocks anything", () => {
  it("never offers a hard stop, a cap on calls or an enforced limit", async () => {
    const { container } = mount(projectionFixture(), 100);
    await screen.findByTestId("forecast");
    expect(container.textContent).not.toMatch(/block calls|hard stop|enforce|throttle|pause your app/i);
  });
});

