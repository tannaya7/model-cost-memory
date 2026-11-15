import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { NoCallsYet, NoneChecked, NotEnoughData } from "./NotEnoughData";

describe("empty states", () => {
  it("shows progress with the real numbers", () => {
    render(<NotEnoughData n={12} min={25} />);
    const bar = screen.getByRole("progressbar");
    expect(bar).toHaveAttribute("aria-valuenow", "12");
    expect(bar).toHaveAttribute("aria-valuemin", "0");
    expect(bar).toHaveAttribute("aria-valuemax", "25");
    expect(screen.getByText("12 of 25")).toBeInTheDocument();
    expect(screen.getByText(/at least 25.*12 so far/)).toBeInTheDocument();
  });
  it("caps the bar at the minimum", () => {
    render(<NotEnoughData n={40} min={25} />);
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "25");
  });
  it("says there are no calls yet, with a next step", () => {
    render(<MemoryRouter><NoCallsYet to="/jobs" /></MemoryRouter>);
    expect(screen.getByText(/When your app sends its first call/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Create an AI task" })).toHaveAttribute("href", "/jobs");
  });
  it("says calls are arriving but none are checked", () => {
    render(<MemoryRouter><NoneChecked to="/jobs" /></MemoryRouter>);
    expect(screen.getByText(/none are checked yet/)).toBeInTheDocument();
  });
});
