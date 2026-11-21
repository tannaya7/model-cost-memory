import { describe, expect, it } from "vitest";
import { codeName } from "./taskName";

describe("codeName", () => {
  it.each([
    ["Read invoices", "read-invoices"],
    ["  Answer support emails!  ", "answer-support-emails"],
    ["Café Münster", "cafe-munster"],
    ["Hjk", "hjk"],
    ["a__b  c", "a-b-c"],
    ["!!!", ""],
    ["日本語", ""],
    ["x".repeat(80), "x".repeat(40)],
  ])("%j becomes %j", (plain, expected) => {
    expect(codeName(plain)).toBe(expected);
  });

  it("always gives a name the server accepts, or nothing", () => {
    for (const t of ["Read invoices", "A-B", "9 lives", "snake_case name", "ÄÖÜ ok"]) {
      const c = codeName(t);
      expect(c === "" || /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(c)).toBe(true);
    }
  });
});
