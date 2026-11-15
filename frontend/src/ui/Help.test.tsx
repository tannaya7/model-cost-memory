import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { Help } from "./Help";

describe("Help", () => {
  it("opens on click, closes on a second click", async () => {
    const user = userEvent.setup();
    render(<Help>Extra detail</Help>);
    const b = screen.getByRole("button", { name: "What does this mean?" });
    expect(b).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("Extra detail")).toBeNull();
    await user.click(b);
    expect(b).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("status")).toHaveTextContent("Extra detail");
    await user.click(b);
    expect(screen.queryByText("Extra detail")).toBeNull();
  });

  it("closes on Escape and on a click outside, and stays open for a click inside", async () => {
    const user = userEvent.setup();
    render(<div><p>outside</p><Help label="About this">Inside text</Help></div>);
    const b = screen.getByRole("button", { name: "About this" });
    await user.click(b);
    await user.click(screen.getByText("Inside text"));
    expect(screen.getByText("Inside text")).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(screen.queryByText("Inside text")).toBeNull();
    await user.click(b);
    await user.click(screen.getByText("outside"));
    expect(screen.queryByText("Inside text")).toBeNull();
  });

  it("works from the keyboard and opens only one at a time", async () => {
    const user = userEvent.setup();
    render(<><Help label="one">First</Help><Help label="two">Second</Help></>);
    await user.tab();
    await user.keyboard("{Enter}");
    expect(screen.getByText("First")).toBeInTheDocument();
    await user.tab();
    await user.keyboard(" ");
    expect(screen.getByText("Second")).toBeInTheDocument();
    expect(screen.queryByText("First")).toBeNull();
  });
});
