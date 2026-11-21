/** Titles, sentences and states. These check that the words are there and say what they must, and that the honest states survive polish.
 *  They do not show the words are clear to a first-time user: that needs real people (see research_notes/Clarity user test plan). */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders } from "../test/render";
import { stubApi } from "../test/api";
import { WithProject } from "../app/project";
import { ApiError } from "../shared/api/apiFetch";
import { ErrorState } from "../ui/primitives";
import { TOO_FEW_LABEL, UNTESTED_LABEL } from "./compare/wilson";
import Jobs from "./Jobs";
import Models from "./Models";

afterEach(() => vi.unstubAllGlobals());

const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });

/* ---- every page title has one plain sentence under it ------------------------------------------------------------------- */

function screenFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return screenFiles(full);
    return /\.tsx$/.test(name) && !/\.test\.tsx$/.test(name) ? [full] : [];
  });
}

describe("page titles", () => {
  it("are each followed by a sentence that says what the page is for", () => {
    const missing: string[] = [];
    const found: string[] = [];
    for (const file of screenFiles(__dirname)) {
      const lines = readFileSync(file, "utf8").split("\n");
      lines.forEach((line, i) => {
        if (!line.includes("<h1")) return;
        found.push(`${relative(__dirname, file)}:${i + 1}`);
        const after = lines.slice(i + 1, i + 4).join("\n");
        // the next element must be a paragraph; a component that renders one (a header line) is allowed by name
        if (!/<p[\s>]|<AsOfLine|<Subtitle|<TaskShort/.test(after)) missing.push(`${relative(__dirname, file)}:${i + 1}`);
      });
    }
    expect(found.length).toBeGreaterThan(10);
    expect(missing).toEqual([]);
  });

  it("do not repeat the title as the sentence", () => {
    for (const file of screenFiles(__dirname)) {
      const text = readFileSync(file, "utf8");
      for (const m of text.matchAll(/<h1[^>]*>([^<{]+)<\/h1>\s*<p[^>]*>([^<{]+)<\/p>/g)) {
        expect(m[2].trim().toLowerCase()).not.toBe(m[1].trim().toLowerCase());
        expect(m[2].trim().split(/\s+/).length).toBeGreaterThanOrEqual(4);
      }
    }
  });
});

/* ---- the AI tasks page: loading, error, empty, permission, and the honest states ---------------------------------------------- */

const job = { job_id: "j1", name: "invoice-extract", description: "Pull the total out of an invoice", check_kind: "ANSWER_KEY", check_config: {}, retest_consent: false, run_count: 90, runs_by_state: {} };
const mount = () => renderWithProviders(<WithProject id="acme"><Jobs /></WithProject>);

describe("the AI tasks page states", () => {
  it("says it is loading while it waits, and shows no numbers yet", () => {
    vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));
    mount();
    expect(screen.getByRole("status", { name: "Loading your AI tasks" })).toBeInTheDocument();
    expect(screen.queryByText("No AI tasks yet")).toBeNull();
  });

  it("an error is plain, keeps the page title and offers to try again", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ detail: "The server is busy" }, 500)));
    mount();
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Could not load this");
    expect(within(alert).getByRole("button", { name: "Try again" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "AI tasks" })).toBeInTheDocument();
  });

  it("a permission refusal says so, gives the reason, and offers no pointless retry", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ detail: "Only an admin or owner of the company can change this" }, 403)));
    mount();
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Your role does not allow this: Only an admin or owner of the company can change this");
    expect(within(alert).queryByRole("button", { name: "Try again" })).toBeNull();
  });

  it("with no tasks it explains what a task is and what to do, with a button, and never shows made-up data", async () => {
    stubApi({ "/v1/jobs": [] });
    mount();
    expect(await screen.findByText("No AI tasks yet")).toBeInTheDocument();
    expect(screen.getByText(/An AI task is one kind of work your app asks an AI to do/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create your first AI task" })).toBeInTheDocument();
    expect(screen.queryByTestId("savings-entry")).toBeNull();
    expect(screen.queryByText(/invoice-extract|acme|demo/i)).toBeNull(); // no invented example rows
  });

  it("keeps the honest states: still learning, no recommendation yet, and no calls yet", async () => {
    stubApi({
      "/v1/jobs": [job, { ...job, job_id: "j2", name: "empty-task", run_count: 0 }],
      "/v1/jobs/invoice-extract/recommendation": new Response("{}", { status: 404 }),
      "/v1/jobs/empty-task/recommendation": new Response("{}", { status: 404 }),
    });
    mount();
    expect(await screen.findByText("No recommendation yet")).toBeInTheDocument();
    expect(screen.getByText("No AI calls yet")).toBeInTheDocument();
    const learning = screen.getByRole("tab", { name: /Still learning/ });
    await userEvent.click(learning);
    expect(screen.getAllByText(/Invoice extract|Empty task/).length).toBeGreaterThan(0); // tasks without evidence are listed there, not hidden
  });

  it("uses the AI task noun for what you can create, search and open", async () => {
    stubApi({ "/v1/jobs": [job], "/v1/jobs/invoice-extract/recommendation": new Response("{}", { status: 404 }) });
    mount();
    await screen.findByText("Invoice extract");
    expect(screen.getByRole("button", { name: /New AI task/ })).toBeInTheDocument();
    expect(screen.getByLabelText("Find an AI task")).toBeInTheDocument();
    expect(screen.getByRole("tablist", { name: "Show AI tasks" })).toBeInTheDocument();
    expect(document.body.textContent ?? "").not.toMatch(/\bjobs?\b/i);
  });
});

/* ---- the Models page ----------------------------------------------------------------------------------------------------- */

describe("the Models page", () => {
  it("opens with one plain sentence under the title", async () => {
    stubApi({});
    renderWithProviders(<WithProject id="acme"><Models /></WithProject>);
    expect(await screen.findByRole("heading", { name: "Models" })).toBeInTheDocument();
    expect(screen.getByText("What the models you run cost, which are being retired, and where each price comes from.")).toBeInTheDocument();
  });
});

/* ---- evidence limits are not polished away ----------------------------------------------------------------------------------------- */

describe("evidence limits keep their words", () => {
  it("says a model is not tested, or has too few checked answers, in plain words", () => {
    expect(UNTESTED_LABEL).toBe("Not tested on your work yet");
    expect(TOO_FEW_LABEL).toBe("Not enough checked answers yet");
  });

  it("ErrorState distinguishes a refusal from a failure and always says why", () => {
    const { rerender } = renderWithProviders(<ErrorState error={new ApiError(403, "Your role is view-only", null)} onRetry={() => {}} />);
    expect(screen.getByRole("alert")).toHaveTextContent("Your role does not allow this: Your role is view-only");
    rerender(<ErrorState error={new ApiError(500, "Server error", null)} onRetry={() => {}} />);
    expect(screen.getByRole("alert")).toHaveTextContent("Could not load this: Server error");
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
    rerender(<ErrorState error={"not an error object"} />);
    expect(screen.getByRole("alert")).toHaveTextContent("Could not load this: Something went wrong");
  });
});
