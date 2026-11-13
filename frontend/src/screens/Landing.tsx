/** The public front door: what the product does, how, and the way in. Signed-in visitors go straight to
 * their projects. Every figure on this page is an illustration and says so. */
import { motion } from "framer-motion";
import { Link, Navigate } from "react-router-dom";
import { useAuthConfig, useMe } from "../features/auth/hooks/useAuth";
import { hasApiKey } from "../shared/api/apiFetch";
import { IconAlert, IconArrowRight, IconCheck, IconDollar, IconFlask, IconLogo, IconShield, IconSpark } from "../ui/icons";
import { ButtonLink, Panel } from "../ui/primitives";

function Nav({ demo }: { demo: boolean }) {
  return (
    <header className="sticky top-0 z-40 border-b border-rule bg-bg/70 backdrop-blur-xl">
      <div className="mx-auto flex h-16 max-w-[1200px] items-center justify-between gap-4 px-4 md:px-6">
        <Link to="/" className="flex items-center gap-2.5">
          <IconLogo size={28} />
          <span className="text-[15px] font-semibold tracking-tight">Model &amp; Cost Memory</span>
        </Link>
        <nav className="hidden items-center gap-6 text-sm text-dim md:flex" aria-label="Page sections">
          <a href="#how" className="hover:text-ink">How it works</a>
          <a href="#what" className="hover:text-ink">What you get</a>
          <a href="#setup" className="hover:text-ink">Set up</a>
        </nav>
        <div className="flex items-center gap-2">
          {demo && <ButtonLink to="/p/demo" variant="ghost" size="sm">Demo</ButtonLink>}
          <ButtonLink to="/signin" variant="primary" size="sm">Sign in</ButtonLink>
        </div>
      </div>
    </header>
  );
}

/** The idea in one picture: models placed by cost and pass rate, the cheapest good-enough one picked. */
function Picture() {
  // Each label sits where it cannot touch a neighbour: dx/dy from the point, and which way it reads.
  const points = [
    { x: 90, y: 12, label: "large · $0.031", dx: -3.5, dy: 7, anchor: "end", win: false },
    { x: 64, y: 24, label: "mid · $0.012", dx: 0, dy: 8, anchor: "middle", win: false },
    { x: 32, y: 26, label: "mini · $0.003", dx: 0, dy: 8, anchor: "middle", win: true },
    { x: 14, y: 62, label: "nano · $0.0009", dx: 3.5, dy: -3, anchor: "start", win: false },
  ] as const;
  return (
    <svg viewBox="0 0 100 80" className="h-full w-full" role="img" aria-label="Example: four models by cost and pass rate; mini is the cheapest inside the good-enough band">
      <rect x="0" y="8" width="100" height="28" fill="var(--color-ok)" fillOpacity="0.07" />
      <line x1="0" y1="36" x2="100" y2="36" stroke="var(--color-ok)" strokeOpacity="0.45" strokeWidth="0.35" />
      {[20, 40, 60, 80].map((x) => <line key={x} x1={x} y1="2" x2={x} y2="76" stroke="var(--chart-grid)" strokeWidth="0.3" />)}
      <text x="1.5" y="6" fontSize="3.2" fill="#6fdc9c">good enough: within 3 points of the best</text>
      {points.map((p, i) => (
        <motion.g key={p.label} initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.5 + i * 0.15 }}>
          {p.win && (
            <motion.circle cx={p.x} cy={p.y} fill="none" stroke="var(--color-accent)" strokeWidth="0.7" animate={{ r: [4, 6.5, 4], opacity: [1, 0.35, 1] }} transition={{ duration: 2.2, repeat: Infinity }} />
          )}
          <circle cx={p.x} cy={p.y} r="2.2" fill={p.win ? "var(--color-accent)" : "#5d6380"} />
          <text x={p.x + p.dx} y={p.y + p.dy} fontSize="3.3" textAnchor={p.anchor} fill={p.win ? "#d8d3ff" : "#8d93b4"} fontFamily="var(--font-mono)">{p.label}</text>
        </motion.g>
      ))}
      <text x="1.5" y="79" fontSize="3.2" fill="#7d83a6">cheaper per successful answer ←</text>
      <text x="98.5" y="79" fontSize="3.2" fill="#7d83a6" textAnchor="end">→ costlier</text>
    </svg>
  );
}

const STEPS = [
  { title: "Record", text: "Wrap your existing model call. Each run is sent in the background: prompt, model, tokens, cost." },
  { title: "Check", text: "Every answer is marked pass or fail against your rule: an answer key, a schema, or a label you add later." },
  { title: "Remember", text: "Evidence ages. Fresh runs count more, and runs on a replaced model version fade faster." },
  { title: "Advise", text: "Per job: the cheapest model proven to pass within 3 points of the best, and what moving to it saves." },
];

const FEATURES = [
  { icon: IconDollar, title: "The cheapest model that still works", text: "A verdict per job, proven on your own traffic with a confidence range, never a public benchmark. Shown with the monthly saving and the expected change in failures." },
  { icon: IconAlert, title: "A warning when an upgrade breaks things", text: "Every model version change is checked against the one before it, and a model that quietly gets worse under the same name is caught too. Alerts go to Slack or Discord." },
  { icon: IconFlask, title: "New models tried for you", text: "When a cheaper model appears, a sample of your past prompts is replayed on it within a budget you set, so the evidence exists before you need it." },
  { icon: IconShield, title: "Your data has an end", text: "Prompts and answers are deleted after the retention you choose. The figures stay. Delete a project and everything in it goes." },
];

export default function Landing() {
  const me = useMe();
  const config = useAuthConfig();
  if (me.data) return <Navigate to="/projects" replace />;
  if (me.isError && hasApiKey()) return <Navigate to="/p/key" replace />;
  const demo = Boolean(config.data?.demo_project_id);

  return (
    <div className="min-h-screen">
      <Nav demo={demo} />

      <section className="relative overflow-hidden">
        <div aria-hidden className="pointer-events-none absolute -left-32 top-10 h-[520px] w-[520px] rounded-full bg-accent/15 blur-3xl" />
        <div aria-hidden className="pointer-events-none absolute -right-40 top-40 h-[420px] w-[420px] rounded-full bg-accent-2/10 blur-3xl" />
        <div className="relative mx-auto grid max-w-[1200px] items-center gap-12 px-4 pb-20 pt-16 md:px-6 lg:grid-cols-[1.05fr_1fr] lg:pt-24">
          <div>
            <motion.p initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="inline-flex items-center gap-2 rounded-full border border-rule bg-surface/60 px-3 py-1 text-xs font-semibold text-dim">
              <IconSpark size={13} className="text-accent" /> Long-term memory for the AI features you run
            </motion.p>
            <motion.h1 initial={{ opacity: 0, y: 14 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.05, duration: 0.6 }} className="mt-5 text-[42px] font-semibold leading-[1.02] tracking-tight md:text-[64px]">
              Stop paying for <span className="text-gradient">a bigger model</span> than the job needs.
            </motion.h1>
            <motion.p initial={{ opacity: 0, y: 14 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.15, duration: 0.6 }} className="mt-5 max-w-xl text-[17px] leading-relaxed text-dim">
              Record every AI call your product makes. The system checks each answer, remembers how every model really
              performs on your work, and tells you the cheapest model that still does each job, and when an upgrade
              quietly makes things worse.
            </motion.p>
            <motion.div initial={{ opacity: 0, y: 14 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.25 }} className="mt-8 flex flex-wrap gap-3">
              <ButtonLink to="/signin" variant="primary">Get started with Google <IconArrowRight size={16} /></ButtonLink>
              {demo && <ButtonLink to="/p/demo">Explore the live demo</ButtonLink>}
            </motion.div>
            <ul className="mt-8 flex flex-wrap gap-x-5 gap-y-2 text-sm text-dim">
              {["Three lines in your code", "Your provider, your keys", "Free to self-host"].map((t) => (
                <li key={t} className="flex items-center gap-1.5"><IconCheck size={15} className="text-ok" /> {t}</li>
              ))}
            </ul>
          </div>
          <motion.div initial={{ opacity: 0, scale: 0.97 }} animate={{ opacity: 1, scale: 1 }} transition={{ delay: 0.2, duration: 0.6 }}>
            <Panel glow className="p-5 md:p-6">
              <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-muted">Example verdict · invoice-extract</p>
              <p className="mt-2 text-2xl font-semibold tracking-tight">Move to <span className="text-gradient">mini</span></p>
              <p className="mt-1 text-sm text-dim">Passes 99.0% of the time, within 3 points of the best, at 10× less per answer.</p>
              <div className="mt-4 h-60 rounded-[14px] border border-rule bg-bg/50 p-3">
                <Picture />
              </div>
              <div className="mt-4 grid grid-cols-2 gap-3">
                <div className="rounded-[12px] border border-rule bg-surface-2/60 p-3">
                  <p className="text-[11px] text-muted">Saved per month</p>
                  <p className="text-xl font-semibold text-ok">$870</p>
                </div>
                <div className="rounded-[12px] border border-rule bg-surface-2/60 p-3">
                  <p className="text-[11px] text-muted">Proven on</p>
                  <p className="text-xl font-semibold">1,084 runs</p>
                </div>
              </div>
            </Panel>
          </motion.div>
        </div>
      </section>

      <section id="how" className="scroll-mt-20 border-t border-rule">
        <div className="mx-auto max-w-[1200px] px-4 py-20 md:px-6">
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-accent">How it works</p>
          <h2 className="mt-2 max-w-2xl text-3xl font-semibold tracking-tight md:text-4xl">From every AI call to a decision you can trust</h2>
          <ol className="mt-10 grid gap-4 md:grid-cols-4">
            {STEPS.map((s, i) => (
              <motion.li key={s.title} initial={{ opacity: 0, y: 16 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true }} transition={{ delay: i * 0.08 }} className="panel p-5">
                <span className="grid h-8 w-8 place-items-center rounded-full bg-accent-soft text-sm font-bold text-accent">{i + 1}</span>
                <p className="mt-4 font-semibold">{s.title}</p>
                <p className="mt-1.5 text-sm text-dim">{s.text}</p>
              </motion.li>
            ))}
          </ol>
        </div>
      </section>

      <section id="what" className="scroll-mt-20 border-t border-rule">
        <div className="mx-auto max-w-[1200px] px-4 py-20 md:px-6">
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-accent">What you get</p>
          <h2 className="mt-2 max-w-2xl text-3xl font-semibold tracking-tight md:text-4xl">Answers, not dashboards to dig through</h2>
          <div className="mt-10 grid gap-4 md:grid-cols-2">
            {FEATURES.map(({ icon: Icon, title, text }, i) => (
              <motion.div key={title} initial={{ opacity: 0, y: 16 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true }} transition={{ delay: i * 0.06 }} className="panel flex gap-4 p-6">
                <span className="grid h-10 w-10 shrink-0 place-items-center rounded-[12px] bg-accent-soft text-accent"><Icon size={20} /></span>
                <span>
                  <span className="block font-semibold">{title}</span>
                  <span className="mt-1.5 block text-sm leading-relaxed text-dim">{text}</span>
                </span>
              </motion.div>
            ))}
          </div>
        </div>
      </section>

      <section id="setup" className="scroll-mt-20 border-t border-rule">
        <div className="mx-auto grid max-w-[1200px] items-center gap-10 px-4 py-20 md:px-6 lg:grid-cols-2">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-accent">Set up</p>
            <h2 className="mt-2 text-3xl font-semibold tracking-tight md:text-4xl">Three lines around the call you already make</h2>
            <p className="mt-4 max-w-lg text-dim">
              Sign in, create a project, and put its key in your app. Your model call does not change: the recorder only
              watches, sends in the background, adds well under 5 ms, and never raises into your code.
            </p>
            <div className="mt-8"><ButtonLink to="/signin" variant="primary">Create your first project <IconArrowRight size={16} /></ButtonLink></div>
          </div>
          <Panel className="overflow-x-auto p-0">
            <div className="flex items-center gap-1.5 border-b border-rule px-4 py-3">
              {["#ff5f57", "#febc2e", "#28c840"].map((c) => <span key={c} className="h-2.5 w-2.5 rounded-full" style={{ background: c }} />)}
              <span className="ml-2 font-mono text-xs text-muted">your_app.py</span>
            </div>
            <pre className="p-5 font-mono text-[13px] leading-relaxed text-dim"><code>
<span className="text-accent">from</span> agent_memory.recorder <span className="text-accent">import</span> RunRecorder, provider_for{"\n\n"}
<span className="text-accent">with</span> <span className="text-ink">RunRecorder</span>(job=<span className="text-ok">"invoice-extract"</span>, provider=provider_for(client.base_url)) <span className="text-accent">as</span> rec:{"\n"}
{"    "}response = client.chat.completions.create(model=<span className="text-ok">"my-model"</span>, messages=[...]){"\n"}
{"    "}rec.capture(response, prompt=prompt, model=<span className="text-ok">"my-model"</span>, expected={"{"}<span className="text-ok">"total"</span>: 1250.0{"}"})
            </code></pre>
          </Panel>
        </div>
      </section>

      <footer className="border-t border-rule">
        <div className="mx-auto flex max-w-[1200px] flex-wrap items-center justify-between gap-3 px-4 py-8 text-xs text-muted md:px-6">
          <span className="flex items-center gap-2"><IconLogo size={18} /> Model &amp; Cost Memory</span>
          <span>Figures on this page are examples.</span>
        </div>
      </footer>
    </div>
  );
}
