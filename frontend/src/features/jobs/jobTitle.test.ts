import { describe, expect, it } from "vitest";
import { jobTitle } from "./jobTitle";

describe("jobTitle", () => {
  it("turns dashes and underscores into spaces in sentence case", () => {
    expect(jobTitle("invoice-extract")).toBe("Invoice extract");
    expect(jobTitle("ticket_classify")).toBe("Ticket classify");
    expect(jobTitle("a--b__c")).toBe("A b c");
  });
  it("keeps a plain name and survives an empty one", () => {
    expect(jobTitle("summarize")).toBe("Summarize");
    expect(jobTitle("")).toBe("");
  });
});
