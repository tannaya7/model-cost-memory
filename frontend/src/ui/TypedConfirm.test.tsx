import { describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TypedConfirm } from "./TypedConfirm";

function Host({ onConfirm = () => {}, ignoreCase = false }: { onConfirm?: (t: string) => void; ignoreCase?: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button onClick={() => setOpen(true)}>Delete company</button>
      {open && (
        <TypedConfirm label="Delete Acme" expected="Acme" ignoreCase={ignoreCase} confirmLabel="Delete it" onCancel={() => setOpen(false)} onConfirm={onConfirm}>
          This deletes the company.
        </TypedConfirm>
      )}
    </>
  );
}

describe("an in-page confirmation that needs a word typed", () => {
  it("moves focus to the text box, says what will happen, and keeps the destructive button off until it matches", async () => {
    const onConfirm = vi.fn();
    render(<Host onConfirm={onConfirm} />);
    await userEvent.click(screen.getByRole("button", { name: "Delete company" }));
    const group = screen.getByRole("group", { name: "Delete Acme" });
    expect(group).toHaveAccessibleDescription("This deletes the company.");
    const input = screen.getByLabelText(/Type Acme to confirm/);
    expect(input).toHaveFocus();
    const go = screen.getByRole("button", { name: "Delete it" });
    expect(go).toBeDisabled();
    await userEvent.type(input, "acme");
    expect(go).toBeDisabled(); // case matters here
    await userEvent.clear(input);
    await userEvent.type(input, "Acme");
    expect(go).toBeEnabled();
    await userEvent.click(go);
    expect(onConfirm).toHaveBeenCalledWith("Acme");
  });

  it("can ignore case, as for an e-mail address", async () => {
    render(<Host ignoreCase />);
    await userEvent.click(screen.getByRole("button", { name: "Delete company" }));
    await userEvent.type(screen.getByLabelText(/Type Acme to confirm/), "  ACME ");
    expect(screen.getByRole("button", { name: "Delete it" })).toBeEnabled();
  });

  it("Escape cancels and focus goes back to the button that opened it", async () => {
    render(<Host />);
    const opener = screen.getByRole("button", { name: "Delete company" });
    await userEvent.click(opener);
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("group", { name: "Delete Acme" })).toBeNull();
    expect(opener).toHaveFocus();
  });

  it("Cancel closes it and nothing is deleted", async () => {
    const onConfirm = vi.fn();
    render(<Host onConfirm={onConfirm} />);
    await userEvent.click(screen.getByRole("button", { name: "Delete company" }));
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("group", { name: "Delete Acme" })).toBeNull();
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("shows an error next to the buttons and keeps itself open", () => {
    render(<TypedConfirm label="x" expected="Acme" confirmLabel="Go" error="The company still has projects" onCancel={() => {}} onConfirm={() => {}}>text</TypedConfirm>);
    expect(screen.getByRole("alert")).toHaveTextContent("The company still has projects");
  });
});
