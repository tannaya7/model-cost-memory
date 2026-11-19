/** "What this rests on": the evidence state, the check, the window, pairs and limits. A gap is never called a tie. */
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import type { Recommendation } from "../../shared/api/types";
import { EvidenceBasis, gapWords } from "./EvidenceBasis";

const rec = (over: Partial<Recommendation["evidence"]> = {}) =>
  ({
    evidence: {
      n_runs: 1240, evidence_weight: 900, floor: 25, failing_runs: [], state: "enough", state_note: "Keep the current model.",
      check: { kind: "deterministic", label: "A saved correct answer", text: "Each answer was compared with a saved correct answer by a fixed rule." },
      window_from: "2026-11-02T08:00:00Z", window_to: "2026-11-17T09:00:00Z", comparison: "unpaired", paired: null,
      limitations: ["The models answered different requests, so they are compared as two separate groups."], ...over,
    },
  }) as unknown as Recommendation;

describe("what the verdict rests on", () => {
  it("names the state, the check, the window, the count and the limits", () => {
    render(<EvidenceBasis rec={rec()} />);
    const box = screen.getByTestId("evidence-basis");
    expect(box).toHaveTextContent("What this rests on · Enough evidence");
    expect(box).toHaveTextContent("How answers were checked: A saved correct answer. A fixed rule decided.");
    expect(box).toHaveTextContent("Checked answers from 2 Nov 2026 to 17 Nov 2026: 1,240 in all.");
    expect(box).toHaveTextContent("compared as two separate groups");
  });

  it.each([
    ["not_enough", "Not enough evidence yet"], ["not_comparable", "Not comparable"], ["no_recommendation", "No recommendation"],
  ] as const)("says %s in words", (state, words) => {
    render(<EvidenceBasis rec={rec({ state })} />);
    expect(screen.getByTestId("evidence-basis")).toHaveTextContent(words);
  });

  it("a label from the app is described as reported, never as a fixed rule", () => {
    render(<EvidenceBasis rec={rec({ check: { kind: "human_label", label: "Labels your app reports", text: "We cannot see how a label was made: if a model graded it, it is that model's opinion, not proof." } })} />);
    const box = screen.getByTestId("evidence-basis");
    expect(box).toHaveTextContent("Reported by your app.");
    expect(box).not.toHaveTextContent("A fixed rule decided");
    expect(box).toHaveTextContent("that model's opinion, not proof");
  });

  it("shows the paired comparison as information, with its range, and never as a tie", () => {
    render(<EvidenceBasis rec={rec({ comparison: "paired", paired: { candidate: "mini", current: "large", n_prompts: 60, both_passed: 50, only_candidate_passed: 4, only_current_passed: 5, neither_passed: 1, gap_points: -1.7, low_points: -6.2, high_points: 2.9 } })} />);
    const p = screen.getByTestId("paired");
    expect(p).toHaveTextContent("Same prompts through both models: 60 prompts, mini compared with large.");
    expect(p).toHaveTextContent("Gap −1.7 points (range −6.2 to +2.9)");
    expect(p).toHaveTextContent("no clear difference yet. A range that includes zero is not proof they are the same");
    expect(p).toHaveTextContent("the recommendation above does not depend on it");
    expect(p.textContent).not.toMatch(/\bties?\b|\btied\b|equally good|look the same|about the same|no difference/);
  });

  it("renders nothing for an older answer without the evidence state", () => {
    const { container } = render(<EvidenceBasis rec={{ evidence: { n_runs: 5, failing_runs: [] } } as unknown as Recommendation} />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe("gapWords", () => {
  it("follows the range, not whether the two models' own ranges overlap", () => {
    expect(gapWords(0.2, 4)).toContain("ahead");
    expect(gapWords(-5, -0.2)).toContain("behind");
    expect(gapWords(-0.5, 0.5)).toContain("no clear difference yet");
    expect(gapWords(0, 3)).toContain("no clear difference yet"); // a range touching zero is not proof
  });
});
