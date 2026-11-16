import { describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";
import { renderWithProviders } from "../test/render";
import type { Recommendation } from "../shared/api/types";
import recSample from "../mocks/recommendation.sample.json";
import { WithProject } from "../app/project";
import { VerdictTab } from "./job/VerdictTab";
import { VerdictPill } from "./shared";
import { BANNED_IN_PROMISING, confidenceWords, promisingDetails, promisingLine, PROMISING_ACTION, PROMISING_LABEL, twoStage } from "./promising";

const base = recSample as unknown as Recommendation;
const promising = { model: "acme-nano", current: "acme-large", gap_points: -0.7, low_points: -4.8, high_points: 2.1, more_needed: 340 };
const hold = { ...base, verdict: "HOLD", recommended: base.current, forecast: null, promising } as Recommendation;

describe("Promising, worth a trial", () => {
  it("shows the label, the plain line, the range and the only action: a trial", () => {
    renderWithProviders(<WithProject id="acme"><VerdictTab rec={hold} /></WithProject>);
    const card = screen.getByTestId("promising");
    expect(card).toHaveTextContent(PROMISING_LABEL);
    expect(card).toHaveTextContent("Looks close to acme-large so far. Not enough checked answers to be sure. Try it on your own examples.");
    expect(card).toHaveTextContent("between -4.8 and +2.1 points");
    expect(card).toHaveTextContent("may be overstated while the sample is small");
    expect(card).toHaveTextContent("About 340 more checked answers to be sure enough to recommend a switch");
    expect(card).toHaveTextContent("trial budget cap from Settings");
    const links = card.querySelectorAll("a");
    expect(links).toHaveLength(1);
    expect(links[0]).toHaveTextContent(PROMISING_ACTION);
    expect(links[0].getAttribute("href")).toBe("/p/acme/retest?job=invoice-extract&model=acme-nano");
    expect(card.querySelector("button")).toBeNull();
    // The trial link is the only way to start one: no second "Trial acme-nano" button elsewhere on the tab.
    expect(screen.queryByRole("link", { name: /Trial acme-nano on past prompts/ })).toBeNull();
  });

  it("uses no banned word and not the green switch colour", () => {
    renderWithProviders(<WithProject id="acme"><VerdictTab rec={hold} /></WithProject>);
    const card = screen.getByTestId("promising");
    for (const word of BANNED_IN_PROMISING) expect(card.textContent ?? "").not.toMatch(word);
    expect(card.innerHTML).not.toMatch(/text-ok|bg-ok|bg-good|good-soft/);
    const text = [promisingLine(promising), ...promisingDetails(promising)].join(" ");
    for (const word of BANNED_IN_PROMISING) expect(text).not.toMatch(word);
  });

  it("is absent without the field, and never next to a proven move", () => {
    renderWithProviders(<VerdictTab rec={{ ...hold, promising: null }} />);
    expect(screen.queryByTestId("promising")).toBeNull();
    renderWithProviders(<VerdictTab rec={{ ...base, promising }} />);
    expect(screen.queryAllByTestId("promising")).toHaveLength(0);
  });

  it("is a muted chip in the Jobs list and the Overview column, for HOLD only", () => {
    const { container } = renderWithProviders(<VerdictPill verdict="HOLD" rec={hold} />);
    expect(container).toHaveTextContent(PROMISING_LABEL);
    expect(container.innerHTML).not.toMatch(/text-ok|bg-ok|good/);
    const other = renderWithProviders(<VerdictPill verdict="DOWNGRADE" rec={hold} />);
    expect(other.container).not.toHaveTextContent(PROMISING_LABEL);
  });
});

describe("two-stage progress", () => {
  const r = { ...base, progress: 0.44 } as Recommendation;
  it("states both stages in words and shows two bars", () => {
    const rec = { ...r, verdict: "INSUFFICIENT_EVIDENCE", recommended: null, forecast: null, sure_enough: { needed: 380, have: 11 } } as Recommendation;
    renderWithProviders(<VerdictTab rec={rec} />);
    expect(screen.getByTestId("two-stage")).toHaveTextContent("Stage 1: 25 checked answers to start seeing results. Stage 2: about 380 to be sure enough to recommend a switch.");
    expect(screen.getAllByRole("progressbar")).toHaveLength(2);
  });
  it("never gives NaN, infinity or a blank for missing or odd numbers", () => {
    for (const se of [undefined, null, { needed: null, have: null }, { needed: Number.NaN, have: Number.NaN }, { needed: Infinity, have: 3 }, { needed: 5, have: 3 }]) {
      const t = twoStage({ ...r, sure_enough: se as never }, 3);
      expect(t.text).not.toMatch(/NaN|Infinity|undefined|null/);
      expect(t.text.length).toBeGreaterThan(20);
    }
    expect(twoStage({ ...r, sure_enough: { needed: 5, have: 3 } }, 3).stage2.need).toBe(25); // floor
  });
});

describe("confidence wording", () => {
  it("says what the engine really does", () => {
    expect(confidenceWords(0.99)).toEqual({ plain: "very high confidence", exact: "about 99.5%, one-sided" });
    expect(confidenceWords(0.95)).toEqual({ plain: "high confidence", exact: "about 97.5%, one-sided" });
  });
  it("the verdict help no longer claims 99% sure", () => {
    renderWithProviders(<VerdictTab rec={base} />);
    expect(document.body.textContent).not.toMatch(/99% sure|95% sure/);
  });
});
