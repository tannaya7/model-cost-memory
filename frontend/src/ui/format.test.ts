import { describe, expect, it } from "vitest";
import { count, pct, usd } from "./format";

describe("usd", () => {
  it.each([
    [0, "$0"],
    [0.00085, "$0.00085"],
    [0.0031, "$0.0031"],
    [0.04, "$0.04"],
    [23.456, "$23.46"],
    [1234.5, "$1,235"],
    [-12.5, "−$12.50"],
  ])("%s reads as %s", (value, expected) => {
    expect(usd(value)).toBe(expected);
  });

  it("never shows a sub-cent cost as $0.00", () => {
    expect(usd(0.004)).not.toBe("$0.00");
  });

  it("shortens large amounts on request, and shows a dash for no value", () => {
    expect(usd(12_500, { compact: true })).toBe("$12.5K");
    expect(usd(null)).toBe("–");
  });
});

describe("pct and count", () => {
  it("formats rates and counts the way people read them", () => {
    expect(pct(0.9912)).toBe("99.1%");
    expect(pct(0.5, 0)).toBe("50%");
    expect(pct(undefined)).toBe("–");
    expect(count(1234)).toBe("1,234");
    expect(count(48_200)).toBe("48.2K");
  });
});
