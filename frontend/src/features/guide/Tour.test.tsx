import { describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders } from "../../test/render";
import { WithProject } from "../../app/project";
import { findTarget, placementFor, Tour } from "./Tour";
import { TOUR_STEPS } from "./steps";

function setup(onClose = vi.fn()) {
  renderWithProviders(
    <WithProject id="p1">
      <button type="button">outside</button>
      <Tour open onClose={onClose} />
    </WithProject>,
  );
  return onClose;
}

describe("Tour", () => {
  it("opens on sending the first call, with the exact line of code and a link to the key", () => {
    setup();
    expect(screen.getByRole("heading", { name: "Send your first call" })).toBeInTheDocument();
    expect(screen.getByLabelText("Example code").textContent).toContain('record_ai_call("invoice-extract"');
    expect(screen.getByRole("link", { name: "Find your project key" })).toHaveAttribute("href", "/p/p1/settings#keys");
  });
  it("walks through all six steps and finishes", async () => {
    const onClose = setup();
    const user = userEvent.setup();
    for (let i = 1; i < TOUR_STEPS.length; i++) {
      await user.click(screen.getByRole("button", { name: "Next" }));
      expect(screen.getByRole("heading", { name: TOUR_STEPS[i].title })).toBeInTheDocument();
      expect(screen.getByRole("status")).toHaveTextContent(`Step ${i + 1} of 6`);
    }
    await user.click(screen.getByRole("button", { name: "Done" }));
    expect(onClose).toHaveBeenCalledWith(true);
  });
  it("can go back", async () => {
    setup();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Next" }));
    await user.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.getByRole("heading", { name: "Send your first call" })).toBeInTheDocument();
  });
  it("skips from the button and with Esc, at any step", async () => {
    const onClose = setup();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Next" }));
    await user.click(screen.getByRole("button", { name: "Skip the tour" }));
    expect(onClose).toHaveBeenLastCalledWith(false);
    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(2);
  });
  it("keeps Tab inside the card", async () => {
    setup();
    const user = userEvent.setup();
    const done = screen.getByRole("button", { name: "Next" });
    done.focus();
    await user.tab();
    expect(screen.getByRole("dialog")).toContainElement(document.activeElement as HTMLElement);
    await user.tab({ shift: true });
    await user.tab({ shift: true });
    expect(screen.getByRole("dialog")).toContainElement(document.activeElement as HTMLElement);
  });
  it("does not stop the page from catching clicks", () => {
    setup();
    expect(screen.getByRole("dialog").parentElement).toHaveClass("pointer-events-none");
  });
});

describe("where the card goes", () => {
  const phone = { w: 390, h: 800 };
  const desk = { w: 1280, h: 800 };
  const box = (left: number, top: number) => ({ left, top, width: 100, height: 40 });
  it("falls back to a bottom sheet when the target is hidden", () => {
    expect(placementFor(null, true, desk)).toBe("sheet");
    expect(placementFor(null, true, phone)).toBe("sheet");
  });
  it("sits beside a sidebar item on a wide screen, above a bottom-bar item on a phone", () => {
    expect(placementFor(box(10, 200), true, desk)).toBe("side");
    expect(placementFor(box(10, 740), true, phone)).toBe("above");
  });
  it("centres a step with nothing to point at, except on a phone", () => {
    expect(placementFor(null, false, desk)).toBe("center");
    expect(placementFor(null, false, phone)).toBe("sheet");
  });
});

describe("findTarget", () => {
  it("skips marked elements that are not on screen", () => {
    document.body.innerHTML = '<a data-tour="x" id="hidden"></a><a data-tour="x" id="shown"></a>';
    const shown = document.getElementById("shown")!;
    shown.getBoundingClientRect = () => ({ width: 10, height: 10, top: 0, left: 0, right: 10, bottom: 10, x: 0, y: 0, toJSON: () => ({}) });
    expect(findTarget("x")?.id).toBe("shown");
    expect(findTarget(undefined)).toBeNull();
    document.body.innerHTML = "";
  });
});
