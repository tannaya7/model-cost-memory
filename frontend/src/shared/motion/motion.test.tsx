/** The motion and 3D layer: it follows the person's choice, it falls back to the flat picture wherever 3D cannot be drawn, and it never
 *  becomes the only way to read anything. (The test runner has no WebGL, so these also prove the flat path is what ships there.) */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MotionToggle } from "../../ui/MotionToggle";
import { Scene3D } from "../three/Scene3D";
import { MotionRoot } from "./MotionRoot";
import { readMotionChoice, resetMotionSession, useMotion } from "./useMotion";
import { canUseWebGL, isLowPower, resetWebGLCache } from "./webgl";

// three.js is not loaded in these tests: the scene module is replaced by an empty box.
vi.mock("../three/LandingWorld", () => ({ default: () => <div data-testid="canvas" /> }));

beforeEach(() => {
  window.localStorage.clear();
  resetMotionSession();
  document.documentElement.removeAttribute("data-motion");
  resetWebGLCache();
});
afterEach(() => vi.restoreAllMocks());

function Probe() {
  const { calm, choice } = useMotion();
  return <p data-testid="p">{choice}:{String(calm)}</p>;
}

describe("the motion choice", () => {
  it("starts on auto, which follows the system", () => {
    render(<Probe />);
    expect(screen.getByTestId("p")).toHaveTextContent("auto:false");
  });

  it("is remembered, shared between components, and can go back to auto", async () => {
    render(<><MotionToggle /><Probe /></>);
    const button = screen.getByRole("button", { name: /Motion: full/ });
    expect(button).toHaveAttribute("aria-pressed", "false");
    await userEvent.click(button);
    expect(screen.getByRole("button", { name: /Motion: calm/ })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByTestId("p")).toHaveTextContent("calm:true");
    expect(window.localStorage.getItem("mcm-motion")).toBe("calm");
    expect(readMotionChoice()).toBe("calm");
    await userEvent.click(screen.getByRole("button", { name: /Motion: calm/ }));
    expect(screen.getByTestId("p")).toHaveTextContent("full:false");
  });

  it("still works when the browser refuses to store anything", async () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("blocked"); });
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("blocked"); });
    render(<><MotionToggle /><Probe /></>);
    expect(screen.getByTestId("p")).toHaveTextContent("auto:false");
    await userEvent.click(screen.getByRole("button", { name: /Motion: full/ }));
    expect(screen.getByTestId("p")).toHaveTextContent("calm:true");
  });

  it("tells the stylesheet, so CSS effects follow the same switch", async () => {
    render(<><MotionRoot /><MotionToggle /></>);
    expect(document.documentElement.dataset.motion).toBe("full");
    await act(async () => { await userEvent.click(screen.getByRole("button", { name: /Motion/ })); });
    expect(document.documentElement.dataset.motion).toBe("calm");
  });
});

describe("where 3D can be drawn", () => {
  it("says no without a graphics context, and caches the answer", () => {
    const spy = vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
    expect(canUseWebGL()).toBe(false);
    const asked = spy.mock.calls.length; // WebGL 2, then WebGL 1
    expect(asked).toBeGreaterThan(0);
    expect(canUseWebGL()).toBe(false);
    expect(spy).toHaveBeenCalledTimes(asked); // the second answer came from memory
  });

  it("says yes when a context exists, and no when asking throws", () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({} as never);
    expect(canUseWebGL()).toBe(true);
    resetWebGLCache();
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(() => { throw new Error("no"); });
    expect(canUseWebGL()).toBe(false);
  });

  it("treats a small machine as low power and a big one as not", () => {
    vi.spyOn(navigator, "hardwareConcurrency", "get").mockReturnValue(2);
    expect(isLowPower()).toBe(true);
    vi.spyOn(navigator, "hardwareConcurrency", "get").mockReturnValue(12);
    expect(isLowPower()).toBe(false);
  });
});

describe("the 3D scene wrapper", () => {
  it("shows the flat picture, hidden from screen readers, when 3D cannot be drawn", () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
    const { container } = render(<Scene3D at={0.5} fallback={<p>flat picture</p>} />);
    expect(screen.getByText("flat picture")).toBeInTheDocument();
    const wrapper = container.firstElementChild as HTMLElement;
    expect(wrapper).toHaveAttribute("aria-hidden", "true");
    expect(wrapper).toHaveAttribute("data-scene", "flat");
    expect(container.querySelector("canvas")).toBeNull();
  });
});
