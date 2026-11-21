import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import type { NewsItem } from "../../../shared/api/types";
import { NewsCard, timeAgo } from "./NewsCard";

const story: NewsItem = {
  item_id: "n1",
  source: "Acme Labs",
  kind: "lab",
  title: "acme-mini gets a new version",
  link: "https://example.com/acme-mini",
  summary: "Input prices drop by a third.",
  published_at: new Date(Date.now() - 3 * 3_600_000).toISOString(),
  affects: [],
};

describe("NewsCard", () => {
  it("links to the story in a new tab without giving it this page", () => {
    render(<NewsCard item={story} />);
    const link = screen.getByRole("link", { name: "acme-mini gets a new version" });
    expect(link).toHaveAttribute("href", "https://example.com/acme-mini");
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
    expect(screen.getByText("Model maker")).toBeInTheDocument();
    expect(screen.getByText("3 h ago")).toBeInTheDocument();
  });

  it("marks a story that names one of your models", () => {
    render(<NewsCard item={{ ...story, affects: ["acme-mini"] }} />);
    expect(screen.getByText(/Affects your models/)).toBeInTheDocument();
    expect(screen.getByText("acme-mini")).toBeInTheDocument();
  });

  it("says nothing about your models when the story names none", () => {
    render(<NewsCard item={story} />);
    expect(screen.queryByText(/Affects your models/)).not.toBeInTheDocument();
  });
});

describe("timeAgo", () => {
  const now = new Date("2026-11-13T12:00:00Z");
  it.each([
    ["2026-11-13T11:59:30Z", "just now"],
    ["2026-11-13T11:25:00Z", "35 min ago"],
    ["2026-11-13T07:00:00Z", "5 h ago"],
    ["2026-11-10T12:00:00Z", "3 d ago"],
  ])("%s reads as %s", (iso, expected) => {
    expect(timeAgo(iso, now)).toBe(expected);
  });

  it("gives a date for anything older than a week", () => {
    expect(timeAgo("2026-10-01T12:00:00Z", now)).not.toMatch(/ago/);
  });
});
