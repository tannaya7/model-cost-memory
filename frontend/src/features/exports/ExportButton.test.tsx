import { afterEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders } from "../../test/render";
import { ExportButton, exportNote } from "./ExportButton";

afterEach(() => vi.unstubAllGlobals());

function csv(rows: number, neutralized: number, status = 200) {
  const headers = { "content-type": "text/csv", "content-disposition": 'attachment; filename="model-cost-memory-acme-last-30-days.csv"', "x-export-rows": String(rows), "x-export-neutralized": String(neutralized) };
  return status === 200 ? new Response("day,ai_task\r\n", { status, headers }) : new Response(JSON.stringify({ detail: "Only an admin or owner can export data" }), { status, headers: { "content-type": "application/json" } });
}

function stub(response: Response) {
  const calls: Array<{ url: string; headers: Headers }> = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, headers: new Headers(init?.headers) });
    return response;
  }));
  const saved: string[] = [];
  const create = vi.fn(() => "blob:test");
  vi.stubGlobal("URL", { ...URL, createObjectURL: create, revokeObjectURL: vi.fn() });
  const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) { saved.push(this.download); });
  return { calls, saved, create, click };
}

describe("what the page says about the file", () => {
  it("says how many rows, for what, and that it holds no prompts or keys", () => {
    const note = exportNote(1200, 0, "the last 30 days");
    expect(note).toContain("Saved 1,200 rows for the last 30 days.");
    expect(note).toContain("Each row says its period, units and how the cost was worked out.");
    expect(note).toContain("never prompts, answers or keys");
    expect(note).not.toContain("formula");
  });

  it("explains the apostrophes only when there were some, in plain words", () => {
    const one = exportNote(5, 1, "the last 7 days");
    expect(one).toContain("1 text value began with = + - or @, which a spreadsheet can run as a formula, so a ' was added in front of it. Numbers were not changed.");
    const many = exportNote(5, 3, "the last 7 days");
    expect(many).toContain("3 text values began with = + - or @");
    expect(many).toContain("in front of each");
  });

  it("says an empty file is empty, and still names the columns", () => {
    expect(exportNote(0, 0, "this filter")).toContain("The file has no rows for this filter, only its column names.");
    expect(exportNote(1, 0, "x")).toContain("Saved 1 row ");
  });
});

describe("the export button", () => {
  it("asks the server for exactly the period, saves the file under the server's name, and reports what was in it", async () => {
    const { calls, saved } = stub(csv(42, 2));
    renderWithProviders(<ExportButton path="/v1/insights/export.csv?days=30" what="the last 30 days" />);
    await userEvent.click(screen.getByRole("button", { name: /Export/ }));
    const status = await screen.findByText(/Saved 42 rows for the last 30 days/);
    expect(calls[0].url).toBe("/v1/insights/export.csv?days=30");
    expect(saved).toEqual(["model-cost-memory-acme-last-30-days.csv"]);
    expect(status).toHaveTextContent("2 text values began with = + - or @");
    expect(status.closest('[role="status"]')).toBeInTheDocument(); // read out by a screen reader
  });

  it("shows the reason, in words, when the role is not allowed, and saves nothing", async () => {
    const { saved } = stub(csv(0, 0, 403));
    renderWithProviders(<ExportButton path="/v1/insights/export.csv" what="x" />);
    await userEvent.click(screen.getByRole("button", { name: /Export/ }));
    expect(await screen.findByText("Your role does not allow this: Only an admin or owner can export data")).toBeInTheDocument();
    expect(saved).toEqual([]);
  });

  it("shows a failure plainly and can be tried again", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ detail: "The server is busy" }), { status: 500, headers: { "content-type": "application/json" } })));
    renderWithProviders(<ExportButton path="/v1/insights/export.csv" what="x" />);
    await userEvent.click(screen.getByRole("button", { name: /Export/ }));
    expect(await screen.findByText("Could not make the file: The server is busy")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Export/ })).toBeEnabled();
  });

  it("is off when there is nothing to export and says why in its title", () => {
    renderWithProviders(<ExportButton path="/x" what="x" disabled title="No AI calls recorded in this period, so there is nothing to download" />);
    const button = screen.getByRole("button", { name: /Export/ });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("title", expect.stringContaining("nothing to download"));
  });

  it("is a real button that works from the keyboard and tells the person it is busy", async () => {
    stub(csv(3, 0));
    renderWithProviders(<ExportButton path="/x" what="the last 7 days" />);
    const button = screen.getByRole("button", { name: /Export/ });
    button.focus();
    await userEvent.keyboard("{Enter}");
    await waitFor(() => expect(screen.getByText(/Saved 3 rows/)).toBeInTheDocument());
  });
});
