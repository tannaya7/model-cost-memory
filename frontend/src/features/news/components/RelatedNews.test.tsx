import { afterEach, describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import { renderWithProviders } from "../../../test/render";
import type { News, NewsItem } from "../../../shared/api/types";
import { RelatedNews } from "./RelatedNews";

afterEach(() => {
  vi.unstubAllGlobals();
});

const story: NewsItem = {
  item_id: "n1", source: "Acme Labs", kind: "lab", title: "acme-mini changes its safety tuning",
  link: "https://example.com/tuning", summary: "", published_at: new Date().toISOString(),
  affects: ["acme-mini"],
};

function answer(items: NewsItem[]) {
  const urls: string[] = [];
  const body: News = { items, sources: [], your_models: ["acme-mini"], updated_at: null, next_refresh_at: null };
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    urls.push(url);
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  }));
  return urls;
}

describe("RelatedNews", () => {
  it("lists the stories about the model asked for, with the request scoped to it", async () => {
    const urls = answer([story]);
    renderWithProviders(<RelatedNews title="In the news around this alert" filters={{ model: "acme-mini" }} />);
    expect(await screen.findByRole("link", { name: "acme-mini changes its safety tuning" })).toHaveAttribute(
      "href", "https://example.com/tuning",
    );
    expect(screen.getByText("In the news around this alert")).toBeInTheDocument();
    expect(urls[0]).toBe("/v1/news?model=acme-mini&limit=3");
  });

  it("shows nothing at all when no story matches", async () => {
    const urls = answer([]);
    const { container } = renderWithProviders(<RelatedNews filters={{ model: "acme-mini" }} />);
    await vi.waitFor(() => expect(urls).toHaveLength(1));
    expect(container).toBeEmptyDOMElement();
  });

  it("says so where the section always shows", async () => {
    answer([]);
    renderWithProviders(<RelatedNews filters={{ job: "invoice" }} emptyText="No story names this job's models." />);
    expect(await screen.findByText("No story names this job's models.")).toBeInTheDocument();
  });
});
