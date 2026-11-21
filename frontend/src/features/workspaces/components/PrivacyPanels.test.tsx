import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { stubApi } from "../../../test/api";
import { PrivacyNotice, RoleRollup, YourJobRole } from "./PrivacyPanels";

const ORG = "00000000-0000-0000-0000-0000000000aa";
afterEach(() => vi.unstubAllGlobals());

const notice = (over: Record<string, unknown> = {}) => ({
  version: "company-notice-1", min_group_size: 5, acknowledged: false, acknowledged_at: null, required_for_access: false, status_counts: null,
  sections: [{ heading: "What the account records", body: ["Counts, tokens and list-price cost."] }, { heading: "Your acknowledgment", body: ["It is not your consent."] }],
  ...over,
});
const you = { role: "member", job_role: null, job_roles: { engineering: "Engineering", finance: "Finance" }, notice_version: "company-notice-1", notice_acknowledged: false };

function show(routes: Record<string, unknown>, ui: React.ReactNode) {
  const calls = stubApi(routes);
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{ui}</QueryClientProvider>);
  return calls;
}

describe("privacy notice", () => {
  it("shows what is recorded, says acknowledging is not a consent, and records it on request", async () => {
    const calls = show({ [`/v1/organisations/${ORG}/notice`]: notice() }, <PrivacyNotice orgId={ORG} />);
    expect(await screen.findByText("What the account records")).toBeInTheDocument();
    expect(screen.getByText(/It is not a consent, and nothing depends on it/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "I have read this" }));
    expect(calls.some((c) => c.startsWith("POST") && c.includes("/notice/ack"))).toBe(true);
  });

  it("shows the state once acknowledged, and counts but no names to admins", async () => {
    show({ [`/v1/organisations/${ORG}/notice`]: notice({ acknowledged: true, acknowledged_at: "2026-11-18T10:00:00Z", status_counts: { acknowledged: 2, members: 5 } }) }, <PrivacyNotice orgId={ORG} />);
    expect(await screen.findByText(/You were shown this/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "I have read this" })).toBeNull();
    expect(screen.getByText(/2 of 5 members have acknowledged this version. Counts only, never names./)).toBeInTheDocument();
  });
});

describe("your job role", () => {
  it("is optional, self-chosen and says it is never used to judge anyone", async () => {
    const calls = show({ [`/v1/organisations/${ORG}/me`]: you, [`/v1/organisations/${ORG}/notice`]: notice() }, <YourJobRole orgId={ORG} />);
    expect(await screen.findByText(/never used for access, budgets or judging anyone/)).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Prefer not to say" })).toBeInTheDocument();
    await userEvent.selectOptions(screen.getByLabelText(/What kind of work/), "finance");
    expect(calls.some((c) => c.startsWith("PUT") && c.includes("/me/job-role"))).toBe(true);
  });
});

describe("role groups", () => {
  const base = { min_group_size: 5, members: 3, shown: false, groups: [], not_shown: 3, reason: "A breakdown appears once the company has at least 5 members. 5 is our own design choice, not a standard.", usage_by_role: null, usage_by_role_note: "Usage or cost by role is not available." };
  it("explains the threshold and shows no groups for a small company", async () => {
    show({ [`/v1/organisations/${ORG}/rollups`]: base }, <RoleRollup orgId={ORG} />);
    expect(await screen.findByText(/5 is our own design choice, not a standard/)).toBeInTheDocument();
    expect(screen.queryByText(/d+ members$/)).toBeNull();
    expect(screen.getByText("Usage or cost by role is not available.")).toBeInTheDocument();
  });
  it("shows only the large group and lumps everyone else together", async () => {
    show({ [`/v1/organisations/${ORG}/rollups`]: { ...base, members: 8, shown: true, groups: [{ job_role: "engineering", label: "Engineering", members: 5 }], not_shown: 3 } }, <RoleRollup orgId={ORG} />);
    expect(await screen.findByText("Engineering")).toBeInTheDocument();
    expect(screen.getByText("Everyone else (small groups, or no role chosen)")).toBeInTheDocument();
    expect(screen.queryByText("Finance")).toBeNull();
  });
});
