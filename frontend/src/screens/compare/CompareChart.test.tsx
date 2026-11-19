/** The comparison chart on the user's own work: unequal samples, zero and missing values, empty states, keyboard
 * choice, the not-comparable state and the run-level drill-down. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Model, Recommendation } from "../../shared/api/types";
import recSample from "../../mocks/recommendation.sample.json";
import { WithProject } from "../../app/project";
import { renderWithProviders } from "../../test/render";
import { CompareChart } from "./CompareChart";
import { DifferenceChart } from "./DifferenceChart";
import { UntestedList } from "./UntestedList";
import { model, recWith } from "./compareModel.test";

afterEach(() => vi.unstubAllGlobals());

const sample = recSample as unknown as Recommendation;
const draw = (rec: Recommendation, providers: string[] = []) =>
  renderWithProviders(<WithProject id="acme"><CompareChart rec={rec} job="invoice-extract" providers={providers} providerOf={() => "acme"} /></WithProject>);

describe("the numbers on the chart are the engine's", () => {
  it("shows cost per 1,000 correct answers, not a number 1,000 times too large", () => {
    draw(sample);
    const row = screen.getByText(/^acme-large/, { selector: "td" }).closest("tr")!;
    expect(within(row).getByText("$35.03")).toBeInTheDocument(); // 0.035028 per correct answer is about $35.03 per 1,000
  });

  it("shows each model's checked answers beside its range, so unequal samples are visible", () => {
    const rec = recWith([model({ model: "big", n_runs: 2400, evidence_weight: 2300, pass_rate_low: 0.94, pass_rate_high: 0.96 }), model({ model: "small", n_runs: 40, evidence_weight: 35, weighted_pass_rate: 0.95, pass_rate_low: 0.84, pass_rate_high: 0.99 })]);
    draw(rec);
    const big = screen.getByText("big (in use)", { selector: "td" }).closest("tr")!;
    const small = screen.getByText("small", { selector: "td" }).closest("tr")!;
    expect(big).toHaveTextContent("95.0% (94% to 96%)");
    expect(big).toHaveTextContent("2,400");
    expect(small).toHaveTextContent("95.0% (84% to 99%)");
    expect(small).toHaveTextContent("40");
  });

  it("says too few checked answers instead of a range when the engine's weight is under the floor", () => {
    draw(recWith([model({ model: "big" }), model({ model: "thin", n_runs: 12, evidence_weight: 9, status: "BELOW_FLOOR" })]));
    expect(screen.getByText("thin", { selector: "td" }).closest("tr")).toHaveTextContent("Not enough checked answers yet");
  });

  it("says where the quality axis starts and never starts a hidden axis at an arbitrary number", () => {
    draw(recWith([model({ model: "a", pass_rate_low: 0.81 }), model({ model: "b" })]));
    expect(screen.getByText(/axis starts at \d+%, not zero/)).toBeInTheDocument();
  });

  it("notes that everything was measured on the user's own task, with the total", () => {
    draw(recWith([model({ model: "a", n_runs: 100 }), model({ model: "b", n_runs: 50 })]));
    expect(screen.getByTestId("own-work")).toHaveTextContent("measured on your own task: 150 checked answers in all. Nothing comes from public benchmarks.");
  });
});

describe("zero, missing and empty", () => {
  it("a model that costs nothing keeps a real $0 and is not called unknown", () => {
    draw(recWith([model({ model: "big" }), model({ model: "local", mean_cost_usd: 0, cost_per_success_usd: 0 })]));
    expect(screen.getByText("local", { selector: "td" }).closest("tr")).toHaveTextContent("$0.00 (costs nothing to run)");
    expect(screen.queryByTestId("not-drawn")).toBeNull();
  });

  it("a model with no price is listed as not drawn with the reason, and its cost cell says no price known", () => {
    draw(recWith([model({ model: "big" }), model({ model: "mystery", mean_cost_usd: null, cost_per_success_usd: null })]));
    expect(screen.getByTestId("not-drawn")).toHaveTextContent("mystery is not drawn: no price is known, so its cost cannot be shown.");
    expect(screen.getByText("mystery", { selector: "td" }).closest("tr")).toHaveTextContent("No price known");
  });

  it("with nothing drawable it explains why instead of leaving a blank chart", () => {
    draw(recWith([model({ model: "a", mean_cost_usd: null, cost_per_success_usd: null })]));
    expect(screen.getByTestId("nothing-drawn")).toHaveTextContent("nothing to draw");
  });

  it("with no models at all it renders nothing", () => {
    const { container } = draw(recWith([model({ model: "a" })], { models: [] } as Partial<Recommendation>));
    expect(container.querySelector("figure")).toBeNull();
  });
});

describe("choosing a model with the keyboard", () => {
  it("the chips are buttons: Enter opens the model's numbers, its missing costs and a drill-down to its own AI calls", async () => {
    const user = userEvent.setup();
    draw(recWith([model({ model: "big" }), model({ model: "mini", n_runs: 300, priced_runs: 210, unpriced_runs: 90, retest_runs: 40, cost_p50_usd: 0.001, cost_p90_usd: 0.004 })]));
    const chip = screen.getByRole("button", { name: "mini" });
    chip.focus();
    await user.keyboard("{Enter}");
    expect(chip).toHaveAttribute("aria-pressed", "true");
    const d = screen.getByTestId("model-detail");
    expect(d).toHaveTextContent("40 of them re-tests of your own past prompts");
    expect(d).toHaveTextContent("90 of 300 checked calls have no known price, so they are left out of the cost figures.");
    expect(d).toHaveTextContent("$0.001 typical");
    expect(d).toHaveTextContent("A few calls cost much more than a typical one, so the average cost hides them.");
    expect(within(d).getByRole("link", { name: "See this model's AI calls" }).getAttribute("href")).toContain("/jobs/invoice-extract?tab=runs&model=mini");
    expect(within(d).getByRole("link", { name: "See its failed answers" }).getAttribute("href")).toContain("&outcome=FAIL");
    expect(d).toHaveTextContent("only what your sign-in allows");
    await user.keyboard("{Enter}");
    expect(chip).toHaveAttribute("aria-pressed", "false");
  });

  it("the drill-down uses the model name without its reasoning-effort suffix", async () => {
    const user = userEvent.setup();
    draw(recWith([model({ model: "big@high" })]));
    await user.click(screen.getByRole("button", { name: "big@high" }));
    expect(screen.getByRole("link", { name: "See this model's AI calls" }).getAttribute("href")).toContain("&model=big");
  });

  it("has an accessible table with a caption and column headers", () => {
    draw(recWith([model({ model: "a" })]));
    expect(screen.getByRole("table")).toBeInTheDocument();
    expect(screen.getAllByRole("columnheader").length).toBeGreaterThanOrEqual(6);
    expect(screen.getByRole("img", { name: /Cost against correct answers for 1 models/ })).toBeInTheDocument();
  });
});

describe("models that cannot be fairly compared are never ranked", () => {
  const notComparable = (rec: Recommendation) => ({ ...rec, evidence: { ...rec.evidence, state: "not_comparable", state_note: "a and b were only tried on different prompt versions" } }) as Recommendation;

  it("shows the reason, hides the good-enough line and every verdict", () => {
    const rec = notComparable(recWith([model({ model: "a" }), model({ model: "b", status: "GOOD_ENOUGH" })]));
    draw(rec);
    expect(screen.getByTestId("not-comparable")).toHaveTextContent("a and b were only tried on different prompt versions");
    expect(screen.getByTestId("not-comparable")).toHaveTextContent("nothing is ranked and no line marks");
    expect(screen.getByText("b", { selector: "td" }).closest("tr")).toHaveTextContent("Not compared");
    expect(screen.queryByText("good enough above this line")).toBeNull();
  });
});

describe("the difference chart draws the engine's interval", () => {
  const diff = { against: "big", gap_points: -1.2, low_points: -5, high_points: 2.6, confidence: 0.99, margin_points: 3, status: "UNSURE" as const, method: "unpaired" as const };
  const mount = (rec: Recommendation) => renderWithProviders(<WithProject id="acme"><DifferenceChart rec={rec} /></WithProject>);

  it("shows the gap, its range and the rule's verdict in words, with the same numbers as the API", () => {
    mount(recWith([model({ model: "big" }), model({ model: "mini", vs_current: diff })]));
    const chart = screen.getByTestId("difference-chart");
    expect(chart).toHaveTextContent("Not sure yet");
    expect(chart).toHaveTextContent("−1.2 points (−5.0 to +2.6)");
    expect(within(chart).getByRole("img", { name: /mini: .*not sure yet whether it is within 3 points of big/ })).toBeInTheDocument();
    expect(chart).toHaveTextContent("0 = big");
    expect(chart).toHaveTextContent("−3 (the most we accept)");
  });

  it("an interval that touches zero is never worded as the same", () => {
    mount(recWith([model({ model: "big" }), model({ model: "mini", vs_current: diff })]));
    expect(document.body.textContent).toContain("is not proof the models are the same");
    expect(document.body.textContent).not.toMatch(/\bties?\b|equally good|look the same/);
  });

  it("good enough, unsure and clearly worse differ in words, not only in colour", () => {
    mount(recWith([model({ model: "big" }),
      model({ model: "m1", vs_current: { ...diff, status: "GOOD_ENOUGH", low_points: -2, high_points: 1 } }),
      model({ model: "m2", vs_current: diff }),
      model({ model: "m3", vs_current: { ...diff, status: "CLEARLY_WORSE", gap_points: -8, low_points: -12, high_points: -4 } })]));
    const chart = screen.getByTestId("difference-chart");
    for (const w of ["At most the margin worse", "Not sure yet", "Clearly worse"]) expect(chart).toHaveTextContent(w);
  });

  it("with no model in use it says so", () => {
    mount({ ...recWith([model({ model: "a" })]), current: null } as Recommendation);
    expect(screen.getByTestId("diff-empty")).toHaveTextContent("We do not know which model this task uses yet");
  });

  it("with no other model that has checked answers it says so and suggests a test", () => {
    mount(recWith([model({ model: "big" })]));
    expect(screen.getByTestId("diff-empty")).toHaveTextContent("No other model has checked answers on this task yet");
  });
});

describe("models never tested on this task", () => {
  const cat = (name: string, price: number | null) => ({ model: name, model_version: "", provider: "acme", price_in_per_mtok: price, price_out_per_mtok: price, status: "ACTIVE" }) as unknown as Model;
  const mount = (catalog: Model[], tokens: { in: number; out: number } | null = { in: 1000, out: 200 }) =>
    renderWithProviders(<WithProject id="acme"><UntestedList rec={recWith([model({ model: "big" })])} catalog={catalog} avgTokens={tokens} providers={[]} job="invoice-extract" /></WithProject>);

  it("has a neutral label, no score and no ranking, and offers to test on the user's own prompts", () => {
    mount([cat("new-mini", 1)]);
    const list = screen.getByTestId("untested-list");
    expect(list).toHaveTextContent("Not tested on your work yet");
    expect(list).toHaveTextContent("These have no score here");
    expect(list).toHaveTextContent("(estimate)");
    expect(list.textContent).not.toMatch(/\d+% (correct|pass)|better|best|good enough/i);
    expect(within(list).getByRole("link", { name: "Try it on your own past prompts" }).getAttribute("href")).toContain("/retest?job=invoice-extract&model=new-mini");
  });

  it("without token counts or a price it gives no estimate instead of a made-up one", () => {
    mount([cat("x", null)]);
    expect(screen.getByTestId("untested-list")).toHaveTextContent("No estimate: no token counts or list price yet");
  });

  it("a model the task already ran is not listed as untested, and an empty list renders nothing", () => {
    mount([cat("big", 1)]);
    expect(screen.queryByTestId("untested-list")).toBeNull();
  });
});
