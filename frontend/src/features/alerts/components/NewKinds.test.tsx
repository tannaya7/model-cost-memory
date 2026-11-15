import { afterEach, describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import { renderWithProviders } from "../../../test/render";
import { stubApi } from "../../../test/api";
import type { Alert } from "../../../shared/api/types";
import { WithProject } from "../../../app/project";
import Overview from "../../../screens/Overview";
import { AlertItemCard } from "./AlertItemCard";

afterEach(() => {
  localStorage.clear();
  vi.unstubAllGlobals();
});

function alert(kind: Alert["kind"], detail: Alert["detail"], summary: string, job = ""): Alert {
  return {
    alert_id: `id-${kind}`, job, kind, summary, detail,
    created_at: "2026-11-10T09:00:00Z", delivered_at: null, delivery_attempts: 0, delivery_failed_at: null, resolved_at: null,
  } as Alert;
}

const cases: { a: Alert; title: string; numbers: RegExp; href: string }[] = [
  {
    a: alert("TOKEN_BURST", { tokens_last_hour: 62000, usual_tokens_per_hour: 18000, top_job: "invoice-extract", top_job_tokens: 50000 }, "AI use is far above normal.", "invoice-extract"),
    title: "Unusually high AI use",
    numbers: /Last hour: 62,000 tokens\. Usual hour: 18,000 tokens\./,
    href: "/p/acme/jobs/invoice-extract?tab=tokens",
  },
  {
    a: alert("BUDGET", { level: "85", spent_usd: 425, budget_usd: 500, projected_usd: 560 }, "You have used 85% of your limit."),
    title: "Spending limit warning",
    numbers: /Spent \$425 of your \$500 limit\./,
    href: "/p/acme/settings#budget",
  },
  {
    a: alert("TRIAL_BUDGET", { level: "95", cap_usd: 20, spent_usd: 19 }, "Trials are nearly at their cap."),
    title: "Trial budget warning",
    numbers: /Spent \$19 of your \$20 trial budget\./,
    href: "/p/acme/settings#retests",
  },
  {
    a: alert("MODEL_RETIRING", { model: "acme-old", status: "DEPRECATED", shutdown_date: "2027-03-01" }, "acme-old is being shut down."),
    title: "A model is being shut down",
    numbers: /Shutdown not before .*2027/,
    href: "/p/acme/models",
  },
];

describe("alerts about use and spending", () => {
  it.each(cases)("shows $title with its numbers and link", ({ a, title, numbers, href }) => {
    renderWithProviders(<WithProject id="acme"><AlertItemCard item={{ kind: "regression", alert: a, timestamp: a.created_at }} /></WithProject>);
    expect(screen.getByText(title)).toBeInTheDocument();
    expect(screen.getByText(a.summary)).toBeInTheDocument();
    expect(screen.getByText(numbers)).toBeInTheDocument();
    expect(screen.getAllByRole("link").some((l) => l.getAttribute("href") === href)).toBe(true);
    expect(screen.getByRole("button", { name: "Mark resolved" })).toBeInTheDocument();
  });

  it("lists an open new-kind alert under Needs your attention on the Overview", async () => {
    stubApi({
      "/v1/alerts": [cases[1].a],
      "/v1/news": { items: [], sources: [], your_models: [], updated_at: null, next_refresh_at: null },
    });
    renderWithProviders(<WithProject id="acme"><Overview /></WithProject>);
    expect(await screen.findByText("Spending limit warning")).toBeInTheDocument();
  });
});
