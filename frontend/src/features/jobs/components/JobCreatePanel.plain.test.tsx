import { afterEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders } from "../../../test/render";
import { JobCreatePanel } from "./JobCreatePanel";

afterEach(() => vi.unstubAllGlobals());

const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });

describe("creating an AI task in your own words", () => {
  it("shows the short name the app will use, made from what was typed", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json([])));
    const user = userEvent.setup();
    renderWithProviders(<JobCreatePanel isOpen onClose={() => {}} onSuccess={() => {}} />);
    await user.type(screen.getByLabelText(/Task name/), "Read invoices");
    expect(screen.getByText("read-invoices")).toBeInTheDocument();
    expect(screen.getByText(/Your app uses this short name to say which task a call belongs to/)).toBeInTheDocument();
    expect(screen.queryByText(/no spaces/i)).toBeNull();
  });

  it("sends the short name, tells the person what comes next, and hands the name on to show how to connect", async () => {
    const posts: Array<Record<string, unknown>> = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        const body = JSON.parse(String(init.body));
        posts.push(body);
        return json({ job_id: "j", name: body.name }, 201);
      }
      return json([]);
    }));
    const messages: string[] = [];
    const created: string[] = [];
    const user = userEvent.setup();
    renderWithProviders(<JobCreatePanel isOpen onClose={() => {}} onSuccess={(m) => messages.push(m)} onCreated={(n) => created.push(n)} />);
    await user.type(screen.getByLabelText(/Task name/), "Answer support emails");
    await user.click(screen.getByRole("radio", { name: /person can judge|mark answers later|label/i }));
    await user.click(screen.getByRole("button", { name: /^Create/ }));
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0].name).toBe("answer-support-emails");
    await waitFor(() => expect(created).toEqual(["answer-support-emails"]));
    expect(messages[0]).toContain("Next, connect your app");
    expect(messages[0]).not.toContain("RunRecorder"); // no code in the confirmation
  });

  it("refuses a name with no letters or numbers, in plain words", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json([])));
    const user = userEvent.setup();
    renderWithProviders(<JobCreatePanel isOpen onClose={() => {}} onSuccess={() => {}} />);
    await user.type(screen.getByLabelText(/Task name/), "!!!");
    await user.click(screen.getByRole("radio", { name: /person can judge|mark answers later|label/i }));
    await user.click(screen.getByRole("button", { name: /^Create/ }));
    expect(await screen.findByText("Use at least one letter or number.")).toBeInTheDocument();
  });
});
