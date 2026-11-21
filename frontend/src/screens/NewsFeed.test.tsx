import { afterEach, describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders } from "../test/render";
import type { News, NewsRefresh } from "../shared/api/types";
import NewsPage from "./NewsFeed";

afterEach(() => {
  vi.unstubAllGlobals();
});

const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();

const news: News = {
  items: [
    {
      item_id: "n1", source: "Acme Labs", kind: "lab", published_at: hoursAgo(2),
      title: "acme-mini gets a new version", link: "https://example.com/a", summary: "Cheaper input.",
      affects: ["acme-mini"],
    },
    {
      item_id: "n2", source: "Some Blog", kind: "community", published_at: hoursAgo(5),
      title: "Notes on structured output", link: "https://example.com/b", summary: "JSON under load.",
      affects: [],
    },
  ],
  sources: [{ source: "Acme Labs", kind: "lab" }, { source: "Some Blog", kind: "community" }],
  your_models: ["acme-mini"],
  updated_at: hoursAgo(0.25),
  next_refresh_at: hoursAgo(0.25 - 10 / 60),
};

/** A fetch stand-in that answers GET /v1/news and POST /v1/news/refresh, and records every call. */
function stubApi(refresh: NewsRefresh) {
  const calls: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    calls.push(`${init?.method ?? "GET"} ${url}`);
    const body = url.startsWith("/v1/news/refresh") ? refresh : news;
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  }));
  return calls;
}

const fresh: NewsRefresh = {
  refreshed: true, added: 3, failed_sources: [], updated_at: new Date().toISOString(),
  next_refresh_at: new Date(Date.now() + 600_000).toISOString(),
};

describe("NewsPage", () => {
  it("shows the stories, newest first, and the models it watches for", async () => {
    stubApi(fresh);
    renderWithProviders(<NewsPage />);
    expect(await screen.findByRole("link", { name: "acme-mini gets a new version" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Notes on structured output" })).toBeInTheDocument();
    expect(screen.getByText("Watching for")).toBeInTheDocument();
    expect(screen.getByText(/Updated 15 min ago/)).toBeInTheDocument();
  });

  it("asks only for stories about your models when that filter is on", async () => {
    const calls = stubApi(fresh);
    renderWithProviders(<NewsPage />);
    await screen.findByRole("link", { name: "acme-mini gets a new version" });
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Affects my models" }));
    await vi.waitFor(() => expect(calls).toContain("GET /v1/news?mine=true"));
    await user.click(screen.getByRole("button", { name: "Some Blog" }));
    await vi.waitFor(() => expect(calls).toContain("GET /v1/news?source=Some+Blog&mine=true"));
  });

  it("fetches the latest on request and says what came in", async () => {
    const calls = stubApi(fresh);
    renderWithProviders(<NewsPage />);
    await screen.findByRole("link", { name: "acme-mini gets a new version" });
    await userEvent.setup().click(screen.getByRole("button", { name: /Fetch latest/ }));
    expect(await screen.findByText("3 new stories.")).toBeInTheDocument();
    expect(calls).toContain("POST /v1/news/refresh");
  });

  it("explains when a fetch was too soon after the last one", async () => {
    stubApi({ ...fresh, refreshed: false, added: 0 });
    renderWithProviders(<NewsPage />);
    await screen.findByRole("link", { name: "acme-mini gets a new version" });
    await userEvent.setup().click(screen.getByRole("button", { name: /Fetch latest/ }));
    expect(await screen.findByText(/Fetched moments ago. Next fetch from/)).toBeInTheDocument();
  });
});
