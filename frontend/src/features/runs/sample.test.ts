import { describe, expect, it } from "vitest";
import { pickMonthlySample } from "./sample";

const at = (day: number, month = 11) => ({ created_at: `2026-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}T10:00:00Z` });
const now = new Date("2026-11-20T00:00:00Z");

describe("pickMonthlySample", () => {
  it("takes the earliest, middle and latest of this month, oldest first", () => {
    const items = [at(19), at(2), at(10), at(15), at(7), at(1, 10)];
    expect(pickMonthlySample(items, now).map((r) => r.created_at.slice(8, 10))).toEqual(["02", "10", "19"]);
  });
  it("returns fewer when fewer exist and ignores other months", () => {
    expect(pickMonthlySample([at(5), at(3, 10)], now)).toHaveLength(1);
    expect(pickMonthlySample([], now)).toEqual([]);
  });
});
