import { describe, expect, it } from "vitest";
import { plainEvent } from "./plainEvent";
import type { FlowEvent } from "./types";

const ev = (over: Partial<FlowEvent>): FlowEvent => ({ event_id: 1, ts: "2026-11-16T10:00:00Z", run_id: "r1", stage: "api", message: "POST /v1/runs accepted: 202", data: { job: "invoice-extract" }, ...over }) as FlowEvent;

describe("plainEvent", () => {
  it("never shows the raw log line", () => {
    const text = plainEvent(ev({}));
    expect(text).toBe("The AI call for “Invoice extract” was stored with its cost");
    expect(text).not.toMatch(/POST|202|v1/);
  });
  it("says a new AI call was recorded", () => {
    expect(plainEvent(ev({ stage: "sdk", message: "RunRecorder captured call" }))).toBe("A new AI call was recorded for “Invoice extract”");
  });
  it("tells right from wrong and copes with no task name", () => {
    expect(plainEvent(ev({ stage: "check", data: { outcome: "FAIL" } }))).toContain("marked wrong");
    expect(plainEvent(ev({ stage: "check", data: null }))).toBe("An answer for your app was marked correct");
  });
});
