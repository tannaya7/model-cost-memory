import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { renderWithProviders } from "../../test/render";
import { floorOf, PassGauge, type Ctx } from "./widgets";
import type { DayPoint } from "../../shared/api/types";

const shell = { id: "pass-gauge", first: true, last: true, onMove: () => {}, onRemove: () => {} } as never;
const pt = (runs: number, passed: number, failed: number) => ({ day: "2026-11-13", job: "a", model: "m", runs, spend_usd: 1, passed, failed }) as unknown as DayPoint;
const ctx = (cur: DayPoint[]): Ctx => ({ days: 7, points: cur, cur, prev: [], dailyPending: false, jobs: [], jobsPending: false, byJob: new Map(), recsPending: false });

describe("Overview gauge empty states", () => {
  it("no AI calls yet", () => {
    renderWithProviders(<PassGauge ctx={ctx([])} shell={shell} />);
    expect(screen.getByText(/When your app sends its first call/)).toBeInTheDocument();
  });
  it("calls but none checked", () => {
    renderWithProviders(<PassGauge ctx={ctx([pt(10, 0, 0)])} shell={shell} />);
    expect(screen.getByText(/none are checked yet/)).toBeInTheDocument();
  });
  it("under the floor shows progress 10 of 25", () => {
    renderWithProviders(<PassGauge ctx={ctx([pt(20, 8, 2)])} shell={shell} />);
    const bar = screen.getByRole("progressbar");
    expect(bar).toHaveAttribute("aria-valuenow", "10");
    expect(bar).toHaveAttribute("aria-valuemax", "25");
  });
  it("at the floor the real gauge shows", () => {
    renderWithProviders(<PassGauge ctx={ctx([pt(30, 25, 5)])} shell={shell} />);
    expect(screen.queryByRole("progressbar")).toBeNull();
    expect(floorOf(new Map())).toBe(25);
  });
});
