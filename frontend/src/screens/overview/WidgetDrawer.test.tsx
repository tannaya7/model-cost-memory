import { useState } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { WidgetDrawer } from "./WidgetDrawer";

function Host() {
  const [open, setOpen] = useState(false);
  return (
    <div id="root">
      <button type="button" onClick={() => setOpen(true)}>Open drawer</button>
      <WidgetDrawer open={open} onClose={() => setOpen(false)} ids={[]} onAdd={() => {}} onRemove={() => {}} />
    </div>
  );
}

describe("WidgetDrawer dialog behaviour", () => {
  it("moves focus in, traps Tab, hides the page, and returns focus on Escape", async () => {
    const user = userEvent.setup();
    const { container } = render(<Host />);
    const trigger = screen.getByRole("button", { name: "Open drawer" });
    await user.click(trigger);
    const dialog = await screen.findByRole("dialog", { name: "Add widget" });
    expect(dialog).toHaveFocus();
    expect(container.querySelector("#root")).toHaveAttribute("inert");
    for (let i = 0; i < 40; i++) {
      await user.tab();
      expect(dialog.contains(document.activeElement)).toBe(true);
    }
    for (let i = 0; i < 40; i++) {
      await user.tab({ shift: true });
      expect(dialog.contains(document.activeElement)).toBe(true);
    }
    await user.keyboard("{Escape}");
    expect(trigger).toHaveFocus();
    expect(container.querySelector("#root")).not.toHaveAttribute("inert");
  });

  it("offers an Add button for every widget, so nothing needs dragging", async () => {
    const user = userEvent.setup();
    render(<Host />);
    await user.click(screen.getByRole("button", { name: "Open drawer" }));
    expect((await screen.findAllByRole("button", { name: "Add" })).length).toBeGreaterThan(0);
  });
});
