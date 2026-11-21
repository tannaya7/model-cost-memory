import { afterEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders } from "../../../test/render";
import { stubApi } from "../../../test/api";
import { JobCreatePanel } from "./JobCreatePanel";

afterEach(() => vi.unstubAllGlobals());

function Host() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button onClick={() => setOpen(true)}>New AI task</button>
      <JobCreatePanel isOpen={open} onClose={() => setOpen(false)} onSuccess={() => {}} />
    </>
  );
}

describe("JobCreatePanel keyboard behaviour", () => {
  it("moves focus in, keeps Tab inside, closes on Escape and gives focus back to the button", async () => {
    stubApi({});
    const user = userEvent.setup();
    renderWithProviders(<Host />);
    const trigger = screen.getByRole("button", { name: "New AI task" });
    await user.click(trigger);
    const dialog = screen.getByRole("dialog");
    expect(screen.getByLabelText(/Task name/)).toHaveFocus();
    for (let i = 0; i < 30; i++) {
      await user.tab();
      expect(dialog.contains(document.activeElement)).toBe(true);
    }
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(trigger).toHaveFocus();
  });

  it("names every answer-key field input", async () => {
    stubApi({});
    const user = userEvent.setup();
    renderWithProviders(<Host />);
    await user.click(screen.getByRole("button", { name: "New AI task" }));
    expect(screen.getByRole("textbox", { name: /Field 1 to compare/ })).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: /Field 2 to compare/ })).toBeInTheDocument();
  });
});
