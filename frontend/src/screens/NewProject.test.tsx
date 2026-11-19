import { afterEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders } from "../test/render";
import NewProject from "./NewProject";

afterEach(() => vi.unstubAllGlobals());

const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
const PROJECT = { project_id: "acme-1234", slug: "acme", name: "Acme", created_at: "2026-11-19T00:00:00Z", billing_mode: "per_use" };

function api(failJob?: string) {
  const posts: Array<{ url: string; headers: Record<string, string>; body: Record<string, unknown> }> = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    if (method === "POST") {
      const body = JSON.parse(String(init?.body ?? "{}"));
      posts.push({ url, headers: Object.fromEntries(new Headers(init?.headers).entries()), body });
      if (url === "/v1/projects") return json({ project: PROJECT, api_key: "mcm_live_ABCDEFGHIJKLMNOP" }, 201);
      if (url === "/v1/jobs") return body.name === failJob ? json({ detail: "boom" }, 500) : json({ job_id: "j", name: body.name }, 201);
    }
    return json([]);
  }));
  return posts;
}

async function createWith(user: ReturnType<typeof userEvent.setup>, tasks: string[]) {
  await user.type(await screen.findByLabelText("Project name"), "Acme");
  for (const t of tasks) {
    await user.type(screen.getByLabelText(/What does your app ask an AI to do/), t);
    await user.click(screen.getByRole("button", { name: "Add task" }));
  }
  await user.click(screen.getByRole("button", { name: /Create project/ }));
}

describe("making a project and its AI tasks together", () => {
  it("asks for the tasks in plain words and explains what they are", async () => {
    api();
    renderWithProviders(<NewProject />);
    expect(await screen.findByText(/What does your app ask an AI to do/)).toBeInTheDocument();
    expect(screen.getByText(/Each kind of work is an AI task/)).toBeInTheDocument();
  });

  it("creates the project, then each task with a code-safe name, in that project, and checks answers later", async () => {
    const posts = api();
    const user = userEvent.setup();
    renderWithProviders(<NewProject />);
    await createWith(user, ["Read invoices", "Answer support emails"]);
    await screen.findByText(/is ready/);
    const jobs = posts.filter((p) => p.url === "/v1/jobs");
    expect(jobs.map((j) => j.body.name)).toEqual(["read-invoices", "answer-support-emails"]);
    expect(jobs.every((j) => j.headers["x-project-id"] === "acme-1234" && j.body.check_kind === "LATE_LABEL")).toBe(true);
    expect(jobs[0].body.description).toBe("Read invoices");
  });

  it("a task typed but not yet added still counts, and a duplicate is not added twice", async () => {
    const posts = api();
    const user = userEvent.setup();
    renderWithProviders(<NewProject />);
    await user.type(await screen.findByLabelText("Project name"), "Acme");
    const box = screen.getByLabelText(/What does your app ask an AI to do/);
    await user.type(box, "Read invoices");
    await user.click(screen.getByRole("button", { name: "Add task" }));
    await user.type(box, "read   INVOICES!");
    await user.click(screen.getByRole("button", { name: "Add task" }));
    await user.type(box, "Sort tickets");
    await user.click(screen.getByRole("button", { name: /Create project/ }));
    await screen.findByText(/is ready/);
    expect(posts.filter((p) => p.url === "/v1/jobs").map((j) => j.body.name)).toEqual(["read-invoices", "sort-tickets"]);
  });

  it("the last step is a guide for a non-coder with the task names already filled in", async () => {
    api();
    const user = userEvent.setup();
    renderWithProviders(<NewProject />);
    await createWith(user, ["Read invoices"]);
    await user.click(await screen.findByLabelText("I have saved the key"));
    await user.click(screen.getByRole("button", { name: /Next: connect your app/ }));
    expect(await screen.findByRole("heading", { name: "Connect your app" })).toBeInTheDocument();
    expect(screen.getByText(/Your task is ready on the dashboard: Read invoices/)).toBeInTheDocument();
    expect(screen.getByText("Who does this?")).toBeInTheDocument();
    const message = screen.getByLabelText("Message for your developer").textContent ?? "";
    expect(message).toContain('job="read-invoices"');
    expect(message).not.toContain("ABCDEFGHIJKLMNOP");
    expect(screen.queryByText(/Tell it how to check an answer/)).toBeNull();
  });

  it("a task that fails to save is named without blocking the project", async () => {
    api("sort-tickets");
    const user = userEvent.setup();
    renderWithProviders(<NewProject />);
    await createWith(user, ["Read invoices", "Sort tickets"]);
    await user.click(await screen.findByLabelText("I have saved the key"));
    await user.click(screen.getByRole("button", { name: /Next: connect your app/ }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("We could not add: Sort tickets");
    await waitFor(() => expect(within(screen.getByTestId("connect-guide")).getAllByText("read-invoices").length).toBeGreaterThan(0));
  });
});
