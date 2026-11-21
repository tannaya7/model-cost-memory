import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ToastProvider, useToast, type ToastInput } from "./Toast";

afterEach(() => vi.useRealTimers());

function Probe({ toast }: { toast: ToastInput }) {
  const push = useToast();
  return <button onClick={() => push(toast)}>push {toast.message}</button>;
}
const mount = (...toasts: ToastInput[]) =>
  render(<ToastProvider>{toasts.map((t) => <Probe key={t.message} toast={t} />)}</ToastProvider>);

describe("Toast", () => {
  it("announces a success politely and an error at once, without moving focus", async () => {
    const user = userEvent.setup();
    mount({ message: "Settings applied" }, { message: "Nope", kind: "error" });
    const button = screen.getByRole("button", { name: "push Settings applied" });
    await user.click(button);
    expect(screen.getByRole("status")).toHaveTextContent("Settings applied");
    expect(document.activeElement).toBe(button);
    await user.click(screen.getByRole("button", { name: "push Nope" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Nope");
  });

  it("stays about six seconds, and pauses while the pointer is on it", () => {
    vi.useFakeTimers();
    mount({ message: "Hello" });
    fireEvent.click(screen.getByRole("button", { name: "push Hello" }));
    const toast = screen.getByRole("status");
    fireEvent.mouseEnter(toast);
    act(() => void vi.advanceTimersByTime(20_000));
    expect(screen.getByText("Hello")).toBeInTheDocument();
    fireEvent.mouseLeave(toast);
    act(() => void vi.advanceTimersByTime(5_900));
    expect(screen.getByText("Hello")).toBeInTheDocument();
    act(() => void vi.advanceTimersByTime(200));
    expect(screen.queryByText("Hello")).toBeNull();
  });

  it("has a close button, shows at most three, and can offer Undo", async () => {
    const user = userEvent.setup();
    const undo = vi.fn();
    mount({ message: "one" }, { message: "two" }, { message: "three" }, { message: "four", undo: { label: "Undo", onUndo: undo } });
    for (const m of ["one", "two", "three", "four"]) await user.click(screen.getByRole("button", { name: `push ${m}` }));
    expect(screen.queryByText("one")).toBeNull();
    expect(screen.getAllByRole("status")).toHaveLength(3);
    await user.click(screen.getByRole("button", { name: "Undo" }));
    expect(undo).toHaveBeenCalledOnce();
    expect(screen.queryByText("four")).toBeNull();
    await user.click(screen.getAllByRole("button", { name: "Close message" })[0]);
    expect(screen.getAllByRole("status")).toHaveLength(1);
  });
});
