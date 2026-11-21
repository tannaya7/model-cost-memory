/** The model-notice alert and the reworded burst alert: both say what they are and what they are not. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import { renderWithProviders } from "../../../test/render";
import type { Alert } from "../../../shared/api/types";
import { WithProject } from "../../../app/project";
import { stubApi } from "../../../test/api";
import { AlertItemCard } from "./AlertItemCard";

afterEach(() => {
  localStorage.clear();
  vi.unstubAllGlobals();
});

function alert(kind: Alert["kind"], detail: Alert["detail"], summary: string): Alert {
  return {
    alert_id: `id-${kind}`, job: "invoice-extract", kind, summary, detail,
    created_at: "2026-11-17T09:00:00Z", delivered_at: null, delivery_attempts: 0, delivery_failed_at: null, resolved_at: null,
  } as Alert;
}

const NOTICE = alert("MODEL_NOTICE", {
  model: "gemini-2.5-flash", provider: "google", status: "Scheduled", date: "2026-12-01", date_wording: "earliest_possible",
  source: "Google: Gemini deprecations", notice_url: "https://aistudio.google.com/docs/deprecations#gemini-2.5-flash-models",
  checked_at: "2026-11-17T05:15:00Z", informational: true,
}, "Google lists 1 Dec 2026 as the earliest possible shutdown date for gemini-2.5-flash, and says it will give advance notice of the exact date.");

const mount = (a: Alert) => {
  stubApi({});
  return renderWithProviders(<WithProject id="acme"><AlertItemCard item={{ kind: "regression", alert: a, timestamp: a.created_at }} /></WithProject>);
};

describe("a provider notice about a model you use", () => {
  it("says it is information only, in the provider's wording, with the checked-at date", () => {
    mount(NOTICE);
    expect(screen.getByText("Provider notice about a model you use")).toBeInTheDocument();
    expect(screen.getByText("Information only")).toBeInTheDocument();
    expect(screen.getByText(/Google lists 1 Dec 2026 as the earliest possible shutdown date/)).toBeInTheDocument();
    const line = screen.getByText(/gemini-2\.5-flash: Scheduled, earliest possible date/);
    expect(line).toHaveTextContent("Dec 1, 2026");
    expect(line).toHaveTextContent("Checked Nov 17, 2026.");
    expect(line).toHaveTextContent("Checked");
    expect(line).toHaveTextContent("Nothing is changed or switched for you.");
  });

  it("links to the exact section of the provider's own page, opened safely in a new tab", () => {
    mount(NOTICE);
    const link = screen.getByRole("link", { name: "Open the provider's notice ↗" });
    expect(link).toHaveAttribute("href", "https://aistudio.google.com/docs/deprecations#gemini-2.5-flash-models");
    expect(link).toHaveAttribute("target", "_blank");
    expect(link.getAttribute("rel")).toContain("noopener");
  });

  it.each([
    ["not_sooner_than", "not sooner than"], ["tentative", "tentative date"], ["earliest_possible", "earliest possible date"], ["scheduled", "listed date"],
  ])("words a %s date as %s, never as a promise", (wording, expected) => {
    mount(alert("MODEL_NOTICE", { ...NOTICE.detail, date_wording: wording }, "x"));
    expect(screen.getByText(new RegExp(expected))).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/will be shut down on|guaranteed|will retire on/i);
  });

  it("with no date listed it says so, and with no link it shows no link", () => {
    mount(alert("MODEL_NOTICE", { model: "claude-x", status: "Deprecated", date: null, date_wording: "tentative", checked_at: "2026-11-17T05:15:00Z" }, "Anthropic lists claude-x as deprecated and has not given a retirement date."));
    expect(screen.getByText(/claude-x: Deprecated, no date listed\./)).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /provider's notice/ })).toBeNull();
  });

  it("never offers to switch, replace or migrate a model", () => {
    mount(NOTICE);
    expect(screen.queryByRole("button", { name: /switch|replace|migrate|upgrade|apply/i })).toBeNull();
    expect(screen.queryByRole("link", { name: /switch|replace|migrate|upgrade/i })).toBeNull();
  });
});

describe("the usage heads-up", () => {
  const burst = (extra: Record<string, unknown> = {}) => alert("TOKEN_BURST", { tokens_last_hour: 120_000, usual_tokens_per_hour: 20_000, top_job: "invoice-extract", ...extra }, "Usage heads-up: your AI calls used 120,000 tokens in the last hour.");

  it("is titled a heads-up and states its window, comparison and volume floor", () => {
    mount(burst({ window_minutes: 60, baseline_windows: 24, floor_tokens: 50_000 }));
    expect(screen.getByText("Usage heads-up")).toBeInTheDocument();
    const numbers = screen.getByText(/Last hour: 120,000 tokens\. Usual hour: 20,000 tokens\./);
    expect(numbers).toHaveTextContent("Compared over 60-minute windows with the average of the 24 hours before.");
    expect(numbers).toHaveTextContent("Not reported under 50,000 tokens.");
    expect(numbers).toHaveTextContent("A usage heads-up, not a prediction that your provider will limit you.");
  });

  it("an older alert without the rule still reads as a heads-up and promises nothing about limits", () => {
    mount(burst());
    expect(screen.getByText("Usage heads-up")).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/throttl|rate limit will|you will be limited/i);
  });
});
