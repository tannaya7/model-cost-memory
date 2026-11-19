/** Keyboard, names and zoom: the parts of accessibility that can be checked without a browser. Real contrast, reflow at 400% zoom and a screen
 *  reader need a browser and a person; the browser pass and its limits are in the report, not claimed here. */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders } from "../test/render";
import { WithProject } from "../app/project";
import { Tour } from "../features/guide/Tour";
import { Shell, type ShellProps } from "../screens/overview/widgets";
import { ChartFrame } from "./charts/ChartFrame";

/* ---- moving a widget without dragging ------------------------------------------------------------------------------------------- */

function menu(over: Partial<ShellProps> = {}) {
  const onMove = vi.fn();
  const onRemove = vi.fn();
  const shell = { id: "kpis", first: false, last: false, onMove, onRemove, ...over } as unknown as ShellProps;
  renderWithProviders(<WithProject id="acme"><button>before</button><Shell shell={shell}>content</Shell></WithProject>);
  return { onMove, onRemove, trigger: () => screen.getByRole("button", { name: /Options for Key numbers/ }) };
}

describe("reordering widgets with the keyboard, no dragging", () => {
  it("opens from the keyboard, puts focus on the first usable choice, and Enter moves the widget", async () => {
    const { onMove, trigger } = menu();
    trigger().focus();
    await userEvent.keyboard("{Enter}");
    expect(trigger()).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("menu", { name: /Options for Key numbers/ })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Move earlier" })).toHaveFocus();
    await userEvent.keyboard("{Enter}");
    expect(onMove).toHaveBeenCalledWith(-1);
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    await waitFor(() => expect(trigger()).toHaveFocus()); // never dropped at the top of the page
  });

  it("Tab reaches Move later, and it works the same way", async () => {
    const { onMove, trigger } = menu();
    trigger().focus();
    await userEvent.keyboard("{Enter}{Tab}{Enter}");
    expect(onMove).toHaveBeenCalledWith(1);
  });

  it("the first widget cannot move earlier and the last cannot move later; focus lands on what can be used", async () => {
    const first = menu({ first: true });
    first.trigger().focus();
    await userEvent.keyboard("{Enter}");
    expect(screen.getByRole("menuitem", { name: "Move earlier" })).toBeDisabled();
    expect(screen.getByRole("menuitem", { name: "Move later" })).toHaveFocus();
  });

  it("Escape closes the menu and returns focus to its button without changing anything", async () => {
    const { onMove, onRemove, trigger } = menu();
    trigger().focus();
    await userEvent.keyboard("{Enter}{Escape}");
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    expect(trigger()).toHaveFocus();
    expect(onMove).not.toHaveBeenCalled();
    expect(onRemove).not.toHaveBeenCalled();
  });

  it("leaving the menu with Tab past its last item closes it", async () => {
    const { trigger } = menu();
    trigger().focus();
    await userEvent.keyboard("{Enter}");
    await userEvent.tab();
    await userEvent.tab();
    await userEvent.tab();
    await userEvent.tab();
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  });

  it("Remove is a clear choice by name, separate from moving", async () => {
    const { onRemove, trigger } = menu();
    trigger().focus();
    await userEvent.keyboard("{Enter}");
    await userEvent.click(screen.getByRole("menuitem", { name: "Remove" }));
    expect(onRemove).toHaveBeenCalledOnce();
  });
});

/* ---- the tour moves focus in and back ------------------------------------------------------------------------------------------ */

function TourHost() {
  const [open, setOpen] = useState(false);
  return (
    <WithProject id="acme">
      <button onClick={() => setOpen(true)}>Start the tour</button>
      <Tour open={open} onClose={() => setOpen(false)} />
    </WithProject>
  );
}

describe("the first-visit tour", () => {
  it("moves focus to its title when it opens and gives it back to the button that opened it", async () => {
    renderWithProviders(<TourHost />);
    const opener = screen.getByRole("button", { name: "Start the tour" });
    await userEvent.click(opener);
    expect(screen.getByRole("heading", { name: "Send your first call" })).toHaveFocus();
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "Quick tour" })).toBeNull();
    expect(opener).toHaveFocus();
  });
});

/* ---- charts have names and a table twin ----------------------------------------------------------------------------------------- */

describe("charts", () => {
  it("offer the same numbers as a table, from the keyboard, and say which view is showing", async () => {
    render(
      <ChartFrame title="Calls per day" table={{ columns: ["Day", "Calls"], rows: [["Mon", 4], ["Tue", 9]] }}>
        <div role="img" aria-label="Calls per day: 4 on Monday, 9 on Tuesday" />
      </ChartFrame>,
    );
    const toggle = screen.getByRole("button", { name: "Show table" });
    expect(toggle).toHaveAttribute("aria-pressed", "false");
    toggle.focus();
    await userEvent.keyboard("{Enter}");
    expect(screen.getByRole("button", { name: "Show chart" })).toHaveAttribute("aria-pressed", "true");
    const table = screen.getByRole("table");
    expect(table).toHaveTextContent("Mon");
    expect(table).toHaveTextContent("9");
    expect(screen.getAllByRole("columnheader").map((h) => h.textContent)).toEqual(["Day", "Calls"]);
  });
});

/* ---- every picture has a name or is hidden from assistive technology; zoom is never blocked ---------------------------------------- */

const ROOT = join(__dirname, "..");
function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return /\.tsx$/.test(name) && !/\.test\.tsx$/.test(name) ? [full] : [];
  });
}

/** Each opening tag of the given element, however many lines it spans. */
function tags(src: string, element: string): string[] {
  const out: string[] = [];
  const re = new RegExp(`<${element}(\\s[^>]*?)?(/?)>`, "gs");
  for (const m of src.matchAll(re)) out.push(m[0]);
  return out;
}

describe("names for pictures and charts", () => {
  it("every role=img has an accessible name", () => {
    const bad: string[] = [];
    for (const file of sourceFiles(ROOT)) {
      const src = readFileSync(file, "utf8");
      for (const t of src.matchAll(/<[a-zA-Z.]+\s[^<>]*?role="img"[^<>]*?>/gs)) {
        if (!/aria-label(?:ledby)?=/.test(t[0])) bad.push(`${relative(ROOT, file)}: ${t[0].slice(0, 80)}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it("every <svg> outside the icon set is either named (role img with a label) or hidden from assistive technology", () => {
    const bad: string[] = [];
    for (const file of sourceFiles(ROOT)) {
      if (/[\\/]icons\.tsx$/.test(file)) continue;
      for (const t of tags(readFileSync(file, "utf8"), "svg")) {
        const named = /role="img"/.test(t) && /aria-label=/.test(t);
        if (!named && !/aria-hidden/.test(t)) bad.push(`${relative(ROOT, file)}: ${t.slice(0, 90)}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it("every <img> has alt text (empty only for decoration)", () => {
    const bad: string[] = [];
    for (const file of sourceFiles(ROOT)) for (const t of tags(readFileSync(file, "utf8"), "img")) if (!/\balt=/.test(t)) bad.push(`${relative(ROOT, file)}: ${t.slice(0, 80)}`);
    expect(bad).toEqual([]);
  });

  it("the icon set hides every icon from assistive technology by default", () => {
    const src = readFileSync(join(ROOT, "ui", "icons.tsx"), "utf8");
    expect(src).toMatch(/aria-hidden/);
  });
});

describe("zoom and reflow", () => {
  it("the page never forbids pinch zoom or resizing text", () => {
    const html = readFileSync(join(ROOT, "..", "index.html"), "utf8");
    const viewport = /<meta[^>]*name="viewport"[^>]*>/.exec(html)?.[0] ?? "";
    expect(viewport).toContain("width=device-width");
    expect(viewport).not.toMatch(/user-scalable\s*=\s*(no|0)/i);
    expect(viewport).not.toMatch(/maximum-scale/i);
    expect(viewport).not.toMatch(/minimum-scale\s*=\s*1\b.*maximum/i);
  });

  it("text sizes are relative, so a larger browser text size is respected", () => {
    const css = readFileSync(join(ROOT, "index.css"), "utf8");
    const rootSize = /html\s*\{[^}]*font-size:\s*([^;]+);/.exec(css)?.[1]?.trim();
    expect(rootSize === undefined || /%|rem|em/.test(rootSize)).toBe(true);
    expect(/(html|body)\s*\{[^}]*font-size:\s*\d+px/.test(css)).toBe(false);
  });
});
