import { describe, expect, it } from "vitest";
import { hasMoneyWording, MONEY_ALERT_FALLBACK, serverText } from "./moneyWording";

describe("money wording from the server", () => {
  it("spots dollars, saving, cost, bill and budget wording", () => {
    for (const t of [
      "Move to acme-mini and save $100.00 a month.",
      "You could be saving money.",
      "It costs less.",
      "Your bill may drop.",
      "You have used 85% of your monthly AI budget.",
      "At the pace of the last 7 days, this month's AI spend is heading up.",
    ]) expect(hasMoneyWording(t), t).toBe(true);
  });
  it("leaves measured wording alone", () => {
    for (const t of ["acme-mini passes 94.1% of checked answers, close to acme-large.", "Your AI calls used 90,000 tokens in the last hour.", "acme-large was retired (shut down on 2026-12-01)"]) expect(hasMoneyWording(t), t).toBe(false);
    expect(hasMoneyWording(null)).toBe(false);
    expect(hasMoneyWording("")).toBe(false);
  });
  it("only hides money wording on a subscription", () => {
    const t = "Switch and save $12.00 a month.";
    expect(serverText(t, "subscription", null)).toBeNull();
    expect(serverText(t, "per_use", null)).toBe(t);
    expect(serverText(t, "both", null)).toBe(t);
    expect(serverText("Pass rate fell.", "subscription", MONEY_ALERT_FALLBACK)).toBe("Pass rate fell.");
    expect(serverText(null, "subscription", "x")).toBe("x");
  });
});
