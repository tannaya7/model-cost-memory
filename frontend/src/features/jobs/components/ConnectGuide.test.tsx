import { describe, expect, it } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ConnectGuide, developerMessage, snippetFor, webRequestSnippet } from "./ConnectGuide";

describe("the guide for connecting an app", () => {
  it("explains why code is needed and who adds it, in plain words", () => {
    render(<ConnectGuide tasks={["read-invoices"]} />);
    expect(screen.getByText("Why does my app need a few lines of code?")).toBeInTheDocument();
    expect(screen.getByText(/cannot see inside your app/)).toBeInTheDocument();
    expect(screen.getByText("Who does this?")).toBeInTheDocument();
    expect(screen.getByText(/to write anything yourself/)).toBeInTheDocument();
    expect(screen.getByText("How will I know it worked?")).toBeInTheDocument();
  });

  it("gives the exact name for each task, and a ready message with the code already filled in", () => {
    render(<ConnectGuide tasks={["read-invoices", "answer-support-emails"]} projectName="Acme" />);
    const names = screen.getByRole("heading", { name: "The name your app uses for each task" }).parentElement as HTMLElement;
    expect(within(names).getByText("read-invoices")).toBeInTheDocument();
    expect(within(names).getByText("answer-support-emails")).toBeInTheDocument();
    const message = screen.getByLabelText("Message for your developer").textContent ?? "";
    expect(message).toContain('job="read-invoices"');
    expect(message).toContain('   - Answer support emails: job="answer-support-emails"');
    expect(message).toContain("project: Acme");
    expect(screen.getByRole("button", { name: "Copy the message for your developer" })).toBeInTheDocument();
  });

  it("never puts a project key into the message and says the call is never changed", () => {
    const message = developerMessage(["t"]);
    expect(message).not.toMatch(/mcm_live_[A-Za-z0-9_-]{6,}/);
    expect(message).toContain("It never changes the AI's answer");
    expect(message).toContain("if the dashboard is unreachable the app carries on as normal");
  });

  it("tells a developer with many AI calls to write it once in one helper and pass the task name", () => {
    render(<ConnectGuide tasks={["read-invoices", "sort-tickets"]} />);
    expect(screen.getByText("My app asks an AI from many places")).toBeInTheDocument();
    expect(screen.getByText(/gives that function the task name each time/)).toBeInTheDocument();
    const message = screen.getByLabelText("Message for your developer").textContent ?? "";
    expect(message).toContain("do this once in the one function they all use");
    expect(message).toContain("def ask_ai(task, prompt):");
    expect(message).toContain('ask_ai("read-invoices", invoice_text)');
  });

  it("still shows a usable example before any task exists", () => {
    render(<ConnectGuide tasks={[]} />);
    expect(screen.getAllByText("your-task-name").length).toBeGreaterThan(0);
    expect(snippetFor("x")).toContain('record_ai_call("x"');
  });

  it("is not Python only: it asks what the app is written in and offers JavaScript and a plain web request", async () => {
    render(<ConnectGuide tasks={["read-invoices"]} />);
    expect(screen.getByText("What is your app written in?")).toBeInTheDocument();
    for (const name of ["Python", "JavaScript / Node", "Any other language"]) expect(screen.getByRole("tab", { name })).toBeInTheDocument();
    expect(screen.getByText(/Every language can send a plain web request/)).toBeInTheDocument();
    const box = () => screen.getByLabelText("Message for your developer").textContent ?? "";
    expect(box()).toContain("Nothing to install: this uses only what Python already includes.");
    expect(box()).toContain("def record_ai_call(");
    expect(box()).not.toContain("model-cost-memory"); // no package that is not published

    await userEvent.click(screen.getByRole("tab", { name: "JavaScript / Node" }));
    expect(box()).toContain("Nothing to install");
    expect(box()).toContain("export async function recordAiCall");
    expect(box()).toContain("usage.prompt_tokens_details?.cached_tokens");
    expect(box()).toContain('recordAiCall("read-invoices"');
    expect(box()).not.toContain("model-cost-memory");

    await userEvent.click(screen.getByRole("tab", { name: "Any other language" }));
    expect(box()).toContain('curl -X POST "$MCM_API_URL/v1/runs"');
    expect(box()).toContain('"job": "read-invoices"');
    expect(box()).toContain("never slows or changes the answer");
    expect(box()).not.toContain("RunRecorder");
  });

  it("the plain web request has exactly the fields the server needs and never a real key", () => {
    const req = webRequestSnippet("t");
    for (const field of ["run_id", "job", "prompt", "model", "model_version", "tokens_in", "tokens_out"]) expect(req).toContain(`"${field}"`);
    expect(req).toContain("$MCM_API_KEY");
    expect(req).not.toMatch(/mcm_live_[A-Za-z0-9_-]{6,}/);
    for (const language of ["python", "javascript", "web"] as const) {
      expect(developerMessage(["t"], "P", language)).not.toMatch(/mcm_live_[A-Za-z0-9_-]{6,}/);
    }
  });
});
