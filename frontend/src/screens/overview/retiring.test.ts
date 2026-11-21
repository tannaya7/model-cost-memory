import { describe, expect, it } from "vitest";
import { retiringView } from "./retiring";

const now = new Date("2026-11-16T12:00:00Z");

describe("a model on the shutdown list", () => {
  it("says was shut down on the date once the date has passed, even if still marked deprecated", () => {
    const v = retiringView({ model: "acme-old-2025-01-01", status: "DEPRECATED", shutdown_date: "2026-11-05T00:00:00Z" }, now);
    expect(v.title).toBe("acme-old-2025-01-01 was shut down on Nov 5, 2026");
    expect(v.sub).not.toMatch(/being retired/);
  });
  it("says is being retired, with the coming date, before the date", () => {
    const v = retiringView({ model: "acme-mini", status: "DEPRECATED", shutdown_date: "2026-12-31T00:00:00Z" }, now);
    expect(v.title).toBe("acme-mini is being retired");
    expect(v.sub).toBe("Shuts down Dec 31, 2026");
  });
  it("says so when no date is published, and has been retired for a retired model", () => {
    expect(retiringView({ model: "m", status: "DEPRECATED", shutdown_date: null }, now).sub).toBe("No shutdown date published");
    expect(retiringView({ model: "m", status: "RETIRED", shutdown_date: null }, now).title).toBe("m has been retired");
  });
});
