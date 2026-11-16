import { afterEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders } from "../../../test/render";
import { stubApi } from "../../../test/api";
import { RunDetailPanel } from "./RunDetailPanel";

afterEach(() => vi.unstubAllGlobals());

function Host() {
  const [id, setId] = useState<string | null>(null);
  return (
    <>
      <button onClick={() => setId("run-1")}>See run</button>
      <RunDetailPanel runId={id} onClose={() => setId(null)} />
    </>
  );
}

describe("RunDetailPanel keyboard behaviour", () => {
  it("takes focus on open, keeps Tab inside, and on Escape gives focus back to the row button", async () => {
    stubApi({ "/v1/runs/run-1": new Response("{}", { status: 404 }) });
    const user = userEvent.setup();
    renderWithProviders(<Host />);
    const trigger = screen.getByRole("button", { name: "See run" });
    await user.click(trigger);
    const dialog = screen.getByRole("dialog");
    expect(dialog.contains(document.activeElement)).toBe(true);
    for (let i = 0; i < 12; i++) {
      await user.tab();
      expect(dialog.contains(document.activeElement)).toBe(true);
    }
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(trigger).toHaveFocus();
  });
});
