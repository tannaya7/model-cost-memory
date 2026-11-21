/** The Model notices section: what the providers' own pages say about the models in use, where each came from and when it
 * was checked. Information only; nothing leaves the app unless the owner opts in. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders } from "../test/render";
import { WithProject } from "../app/project";
import type { Project } from "../shared/api/types";
import type { Notices } from "../features/notices/api/noticesApi";
import { ModelNoticesSection } from "./Settings";

afterEach(() => {
  localStorage.clear();
  vi.unstubAllGlobals();
});

const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
const CHECKED = "2026-11-17T05:15:00Z";

const source = (over: Partial<Notices["sources"][number]> = {}): Notices["sources"][number] => ({
  source_id: "anthropic", name: "Anthropic: Model deprecations", provider: "anthropic", url: "https://platform.claude.com/docs/en/about-claude/model-deprecations",
  status: "OK", last_checked_at: CHECKED, last_ok_at: CHECKED, detail: null, notice_count: 25, stale: false,
  covers: "Applies to Anthropic-operated platforms. Amazon Bedrock and Google-managed Google Cloud set their own retirement schedules, so their dates can differ.", ...over,
});

const notice = (over: Partial<Notices["notices"][number]> = {}): Notices["notices"][number] => ({
  notice_id: "n1", provider: "anthropic", provider_name: "Anthropic", model: "claude-sonnet-4-5-20250929", status: "Deprecated", listed_date: "2026-11-30",
  date_wording: "tentative", deprecated_on: "2026-09-30", replacement: "claude-sonnet-5-5", section: "2026-09-30: Claude Sonnet 4.5 model",
  notice_url: "https://platform.claude.com/docs/en/about-claude/model-deprecations#2026-09-30-claude-sonnet-4-5-model", source_name: "Anthropic: Model deprecations",
  checked_at: CHECKED, text: "Anthropic lists a tentative retirement date of 30 Nov 2026 for claude-sonnet-4-5-20250929.", served_by_known: true, stale_note: null, informational: true, ...over,
});

const answer = (over: Partial<Notices> = {}): Notices => ({
  notices: [notice()], hosted_elsewhere: [], sources: [source(), source({ source_id: "google", name: "Google: Gemini deprecations", url: "https://aistudio.google.com/docs/deprecations", covers: "Applies to the Gemini API." }), source({ source_id: "openai", name: "OpenAI: Deprecations", url: "https://developers.openai.com/api/docs/deprecations", covers: "Applies to the OpenAI API." })],
  note: "Notices are information only.", ...over,
});

function mount(body: unknown, project: Partial<Project> = {}, status = 200) {
  const patches: Array<Record<string, unknown>> = [];
  const p = { project_id: "acme", name: "Acme", slug: "acme", webhook_url: null, notice_alert_webhook: false, ...project } as unknown as Project;
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (url.startsWith("/v1/notices")) return json(body, status);
    if (url.startsWith("/v1/projects/acme")) {
      if (init?.method === "PATCH") {
        const b = JSON.parse(String(init.body));
        patches.push(b);
        Object.assign(p, b);
      }
      return json({ ...p });
    }
    return json([]);
  }));
  renderWithProviders(<WithProject id="acme"><ModelNoticesSection project={p} /></WithProject>);
  return { patches };
}

describe("what is shown for a model in use", () => {
  it("shows the model, the provider's own status and sentence, the checked date and the exact link", async () => {
    mount(answer());
    const list = await screen.findByTestId("notice-list");
    expect(list).toHaveTextContent("claude-sonnet-4-5-20250929");
    expect(list).toHaveTextContent("Deprecated");
    expect(list).toHaveTextContent("Information only");
    expect(list).toHaveTextContent("Anthropic lists a tentative retirement date of 30 Nov 2026 for claude-sonnet-4-5-20250929.");
    expect(list).toHaveTextContent("Checked 17 Nov 2026 on Anthropic: Model deprecations.");
    const link = screen.getByRole("link", { name: "Open the provider's notice ↗" });
    expect(link).toHaveAttribute("href", "https://platform.claude.com/docs/en/about-claude/model-deprecations#2026-09-30-claude-sonnet-4-5-model");
    expect(link).toHaveAttribute("target", "_blank");
    expect(link.getAttribute("rel")).toContain("noopener");
  });

  it("shows the provider's suggested replacement as information and offers no way to switch", async () => {
    mount(answer());
    expect(await screen.findByText("The provider lists claude-sonnet-5-5 as a replacement. We change nothing.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /switch|replace|migrate|upgrade/i })).toBeNull();
  });

  it("says when it could not tell where the calls are served, because a partner platform may differ", async () => {
    mount(answer({ notices: [notice({ served_by_known: false })] }));
    expect(await screen.findByText("We could not tell where your calls are served. If you use a partner platform, its dates may differ.")).toBeInTheDocument();
  });

  it("says how old a reading is when it is more than a week old", async () => {
    mount(answer({ notices: [notice({ stale_note: "This source was last read 10 days ago." })], sources: [source({ stale: true, last_ok_at: "2026-11-07T05:15:00Z" }), source({ source_id: "google", name: "G", url: "https://aistudio.google.com/docs/deprecations" })] }));
    expect(await screen.findByText(/This source was last read 10 days ago\./)).toBeInTheDocument();
    expect(screen.getByTestId("notice-sources")).toHaveTextContent("Read 7 Nov 2026. This reading is more than 7 days old.");
  });

  it("lists notices that are not applied because the calls name another host", async () => {
    mount(answer({ notices: [], hosted_elsewhere: [{ model: "claude-sonnet-4-5-20250929", provider_name: "Anthropic", notice_url: "https://x" }] }));
    expect(await screen.findByTestId("elsewhere")).toHaveTextContent("Not applied: 1 notice is about a provider's own API, but your calls for claude-sonnet-4-5-20250929 name another host, which sets its own dates.");
  });
});

describe("empty, missing and broken sources are never a blank box", () => {
  it("no notice for any model in use says so", async () => {
    mount(answer({ notices: [] }));
    expect(await screen.findByTestId("no-notices")).toHaveTextContent("No provider notice mentions a model you used in the last 30 days.");
  });

  it("sources never read say nothing was checked, instead of 'no notices'", async () => {
    mount(answer({ notices: [], sources: [source({ status: "NEVER", last_ok_at: null, last_checked_at: null, notice_count: 0 })] }));
    expect(await screen.findByTestId("no-notices")).toHaveTextContent("We have not read the providers' pages yet, so there is nothing to show. This is checked once a day.");
    expect(screen.getByTestId("notice-sources")).toHaveTextContent("Not read yet.");
  });

  it("an unreadable or unreachable source is named with its last good reading", async () => {
    mount(answer({ sources: [source({ status: "UNREADABLE" }), source({ source_id: "google", name: "Google: Gemini deprecations", status: "FETCH_FAILED", last_ok_at: null, url: "https://aistudio.google.com/docs/deprecations" })] }));
    const sources = await screen.findByTestId("notice-sources");
    expect(sources).toHaveTextContent("Could not be read (its layout may have changed). Last good reading 17 Nov 2026.");
    expect(sources).toHaveTextContent("Could not be fetched.");
  });

  it("each source links to the provider's own page and says what it does not cover", async () => {
    mount(answer());
    const sources = await screen.findByTestId("notice-sources");
    expect(screen.getByRole("link", { name: "Anthropic: Model deprecations" })).toHaveAttribute("href", "https://platform.claude.com/docs/en/about-claude/model-deprecations");
    expect(sources).toHaveTextContent("Amazon Bedrock and Google-managed Google Cloud set their own retirement schedules, so their dates can differ.");
  });

  it("an answer that cannot be loaded says so", async () => {
    mount({ detail: "boom" }, {}, 500);
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not load the notices. Try again in a moment.");
  });

  it("an unreadable answer (not a notices object) is treated as a failure, not as no notices", async () => {
    mount([]);
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not load the notices.");
  });
});

describe("leaving the app is opt-in", () => {
  it("the webhook choice is off and disabled, with the reason, until a webhook address exists", async () => {
    mount(answer());
    const box = await screen.findByRole("checkbox", { name: /Also send model notices to my webhook/ });
    expect(box).toBeDisabled();
    expect(box).not.toBeChecked();
    expect(screen.getByText("Add a webhook address in Alerts first, then you can turn this on.")).toBeInTheDocument();
  });

  it("a webhook address alone turns nothing on, and says notices are always in the app", async () => {
    mount(answer(), { webhook_url: "https://hooks.example.com/abc" });
    const box = await screen.findByRole("checkbox", { name: /Also send model notices to my webhook/ });
    expect(box).toBeEnabled();
    expect(box).not.toBeChecked();
    expect(screen.getByText("They would be posted to hooks.example.com. Off by default. Notices are always shown in the app.")).toBeInTheDocument();
  });

  it("turning it on shows where it goes and what is sent first, and sends nothing until confirmed", async () => {
    const { patches } = mount(answer(), { webhook_url: "https://hooks.example.com/abc" });
    const user = userEvent.setup();
    await user.click(await screen.findByRole("checkbox", { name: /Also send model notices to my webhook/ }));
    expect(screen.getByText(/Model notices \(the model, the provider's date and a link to its page, no prompt text\) will also be posted to hooks\.example\.com\./)).toBeInTheDocument();
    expect(patches).toHaveLength(0);
    await user.click(screen.getByRole("button", { name: "Send notices there" }));
    await waitFor(() => expect(patches).toEqual([{ notice_alert_webhook: true }]));
  });

  it("'Keep them in the app only' changes nothing", async () => {
    const { patches } = mount(answer(), { webhook_url: "https://hooks.example.com/abc" });
    const user = userEvent.setup();
    await user.click(await screen.findByRole("checkbox", { name: /Also send model notices to my webhook/ }));
    await user.click(screen.getByRole("button", { name: "Keep them in the app only" }));
    expect(screen.getByRole("checkbox", { name: /Also send model notices to my webhook/ })).not.toBeChecked();
    expect(patches).toHaveLength(0);
  });

  it("turning it off needs no review", async () => {
    const { patches } = mount(answer(), { webhook_url: "https://hooks.example.com/abc", notice_alert_webhook: true });
    const user = userEvent.setup();
    await user.click(await screen.findByRole("checkbox", { name: /Also send model notices to my webhook/ }));
    expect(screen.queryByText(/will also be posted to/)).toBeNull();
    await user.click(screen.getByRole("button", { name: "Apply" }));
    await waitFor(() => expect(patches).toEqual([{ notice_alert_webhook: false }]));
  });
});
