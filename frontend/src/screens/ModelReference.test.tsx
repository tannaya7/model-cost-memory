/** The Models screen's reference facts: where a price comes from, when it was read, links to the makers' own pages only, the
 * maker's own words as an official claim (not a measurement), and no benchmark, ranking or sponsorship anywhere. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import { WithProject } from "../app/project";
import { renderWithProviders } from "../test/render";
import type { Model } from "../shared/api/types";
import { MODEL_CATALOG } from "./compare/profile/modelCatalog";
import Models from "./Models";
import { AsOfLine, MakerLinks, PriceCheck, ProviderSays, WhereFrom, type ModelsMeta } from "./ModelReference";

afterEach(() => {
  localStorage.clear();
  vi.unstubAllGlobals();
});

type Ref = NonNullable<Model["reference"]>;
const ref = (over: Partial<Ref> = {}): Ref => ({
  kind: "api_model", maker: "Anthropic", docs_url: "https://platform.claude.com/docs/en/models/overview",
  pricing_url: "https://platform.claude.com/docs/en/about-claude/pricing", deprecations_url: "https://platform.claude.com/docs/en/about-claude/model-deprecations",
  price_check: "confirmed", price_check_note: "The maker's pricing page states the same price.", price_checked_at: "2026-11-18T05:15:00Z", price_check_stale: false,
  official_input_per_mtok: 4, official_output_per_mtok: 20, price_basis: "List price in US dollars per million tokens, standard rate for text.",
  catalog_source: "LiteLLM community price list (not the provider)", catalog_synced_at: "2026-11-18T05:00:00Z", ...over,
});

describe("the check against the maker's own page", () => {
  it("confirmed says so with the date it was read", () => {
    render(<PriceCheck reference={ref()} />);
    expect(screen.getByTestId("price-check")).toHaveTextContent("✓ Matches the maker's page");
    expect(screen.getByTestId("price-check")).toHaveTextContent("Read 18 Nov 2026");
  });

  it("a different price shows the maker's numbers, in words and a mark, not colour alone", () => {
    render(<PriceCheck reference={ref({ price_check: "differs", official_input_per_mtok: 2, official_output_per_mtok: 10 })} />);
    expect(screen.getByTestId("price-check")).toHaveTextContent("≠ The maker's page says $2.00 in, $10.00 out");
  });

  it.each([
    ["not_readable", "The maker's page gives no single price"],
    ["not_listed", "Not on the maker's pricing page"],
    ["other_host", "Sold by a partner; may differ from the maker's price"],
    ["not_checked", "Not confirmed against the maker's page"],
  ] as const)("%s is shown as unknown, never as a confirmed or guessed price", (state, text) => {
    render(<PriceCheck reference={ref({ price_check: state, official_input_per_mtok: null, official_output_per_mtok: null, price_checked_at: state === "other_host" ? null : "2026-11-18T05:15:00Z" })} />);
    const box = screen.getByTestId("price-check");
    expect(box).toHaveTextContent(`? ${text}`);
    expect(box).not.toHaveTextContent("Matches");
  });

  it("an old reading says how old", () => {
    render(<PriceCheck reference={ref({ price_check_stale: true })} />);
    expect(screen.getByTestId("price-check")).toHaveTextContent("Read 18 Nov 2026, more than 7 days ago");
  });

  it("an answer without a reference reads as not confirmed, never as confirmed", () => {
    render(<PriceCheck reference={undefined} />);
    expect(screen.getByText("Not confirmed against the maker's page")).toBeInTheDocument();
  });

  it("the note is available on hover for each state", () => {
    render(<PriceCheck reference={ref({ price_check: "not_readable", price_check_note: "the page lists more than one price" })} />);
    expect(screen.getByTestId("price-check")).toHaveAttribute("title", "the page lists more than one price");
  });
});

describe("links go only to the makers' own pages and open safely", () => {
  it("shows docs, pricing and retirement links, each named for its maker and model, in a new tab with no opener", () => {
    render(<MakerLinks model="claude-opus-5-5" reference={ref()} />);
    const links = screen.getAllByRole("link");
    expect(links.map((l) => l.textContent)).toEqual(["Docs ↗", "Pricing ↗", "Retirement ↗"]);
    for (const l of links) {
      expect(l).toHaveAttribute("target", "_blank");
      expect(l.getAttribute("rel")).toContain("noopener");
      expect(l.getAttribute("aria-label")).toMatch(/^Anthropic's .* page for claude-opus-5-5 \(opens in a new tab\)$/);
      const u = new URL(l.getAttribute("href")!);
      expect(u.protocol).toBe("https:");
      expect(["platform.claude.com", "aistudio.google.com", "developers.openai.com"]).toContain(u.hostname);
      expect(u.search).toBe("");
    }
  });

  it("with no maker page read (a partner, another provider or an old answer) it links nowhere and says so", () => {
    for (const r of [ref({ maker: null, docs_url: null, pricing_url: null, deprecations_url: null, price_check: "other_host" }), undefined]) {
      const { unmount } = render(<MakerLinks model="x" reference={r} />);
      expect(screen.getByTestId("no-links")).toHaveTextContent("No official page linked");
      expect(screen.queryAllByRole("link")).toHaveLength(0);
      unmount();
    }
  });

  it("a link with no address is left out, not shown dead", () => {
    render(<MakerLinks model="m" reference={ref({ deprecations_url: null })} />);
    expect(screen.getAllByRole("link")).toHaveLength(2);
  });
});

describe("the maker's own words are an official claim, dated, never a measurement", () => {
  it("shows the family's words in quotes with the date they were read", () => {
    render(<ProviderSays model="claude-haiku-5-5" />);
    const t = screen.getByTestId("provider-says");
    expect(t).toHaveTextContent("Anthropic says: “high-volume, latency-sensitive tasks such as classification, extraction, and routing”");
    expect(t).toHaveTextContent("its own words, read 13 Nov 2026");
    expect(t).toHaveTextContent("Not a measurement");
  });

  it("a model we hold no words for shows nothing, not an invented description", () => {
    const { container } = render(<ProviderSays model="some-unknown-model" />);
    expect(container).toBeEmptyDOMElement();
  });

  it("every family has its words, a date, and an official https address on a maker's host", () => {
    for (const e of MODEL_CATALOG) {
      expect(e.providerSays.trim().length).toBeGreaterThan(10);
      expect(e.asOf).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      const u = new URL(e.officialUrl);
      expect(u.protocol).toBe("https:");
      expect(["platform.claude.com", "aistudio.google.com", "developers.openai.com"]).toContain(u.hostname);
    }
  });
});

describe("the 'as of' line", () => {
  const meta = (over: Partial<ModelsMeta> = {}): ModelsMeta => ({
    catalog: { source: "LiteLLM community price list (not the provider)", last_synced_at: "2026-11-18T05:00:00Z", note: "Prices come from a community-maintained list and refresh daily." },
    official_sources: [
      { source_id: "anthropic", name: "Anthropic: Pricing", provider: "anthropic", url: "https://platform.claude.com/docs/en/about-claude/pricing", status: "OK", last_checked_at: "2026-11-18T05:15:00Z", last_ok_at: "2026-11-18T05:15:00Z", stale: false },
      { source_id: "openai", name: "OpenAI: Pricing", provider: "openai", url: "https://developers.openai.com/api/docs/pricing", status: "FETCH_FAILED", last_checked_at: "2026-11-18T05:15:00Z", last_ok_at: null, stale: false },
    ], ...over,
  });

  it("says where prices come from, when they were last confirmed, and when each maker's page was read", () => {
    render(<AsOfLine meta={meta()} />);
    const t = screen.getByTestId("as-of");
    expect(t).toHaveTextContent("Prices come from the LiteLLM community price list (not the provider), last confirmed 18 Nov 2026.");
    expect(t).toHaveTextContent("Anthropic read 18 Nov 2026");
    expect(t).toHaveTextContent("OpenAI could not be fetched");
  });

  it("flags an old reading", () => {
    render(<AsOfLine meta={meta({ official_sources: [{ source_id: "anthropic", name: "A", provider: "anthropic", url: "https://platform.claude.com/x", status: "OK", last_checked_at: "2026-11-01T00:00:00Z", last_ok_at: "2026-11-01T00:00:00Z", stale: true }] })} />);
    expect(screen.getByTestId("as-of")).toHaveTextContent("read 1 Nov 2026 (older than 7 days)");
  });

  it("before any page has been read it says nothing is confirmed, and with no catalog date it says not confirmed yet", () => {
    render(<AsOfLine meta={meta({ official_sources: [], catalog: { source: "LiteLLM community price list (not the provider)", last_synced_at: null, note: "" } })} />);
    const t = screen.getByTestId("as-of");
    expect(t).toHaveTextContent("not confirmed yet");
    expect(t).toHaveTextContent("have not been read yet, so no price is confirmed against them");
  });

  it("with no information at all it still says something true", () => {
    render(<AsOfLine meta={undefined} />);
    expect(screen.getByTestId("as-of")).toHaveTextContent("where each number comes from");
  });
});

describe("what the page says it is not", () => {
  it("says it is not a performance claim, not a benchmark, not an app list and not sponsored", () => {
    render(<WhereFrom meta={undefined} />);
    const t = screen.getByTestId("where-from");
    expect(t).toHaveTextContent("It is not how a model performs on your work");
    expect(t).toHaveTextContent("No public benchmark is shown, and none predicts quality on your work");
    expect(t).toHaveTextContent("Coding tools and subscription apps, such as Cursor or Copilot, are not API endpoints, so they are not listed or ranked here");
    expect(t).toHaveTextContent("Nothing here is sponsored, and no link earns anything");
  });
});

describe("the whole Models page", () => {
  const item = (model: string, provider: string, reference: Ref | undefined, extra: Record<string, unknown> = {}) => ({
    model, model_version: model, provider, status: "ACTIVE", shutdown_date: null, price_in_per_mtok: 4, price_out_per_mtok: 20, source: "SYNC",
    first_seen_at: "2026-09-01T00:00:00Z", used_by_project: true, reference, ...extra,
  });
  const page = (items: unknown[]) => ({
    items, next_cursor: null,
    catalog: { source: "LiteLLM community price list (not the provider)", last_synced_at: "2026-11-18T05:00:00Z", note: "Prices come from a community-maintained list and refresh daily." },
    official_sources: [{ source_id: "anthropic", name: "Anthropic: Pricing", provider: "anthropic", url: "https://platform.claude.com/docs/en/about-claude/pricing", status: "OK", last_checked_at: "2026-11-18T05:15:00Z", last_ok_at: "2026-11-18T05:15:00Z", detail: null, model_count: 18, stale: false }],
    kind_note: "This is a list of API models you can call. Coding tools and subscription apps, such as Cursor or Copilot, are not API endpoints, so they are not listed or ranked here.",
  });

  function mount(items: unknown[]) {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => new Response(JSON.stringify(url.startsWith("/v1/models") ? page(items) : []), { status: 200, headers: { "content-type": "application/json" } })));
    return renderWithProviders(<WithProject id="acme"><Models /></WithProject>);
  }

  it("each row shows its check, its maker's links and its dated source, unknown shown as unknown", async () => {
    mount([
      item("claude-opus-5-5", "anthropic", ref()),
      item("claude-haiku-5-5", "anthropic", ref({ price_check: "not_readable", official_input_per_mtok: null, official_output_per_mtok: null })),
      item("llama-3.1-70b", "groq", ref({ maker: null, docs_url: null, pricing_url: null, deprecations_url: null, price_check: "other_host", price_checked_at: null })),
      item("my-local", "ollama", ref({ maker: null, docs_url: null, pricing_url: null, deprecations_url: null, price_check: "not_checked", price_checked_at: null, catalog_source: "Entered by hand" }), { source: "MANUAL" }),
    ]);
    await waitFor(() => expect(screen.getByTestId("as-of")).toHaveTextContent("last confirmed 18 Nov 2026"));
    const rows = (await screen.findAllByText("claude-opus-5-5", { selector: "td *, td" }))[0].closest("tr")!;
    expect(within(rows).getByTestId("price-check")).toHaveTextContent("✓ Matches the maker's page");
    expect(within(rows).getAllByRole("link").length).toBe(3);
    const haiku = screen.getAllByText("claude-haiku-5-5", { selector: "td *, td" })[0].closest("tr")!;
    expect(within(haiku).getByTestId("price-check")).toHaveTextContent("The maker's page gives no single price");
    const llama = screen.getAllByText("llama-3.1-70b", { selector: "td *, td" })[0].closest("tr")!;
    expect(within(llama).getByTestId("no-links")).toBeInTheDocument();
    expect(within(llama).getByTestId("price-check")).toHaveTextContent("Sold by a partner");
  });

  it("shows no benchmark, leaderboard, rank, score, 'best' or sponsored wording as a claim, and no link off the makers' own hosts", async () => {
    mount([item("claude-opus-5-5", "anthropic", ref()), item("gpt-6-luna", "openai", ref({ maker: "OpenAI", docs_url: "https://developers.openai.com/api/docs/models", pricing_url: "https://developers.openai.com/api/docs/pricing", deprecations_url: "https://developers.openai.com/api/docs/deprecations" }))]);
    await waitFor(() => expect(screen.getByTestId("as-of")).toHaveTextContent("last confirmed 18 Nov 2026"));
    expect((await screen.findAllByText("gpt-6-luna", { selector: "td *, td" })).length).toBeGreaterThan(0); // the rows have loaded
    const text = document.body.textContent ?? "";
    expect(text).not.toMatch(/leaderboard|\branked?\b(?! here)|\bscore\b|best model|top model|#1|sponsored by|partner link|affiliate/i);
    expect(text.match(/benchmark/gi)?.length ?? 0).toBeLessThanOrEqual(2); // only inside the sentences that say none is shown
    for (const a of Array.from(document.querySelectorAll("a[target=_blank]"))) {
      const u = new URL(a.getAttribute("href")!);
      expect(["platform.claude.com", "aistudio.google.com", "developers.openai.com"]).toContain(u.hostname);
      expect(a.getAttribute("rel")).toContain("noopener");
    }
  });

  it("an older answer with no reference still renders, every price reads not confirmed", async () => {
    mount([item("claude-opus-5-5", "anthropic", undefined)]);
    expect(await screen.findAllByText("Not confirmed against the maker's page")).not.toHaveLength(0);
    expect(screen.queryByText(/Matches the maker's page/)).toBeNull();
  });
});
