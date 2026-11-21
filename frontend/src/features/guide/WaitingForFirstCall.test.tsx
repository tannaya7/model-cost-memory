/** The empty state for a project that has not received a call: steps in order, no invented numbers, a way to look again. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders } from "../../test/render";
import { WithProject } from "../../app/project";
import { FIRST_CALL_SNIPPET } from "./snippet";
import { useWaitingForFirstCall, WaitingForFirstCall } from "./WaitingForFirstCall";

afterEach(() => {
  localStorage.clear();
  vi.unstubAllGlobals();
});

const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { "content-type": "application/json" } });

describe("the card", () => {
  const view = (checking = false, onCheck = () => {}) =>
    renderWithProviders(<WithProject id="acme"><WaitingForFirstCall checking={checking} onCheck={onCheck} /></WithProject>);

  it("says what is happening, in order, with the code and where the key is", () => {
    view();
    expect(screen.getByRole("heading", { name: "Waiting for your first call" })).toBeInTheDocument();
    expect(screen.getByText(/Nothing here is example data/)).toBeInTheDocument();
    expect(screen.getByText(/1\. Create an AI task\./)).toBeInTheDocument();
    expect(screen.getByText(/2\. Put this around the AI call your code already makes\./)).toBeInTheDocument();
    expect(screen.getByText(/3\. Run your app once, then look again\./)).toBeInTheDocument();
    expect(screen.getByLabelText("Example code for your first call")).toHaveTextContent(FIRST_CALL_SNIPPET.split("\n")[0]);
    expect(screen.getByRole("link", { name: "Create an AI task" }).getAttribute("href")).toContain("/jobs");
    expect(screen.getByRole("link", { name: "API keys in Settings" }).getAttribute("href")).toContain("/settings#keys");
  });

  it("shows no number, money or percentage that could be mistaken for data", () => {
    view();
    const text = document.body.textContent ?? "";
    expect(text).not.toMatch(/\$|%|\d{2,}/);
  });

  it("offers the questions about the work without pretending they measure anything", () => {
    view();
    expect(screen.getByRole("link", { name: "answer a few questions about your work" }).getAttribute("href")).toContain("/compare");
    expect(screen.getByText(/That is general information, not a result\./)).toBeInTheDocument();
  });

  it("'Check again' looks again, and is disabled with a plain word while it does", async () => {
    const onCheck = vi.fn();
    const user = userEvent.setup();
    const { unmount } = view(false, onCheck);
    await user.click(screen.getByRole("button", { name: "Check again" }));
    expect(onCheck).toHaveBeenCalledTimes(1);
    unmount();
    view(true, onCheck);
    expect(screen.getByRole("button", { name: "Looking…" })).toBeDisabled();
  });
});

function Probe() {
  const w = useWaitingForFirstCall();
  return <p data-testid="probe">{w.waiting ? "waiting" : "not waiting"}</p>;
}

describe("when it shows", () => {
  const mount = (id: string, daily: unknown) => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => (url.startsWith("/v1/insights/daily") ? json(daily) : json([]))));
    return renderWithProviders(<WithProject id={id}><Probe /></WithProject>);
  };

  it("for the viewer's own project with no call ever", async () => {
    mount("acme", []);
    await waitFor(() => expect(screen.getByTestId("probe")).toHaveTextContent("waiting"));
  });

  it("not once a single call has arrived", async () => {
    mount("acme", [{ day: "2026-11-01", job: "j", model: "m", runs: 1, passed: 0, failed: 0 }]);
    await waitFor(() => expect(screen.getByTestId("probe")).toHaveTextContent("not waiting"));
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.getByTestId("probe")).toHaveTextContent("not waiting");
  });

  it("not for a project whose calls are all older than the last 90 days", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => (url.startsWith("/v1/jobs") ? json([{ name: "invoice", run_count: 412, check_kind: "ANSWER_KEY" }]) : json([]))));
    renderWithProviders(<WithProject id="acme"><Probe /></WithProject>);
    await waitFor(() => expect(screen.getByTestId("probe")).toHaveTextContent("not waiting"));
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.getByTestId("probe")).toHaveTextContent("not waiting");
  });

  it("not before the history has loaded, so it never flashes at someone who has calls", async () => {
    vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));
    renderWithProviders(<WithProject id="acme"><Probe /></WithProject>);
    expect(screen.getByTestId("probe")).toHaveTextContent("not waiting");
  });
});
