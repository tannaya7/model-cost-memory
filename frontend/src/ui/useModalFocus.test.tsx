import { useState } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { useModalFocus } from "./useModalFocus";

function Demo() {
  const [open, setOpen] = useState(false);
  const ref = useModalFocus<HTMLDivElement>(open, () => setOpen(false));
  return (
    <div>
      <button onClick={() => setOpen(true)}>Open it</button>
      {open && (
        <div ref={ref} tabIndex={-1} role="dialog" aria-modal="true" aria-label="Demo">
          <button>First</button>
          <button>Last</button>
        </div>
      )}
    </div>
  );
}

describe("useModalFocus", () => {
  it("moves focus in, keeps Tab inside, closes on Escape and returns focus to the opener", async () => {
    const user = userEvent.setup();
    render(<Demo />);
    const opener = screen.getByRole("button", { name: "Open it" });
    await user.click(opener);
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveFocus();
    await user.tab();
    expect(screen.getByText("First")).toHaveFocus();
    await user.tab();
    expect(screen.getByText("Last")).toHaveFocus();
    await user.tab();
    expect(screen.getByText("First")).toHaveFocus();
    await user.tab({ shift: true });
    expect(screen.getByText("Last")).toHaveFocus();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(opener).toHaveFocus();
  });
});
