/** Creating a project: name it, take its key once, put the recorder in your code, open the dashboard. */
import { useState, type FormEvent } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Link, useNavigate } from "react-router-dom";
import { useCreateProject, useProjects } from "../features/projects/hooks/useProjects";
import { ApiError } from "../shared/api/apiFetch";
import { IconArrowRight, IconCheck, IconLogo } from "../ui/icons";
import { Button, cx, Panel } from "../ui/primitives";

const STEPS = ["Name it", "Save the key", "Record runs"];

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
  const [step, setStep] = useState(0);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [made, setMade] = useState<{ id: string; key: string; name: string } | null>(null);
  const [saved, setSaved] = useState(false);
  const first = (projects.data ?? []).length === 0;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!name.trim()) return setError("Give the project a name");
    try {
      const result = await create.mutateAsync({ name: name.trim() });
      setMade({ id: result.project.project_id, key: result.api_key, name: result.project.name });
      setStep(1);
    } catch (err) {
      setError(err instanceof ApiError || err instanceof Error ? err.message : "Could not create the project");
    }
  };

  const snippet = `from agent_memory.recorder import RunRecorder, provider_for

with RunRecorder(job="invoice-extract", provider=provider_for(client.base_url)) as rec:
    response = client.chat.completions.create(model="my-model", messages=[...])
    rec.capture(response, prompt=prompt, model="my-model")`;

  return (
    <div className="min-h-screen">
      <header className="border-b border-rule">
        <div className="mx-auto flex h-16 max-w-3xl items-center justify-between px-4">
          <Link to="/projects" className="flex items-center gap-2.5"><IconLogo size={26} /><span className="font-semibold tracking-tight">Model &amp; Cost Memory</span></Link>
          {!first && <Link to="/projects" className="text-sm text-dim hover:text-ink">Cancel</Link>}
        </div>
      </header>
      <main className="mx-auto flex max-w-3xl flex-col gap-6 px-4 py-10">
        <Steps at={step} />
        <AnimatePresence mode="wait">
          {step === 0 && (
            <motion.div key="name" initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -20 }}>
              <Panel glow className="p-6 md:p-8">
                <h1 className="text-3xl font-semibold tracking-tight">{first ? "Create your first project" : "New project"}</h1>
                <p className="mt-2 text-dim">A project is one application, such as an invoice assistant or a support bot. Its runs, jobs, alerts and keys are kept apart from every other project.</p>
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
                <p className="mt-2 text-dim">This is the project's key. Your app sends runs with it. <strong className="text-ink">It is shown only now</strong>: only its first characters are kept, so copy it somewhere safe. You can make a new one later in the project's settings.</p>
                <div className="mt-6"><CopyBox value={made.key} label="Project key" /></div>
                <label className="mt-5 flex items-center gap-3 text-sm text-dim">
                  <input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} className="h-4 w-4 accent-[var(--color-accent)]" />
                  I have saved the key
                </label>
                <div className="mt-6 flex justify-end">
                  <Button variant="primary" disabled={!saved} onClick={() => setStep(2)}>Next: record runs <IconArrowRight size={16} /></Button>
                </div>
              </Panel>
            </motion.div>
          )}

          {step === 2 && made && (
            <motion.div key="sdk" initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -20 }}>
              <Panel glow className="p-6 md:p-8">
                <h1 className="text-3xl font-semibold tracking-tight">Record your first runs</h1>
                <ol className="mt-6 flex flex-col gap-6">
                  <li>
                    <p className="font-semibold">1. Give your app the key</p>
                    <div className="mt-2"><CopyBox value={`MCM_API_KEY=${made.key.slice(0, 13)}…`} label="Environment variable" /></div>
                    <p className="mt-1.5 text-xs text-muted">Set the full key you just saved as the environment variable MCM_API_KEY (and MCM_API_URL if the API is not on this machine).</p>
                  </li>
                  <li>
                    <p className="font-semibold">2. Wrap the model call you already make</p>
                    <pre className="mt-2 overflow-x-auto rounded-[12px] border border-rule bg-bg p-4 font-mono text-[12.5px] leading-relaxed text-dim">{snippet}</pre>
                    <p className="mt-1.5 text-xs text-muted">Your call does not change. Name the job for the kind of task, for example invoice-extract or ticket-classify.</p>
                  </li>
                  <li>
                    <p className="font-semibold">3. Tell it how to check an answer</p>
                    <p className="mt-1 text-sm text-dim">On the dashboard, create the job and choose how a correct answer is recognised: an answer key, a JSON schema, or a label you add later. Verdicts appear once a model has 25 checked runs.</p>
                  </li>
                </ol>
                <div className="mt-8 flex flex-wrap justify-end gap-2">
                  <Button variant="primary" onClick={() => navigate(`/p/${encodeURIComponent(made.id)}`)}>
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
