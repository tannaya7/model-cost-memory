/** How an app starts sending its AI calls here, written for someone who does not write code.
 *  Says why a few lines of code are needed, who adds them, gives a ready message to forward to a developer, and the exact
 *  name to use for each AI task. The project key is never put into the message: it is shown once, when the project is made.
 *
 *  Any language works: the product takes a plain web request (POST /v1/runs). Python also has a ready-made recorder. */
import { useState } from "react";
import { Button, Segmented } from "../../../ui/primitives";
import { jobTitle } from "../jobTitle";
import pythonRecorder from "../snippets/record_ai_call.py?raw";
import javascriptRecorder from "../snippets/recordAiCall.mjs?raw";

const EXAMPLE_TASK = "your-task-name";

export type Language = "python" | "javascript" | "web";

export const LANGUAGES: Array<{ value: Language; label: string }> = [
  { value: "python", label: "Python" },
  { value: "javascript", label: "JavaScript / Node" },
  { value: "web", label: "Any other language" },
];

/** The recorders are real files (snippets/), so tests can run exactly what a customer is shown. */
export const PYTHON_RECORDER = pythonRecorder.trimEnd();
export const JAVASCRIPT_RECORDER = javascriptRecorder.trimEnd();

export function snippetFor(task: string): string {
  return `${PYTHON_RECORDER}


# After each AI call your app already makes, add one line:
#   record_ai_call("${task}", prompt, answer_text, "my-model", response.model, "openai", response.usage)`;
}

/** For an app with many AI calls: one helper that every call goes through, so the task name is written in one place. */
export function helperSnippet(first: string): string {
  return `def ask_ai(task, prompt):
    # every AI call in the app goes through here; "task" is the name from the list
    response = client.chat.completions.create(model="my-model", messages=[{"role": "user", "content": prompt}])
    record_ai_call(task, prompt, response.choices[0].message.content, "my-model", response.model, "openai", response.usage)
    return response

# then, wherever the app needs the AI:
#   ask_ai("${first}", invoice_text)`;
}

/** The same thing for Node 18 or newer, with nothing to install: one function that every AI call goes through. */
export function javascriptSnippet(first: string): string {
  return `${JAVASCRIPT_RECORDER}

// After each AI call, in the one function your app already uses for it:
//   void recordAiCall("${first}", { prompt, answer: answerText, model: "my-model", modelVersion: response.model, provider: "openai", usage: response.usage, latencyMs });`;
}

/** A plain web request: works from any language or tool that can send one. */
export function webRequestSnippet(first: string): string {
  return `curl -X POST "$MCM_API_URL/v1/runs" \\
  -H "X-API-Key: $MCM_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "run_id": "a new unique id for each call, for example a UUID",
    "job": "${first}",
    "prompt": "the text your app sent to the AI",
    "output": "the answer the AI gave back",
    "model": "my-model",
    "model_version": "the exact model name the provider returned",
    "provider": "openai",
    "tokens_in": 1200,
    "tokens_out": 85,
    "latency_ms": 840
  }'`;
}

export function snippetForLanguage(language: Language, first: string): string {
  return language === "javascript" ? javascriptSnippet(first) : language === "web" ? webRequestSnippet(first) : snippetFor(first);
}

export function developerMessage(tasks: string[], projectName?: string, language: Language = "python"): string {
  const list = tasks.length ? tasks : [EXAMPLE_TASK];
  const first = list[0];
  const names = list.map((t) => `   - ${jobTitle(t)}: job="${t}"`).join("\n");
  const install =
    language === "python"
      ? `1. Nothing to install: this uses only what Python already includes.`
      : `1. Nothing to install: the dashboard takes a plain web request, so this works in any language.`;
  const wrap =
    language === "python"
      ? `3. Add this function once, then call it after each AI call, using the exact name for that task:\n\n${snippetFor(first)}`
      : language === "javascript"
        ? `3. Add this function, and call it after each AI call, using the exact name for that task:\n\n${javascriptSnippet(first)}`
        : `3. After each AI call, send this web request (from any language or tool), using the exact name for that task. It is sent after the AI has answered, so it never slows or changes the answer:\n\n${webRequestSnippet(first)}\n\n   Use the token counts the AI provider reports in its response. If a number is missing, leave it out.`;
  const many =
    language === "python"
      ? `   If our app calls the AI from many places, please do this once in the one function they all use, and pass the task name in, like this:\n\n${helperSnippet(first)}\n\n`
      : `   If our app calls the AI from many places, please send the request from the one function they all use, and pass the task name in, so it is written only once.\n\n`;
  return `Hi! Please add a small piece of code to our app so Model & Cost Memory can show what our AI calls cost and how well they work${projectName ? ` (project: ${projectName})` : ""}.

What it does: after each AI call our app already makes, it sends a copy of the result (which model, how many tokens, whether it worked) to our dashboard. It never changes the AI's answer, and if the dashboard is unreachable the app carries on as normal.

${install}
2. Set two environment variables on the server that runs our app:
   MCM_API_KEY = our project key (I saved it when I created the project; it starts with mcm_live_)
   MCM_API_URL = the address of our Model & Cost Memory server (the web address of the API, for example https://mcm.example.com)
${wrap}

   Names to use, one per task:
${names}

${many}4. Run the app once. The first call should show up on the dashboard within a minute.

Thanks!`;
}

function CopyButton({ text, label }: { text: string; label: string }) {
  const [done, setDone] = useState(false);
  return (
    <Button
      size="sm"
      aria-label={label}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setDone(true);
          setTimeout(() => setDone(false), 2000);
        } catch {
          /* the text stays selectable */
        }
      }}
    >
      {done ? "Copied" : "Copy"}
    </Button>
  );
}

/** `level` is the heading level of its sections: 2 under a page title (h1), 3 inside a panel that has its own h2. */
export function ConnectGuide({ tasks, projectName, level = 3 }: { tasks: string[]; projectName?: string; level?: 2 | 3 }) {
  const H = level === 2 ? "h2" : "h3";
  const [language, setLanguage] = useState<Language>("python");
  const list = tasks.length ? tasks : [EXAMPLE_TASK];
  const message = developerMessage(tasks, projectName, language);
  return (
    <div className="flex flex-col gap-5" data-testid="connect-guide">
      <section aria-labelledby="why-h">
        <H id="why-h" className="text-sm font-semibold text-ink">Why does my app need a few lines of code?</H>
        <p className="mt-1 text-sm text-dim">
          This product cannot see inside your app. The few lines below are how your app tells it, each time it asks an AI something,
          which task it was, which model answered and what it cost. Nothing about your app&apos;s answers changes, and you do this once per app.
        </p>
      </section>

      <section aria-labelledby="who-h">
        <H id="who-h" className="text-sm font-semibold text-ink">Who does this?</H>
        <p className="mt-1 text-sm text-dim">
          Whoever built your app. You don&apos;t need to write anything yourself: copy the message below and send it to them as it is.
        </p>
        <div className="mt-3 flex flex-col gap-1.5">
          <span className="text-xs font-semibold text-dim">What is your app written in?</span>
          <Segmented<Language> label="Programming language of your app" value={language} onChange={setLanguage} options={LANGUAGES} />
          <p className="text-xs text-muted">
            Not sure? Pick &ldquo;Any other language&rdquo;. Every language can send a plain web request, so the dashboard works with any app.
            Python also has a ready-made helper.
          </p>
        </div>
        <div className="mt-3 flex items-center justify-between gap-2">
          <span className="text-xs text-muted">A ready message for your developer</span>
          <CopyButton text={message} label="Copy the message for your developer" />
        </div>
        <pre tabIndex={0} aria-label="Message for your developer" className="mt-1 max-h-72 overflow-auto whitespace-pre-wrap rounded-[10px] border border-rule bg-bg p-3 font-mono text-xs leading-relaxed text-dim">{message}</pre>
      </section>

      <section aria-labelledby="names-h">
        <H id="names-h" className="text-sm font-semibold text-ink">The name your app uses for each task</H>
        <ul className="mt-1 flex flex-col gap-1 text-sm text-dim">
          {list.map((t) => (
            <li key={t}><span className="text-ink">{jobTitle(t)}</span> uses <code className="rounded bg-surface-3 px-1.5 py-0.5 font-mono text-xs text-ink">{t}</code></li>
          ))}
        </ul>
        <p className="mt-1 text-xs text-muted">It must be spelled exactly like this. Until a call arrives under that name, the task shows &ldquo;No AI calls yet&rdquo;.</p>
      </section>

      <section aria-labelledby="many-h">
        <H id="many-h" className="text-sm font-semibold text-ink">My app asks an AI from many places</H>
        <p className="mt-1 text-sm text-dim">
          No problem, and no extra work per task. Your developer writes the few lines once, in the one function your app already uses to call the AI,
          and gives that function the task name each time. The message above already says so. Every call is then sorted into its task by that name.
        </p>
      </section>

      <section aria-labelledby="done-h">
        <H id="done-h" className="text-sm font-semibold text-ink">How will I know it worked?</H>
        <p className="mt-1 text-sm text-dim">Once the app has made an AI call, open the dashboard. The task shows its first call, usually within a minute. Your project key is under Settings if you need to replace it.</p>
      </section>
    </div>
  );
}
