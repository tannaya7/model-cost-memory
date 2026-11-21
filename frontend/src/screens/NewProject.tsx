/** Creating a project: name it, take its key once, put the recorder in your code, open the dashboard. */
import { useState, type FormEvent } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { useCreateProject, useProjects } from "../features/projects/hooks/useProjects";
import { projectPath } from "../shared/projectPath";
import { ApiError, apiFetch } from "../shared/api/apiFetch";
import type { Job } from "../shared/api/types";
import { ConnectGuide } from "../features/jobs/components/ConnectGuide";
import { jobTitle } from "../features/jobs/jobTitle";
import { codeName } from "../features/jobs/taskName";
import { IconArrowRight, IconCheck, IconLogo } from "../ui/icons";
import { Button, cx, Panel } from "../ui/primitives";
import { ThemeToggle } from "../ui/ThemeToggle";
import { Help } from "../ui/Help";
import { BillingChoice } from "../features/projects/components/BillingChoice";
import type { BillingMode } from "../features/projects/hooks/useBillingMode";

const STEPS = ["Name it", "Save the key", "Connect your app"];
const MAX_TASKS = 10;

function Steps({ at }: { at: number }) {
  return (
    <ol className="flex items-center gap-2" aria-label="Steps">
      {STEPS.map((s, i) => (
        <li key={s} className="flex items-center gap-2">
          <span
            className={cx(
              "grid h-7 w-7 place-items-center rounded-full text-xs font-bold transition-colors",
              i < at ? "bg-ok text-on-accent" : i === at ? "bg-accent text-on-accent" : "bg-surface-3 text-muted",
            )}
            aria-current={i === at ? "step" : undefined}
          >
            {i < at ? <IconCheck size={14} strokeWidth={2.4} /> : i + 1}
          </span>
          <span className={cx("hidden text-sm sm:inline", i === at ? "font-semibold text-ink" : "text-muted")}>{s}</span>
          {i < STEPS.length - 1 && <span aria-hidden className="mx-1 h-px w-6 bg-rule-strong" />}
        </li>
      ))}
    </ol>
  );
}

function CopyBox({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex items-stretch gap-2">
      <code className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap rounded-[10px] border border-rule bg-bg px-3 py-2.5 font-mono text-sm text-ink" aria-label={label}>
        {value}
      </code>
      <Button
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(value);
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
          } catch {
            /* the text stays selectable */
          }
        }}
      >
        {copied ? <><IconCheck size={15} /> Copied</> : "Copy"}
      </Button>
    </div>
  );
}

export default function NewProject() {
  const create = useCreateProject();
  const projects = useProjects();
  const navigate = useNavigate();
  const workspace = useSearchParams()[0].get("workspace") || undefined;
  const [step, setStep] = useState(0);
  const [name, setName] = useState("");
  const [billing, setBilling] = useState<BillingMode>("per_use");
  const [error, setError] = useState<string | null>(null);
  const [made, setMade] = useState<{ ref: string; key: string; name: string } | null>(null);
  const [saved, setSaved] = useState(false);
  const [tasks, setTasks] = useState<string[]>([]); // what the app asks an AI to do, in the person's own words
  const [taskText, setTaskText] = useState("");
  const [madeTasks, setMadeTasks] = useState<string[]>([]);
  const [failedTasks, setFailedTasks] = useState<string[]>([]);

  const addTask = () => {
    const text = taskText.trim();
    if (!text || !codeName(text)) return;
    if (tasks.length >= MAX_TASKS || tasks.some((t) => codeName(t) === codeName(text))) return setTaskText("");
    setTasks([...tasks, text]);
    setTaskText("");
  };
  const first = (projects.data ?? []).length === 0;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!name.trim()) return setError("Give the project a name");
    try {
      // The person may have typed a task and not pressed Add yet: it counts.
      const typed = taskText.trim();
      const wanted = typed && codeName(typed) && !tasks.some((t) => codeName(t) === codeName(typed)) ? [...tasks, typed] : tasks;
      const result = await create.mutateAsync({ name: name.trim(), billing_mode: billing, organisation_id: workspace });
      // The tasks are made with the project, so there is nothing to create later. "You mark answers later" needs no setup.
      const ok: string[] = [];
      const bad: string[] = [];
      for (const t of wanted.slice(0, MAX_TASKS)) {
        try {
          await apiFetch<Job>("/v1/jobs", {
            method: "POST",
            headers: { "X-Project-Id": result.project.project_id },
            body: JSON.stringify({ name: codeName(t), description: t, check_kind: "LATE_LABEL", check_config: {}, retest_consent: false }),
          });
          ok.push(codeName(t));
        } catch {
          bad.push(t);
        }
      }
      setMadeTasks(ok);
      setFailedTasks(bad);
      setMade({ ref: workspace ? result.project.project_id : result.project.slug, key: result.api_key, name: result.project.name });
      setStep(1);
    } catch (err) {
      setError(err instanceof ApiError || err instanceof Error ? err.message : "Could not create the project");
    }
  };

  return (
    <div className="min-h-screen">
      <header className="border-b border-rule">
        <div className="mx-auto flex h-16 max-w-3xl items-center justify-between px-4">
          <Link to="/projects" className="flex items-center gap-2.5"><IconLogo size={26} /><span className="font-semibold tracking-tight">Model &amp; Cost Memory</span></Link>
          <div className="flex items-center gap-4">
            {!first && <Link to="/projects" className="text-sm text-dim hover:text-ink">Cancel</Link>}
            <ThemeToggle />
          </div>
        </div>
      </header>
      <main className="mx-auto flex max-w-3xl flex-col gap-6 px-4 py-10">
        <Steps at={step} />
        <AnimatePresence mode="wait">
          {step === 0 && (
            <motion.div key="name" initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -20 }}>
              <Panel glow className="p-6 md:p-8">
                <h1 className="text-3xl font-semibold tracking-tight">{first ? "Create your first project" : "New project"}</h1>
                <p className="mt-2 text-dim">A project is one app that uses AI, like an invoice assistant. You only need a name to start.</p>
                <form onSubmit={submit} className="mt-6 flex flex-col gap-3">
                  <label htmlFor="project-name" className="text-sm font-semibold text-dim">Project name</label>
                  <input
                    id="project-name"
                    autoFocus
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    maxLength={100}
                    placeholder="e.g. Invoice assistant"
                    className="rounded-[10px] border border-rule bg-surface-2 px-3.5 py-3 text-[15px] text-ink outline-none placeholder:text-muted focus:border-accent"
                  />
                  <div className="mt-3 flex flex-col gap-2">
                    <label htmlFor="task-name" className="text-sm font-semibold text-dim">
                      What does your app ask an AI to do? <span className="font-normal text-muted">(optional)</span>
                    </label>
                    <p className="text-xs text-muted">
                      Each kind of work is an AI task, for example &ldquo;Read invoices&rdquo; or &ldquo;Answer support emails&rdquo;. Add them here and we will give you everything in one place. You can add more later.
                    </p>
                    <div className="flex gap-2">
                      <input
                        id="task-name"
                        value={taskText}
                        onChange={(e) => setTaskText(e.target.value)}
                        onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addTask(); } }}
                        maxLength={100}
                        placeholder="e.g. Read invoices"
                        className="min-w-0 flex-1 rounded-[10px] border border-rule bg-surface-2 px-3.5 py-2.5 text-[15px] text-ink outline-none placeholder:text-muted focus:border-accent"
                      />
                      <Button onClick={addTask} disabled={!taskText.trim() || !codeName(taskText) || tasks.length >= MAX_TASKS}>Add task</Button>
                    </div>
                    {tasks.length > 0 && (
                      <ul aria-label="Tasks to add" className="flex flex-wrap gap-2">
                        {tasks.map((t) => (
                          <li key={t} className="inline-flex items-center gap-1.5 rounded-full border border-rule bg-surface-2 px-3 py-1 text-sm text-ink">
                            {jobTitle(t)}
                            <button type="button" aria-label={`Remove ${t}`} onClick={() => setTasks(tasks.filter((x) => x !== t))} className="text-muted hover:text-ink">×</button>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                  <div className="mt-3 flex items-center gap-1.5 text-sm font-semibold text-dim">
                    How do you pay for AI?
                    <Help label="About how you pay for AI">This only changes the wording and the alerts we show. With a subscription you pay a flat fee, so we talk about your usage allowance instead of money saved. You can change it later in Settings.</Help>
                  </div>
                  <BillingChoice value={billing} onChange={setBilling} />
                  <p className="text-xs text-muted">You can change this later in Settings.</p>
                  {error && <p className="text-sm text-bad">{error}</p>}
                  <div className="mt-2 flex justify-end">
                    <Button type="submit" variant="primary" disabled={create.isPending}>
                      {create.isPending ? "Creating…" : <>Create project <IconArrowRight size={16} /></>}
                    </Button>
                  </div>
                </form>
              </Panel>
            </motion.div>
          )}

          {step === 1 && made && (
            <motion.div key="key" initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -20 }}>
              <Panel glow className="p-6 md:p-8">
                <h1 className="text-3xl font-semibold tracking-tight"><span className="text-gradient">{made.name}</span> is ready</h1>
                <p className="mt-2 text-dim">Your app uses this key to send us its AI calls. <strong className="text-ink">It is shown only now</strong>, so copy it somewhere safe. You can make a new one in Settings.</p>
                <div className="mt-6"><CopyBox value={made.key} label="Project key" /></div>
                <label className="mt-5 flex items-center gap-3 text-sm text-dim">
                  <input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} className="h-4 w-4 accent-[var(--color-accent)]" />
                  I have saved the key
                </label>
                <div className="mt-6 flex justify-end">
                  <Button variant="primary" disabled={!saved} onClick={() => setStep(2)}>Next: connect your app <IconArrowRight size={16} /></Button>
                </div>
              </Panel>
            </motion.div>
          )}

          {step === 2 && made && (
            <motion.div key="sdk" initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -20 }}>
              <Panel glow className="p-6 md:p-8">
                <h1 className="text-3xl font-semibold tracking-tight">Connect your app</h1>
                <p className="mt-2 text-dim">
                  {madeTasks.length > 0
                    ? `Your ${madeTasks.length === 1 ? "task is" : "tasks are"} ready on the dashboard: ${madeTasks.map(jobTitle).join(", ")}.`
                    : "You can add your AI tasks on the dashboard whenever you like."}{" "}
                  The last step is to let your app send its AI calls here.
                </p>
                {failedTasks.length > 0 && (
                  <p role="alert" className="mt-2 text-sm text-bad">We could not add: {failedTasks.join(", ")}. You can add {failedTasks.length === 1 ? "it" : "them"} on the dashboard.</p>
                )}
                <div className="mt-6"><ConnectGuide tasks={madeTasks} projectName={made.name} level={2} /></div>
                <div className="mt-8 flex flex-wrap justify-end gap-2">
                  <Button variant="primary" onClick={() => navigate(projectPath(made.ref))}>
                    Open the dashboard <IconArrowRight size={16} />
                  </Button>
                </div>
              </Panel>
            </motion.div>
          )}
        </AnimatePresence>
      </main>
    </div>
  );
}
