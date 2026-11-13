/** The public front door. Signed-in visitors go straight to their projects.
 * Every figure on this page is either a measured result from reports/ (the numbers row says so) or a
 * worked example, and the example cards say "example". */
import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  AnimatePresence,
  motion,
  useInView,
  useMotionValue,
  useReducedMotion,
  useScroll,
  useSpring,
  useTransform,
  type MotionValue,
} from "framer-motion";
import { Link, Navigate } from "react-router-dom";
import { useAuthConfig, useMe } from "../features/auth/hooks/useAuth";
import { hasApiKey } from "../shared/api/apiFetch";
import { CountUp } from "../shared/motion/CountUp";
import { IconAlert, IconArrowRight, IconBolt, IconCheck, IconDollar, IconFlask, IconLogo, IconShield, IconSpark } from "../ui/icons";
import { ButtonLink, cx } from "../ui/primitives";

/* ----------------------------------------------------------------------------------------------- */
/* Small pieces                                                                                     */

/** Fades and rises when it scrolls into view, once. */
function Reveal({ children, delay = 0, className, y = 24 }: { children: ReactNode; delay?: number; className?: string; y?: number }) {
  return (
    <motion.div
      initial={{ opacity: 0, y }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: "-80px" }}
      transition={{ duration: 0.7, delay, ease: [0.22, 1, 0.36, 1] }}
      className={className}
    >
      {children}
    </motion.div>
  );
}

/** A number that counts up the first time it is seen. */
function Figure({ value, prefix = "", suffix = "" }: { value: number; prefix?: string; suffix?: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const seen = useInView(ref, { once: true, margin: "-60px" });
  return (
    <span ref={ref} className="tabular-nums">
      {seen ? <CountUp value={value} prefix={prefix} suffix={suffix} duration={1.4} /> : `${prefix}0${suffix}`}
    </span>
  );
}

const TASKS = ["extracts invoices", "classifies tickets", "answers support chats", "reads receipts", "summarises calls"];

/** The headline paragraph's rotating task. */
function Rotating() {
  const [i, setI] = useState(0);
  const reduce = useReducedMotion();
  useEffect(() => {
    if (reduce) return;
    const t = setInterval(() => setI((n) => (n + 1) % TASKS.length), 2400);
    return () => clearInterval(t);
  }, [reduce]);
  return (
    <span className="relative inline-grid overflow-hidden align-bottom">
      <AnimatePresence mode="popLayout" initial={false}>
        <motion.span
          key={TASKS[i]}
          initial={{ y: "100%", opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          exit={{ y: "-100%", opacity: 0 }}
          transition={{ duration: 0.45, ease: [0.22, 1, 0.36, 1] }}
          className="text-gradient whitespace-nowrap font-semibold"
        >
          {TASKS[i]}
        </motion.span>
      </AnimatePresence>
    </span>
  );
}

/* ----------------------------------------------------------------------------------------------- */
/* The hero stage: glossy rings, floating cards that follow the mouse, and the verdict map          */

const RINGS = [
  { inset: 0, outer: 318, inner: 294, dur: 26, dir: 1, from: 0, a: "rgba(139,125,255,0.9)", b: "rgba(63,208,242,0.9)", glow: "rgba(139,125,255,0.55)" },
  { inset: 84, outer: 234, inner: 216, dur: 18, dir: -1, from: 120, a: "rgba(63,208,242,0.85)", b: "rgba(180,170,255,0.9)", glow: "rgba(63,208,242,0.5)" },
  { inset: 168, outer: 150, inner: 136, dur: 12, dir: 1, from: 240, a: "rgba(61,220,132,0.85)", b: "rgba(139,125,255,0.9)", glow: "rgba(61,220,132,0.45)" },
];

function Rings() {
  const reduce = useReducedMotion();
  return (
    <div aria-hidden className="pointer-events-none absolute inset-0 grid place-items-center" style={{ perspective: "1200px" }}>
      <div className="relative h-[640px] w-[640px]" style={{ transform: "rotateX(60deg) rotateZ(-14deg)", transformStyle: "preserve-3d" }}>
        {RINGS.map((r) => {
          const mask = `radial-gradient(circle, transparent 0 ${r.inner - 1}px, #000 ${r.inner}px ${r.outer}px, transparent ${r.outer + 1}px)`;
          return (
            <motion.div
              key={r.inset}
              className="absolute rounded-full"
              style={{
                inset: r.inset,
                background: `conic-gradient(from ${r.from}deg, transparent 0 55%, ${r.a} 72%, ${r.b} 88%, transparent 100%)`,
                WebkitMask: mask,
                mask,
                filter: `drop-shadow(0 0 16px ${r.glow})`,
              }}
              animate={reduce ? {} : { rotate: 360 * r.dir }}
              transition={{ repeat: Infinity, duration: r.dur, ease: "linear" }}
            />
          );
        })}
        {RINGS.map((r) => (
          <div key={`track-${r.inset}`} className="absolute rounded-full border border-white/[0.06]" style={{ inset: r.inset }} />
        ))}
      </div>
    </div>
  );
}

const MAP_POINTS = [
  { x: 86, y: 14, label: "large", cost: "$0.031", win: false },
  { x: 62, y: 22, label: "mid", cost: "$0.012", win: false },
  { x: 31, y: 27, label: "mini", cost: "$0.003", win: true },
  { x: 14, y: 64, label: "nano", cost: "$0.0009", win: false },
];

/** The idea in one picture: models by cost and pass rate, the cheapest good-enough one picked. */
function VerdictMap() {
  return (
    <svg viewBox="0 0 100 80" className="h-full w-full" role="img" aria-label="Example: four models by cost and pass rate; mini is the cheapest inside the good-enough band">
      <defs>
        <linearGradient id="band" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#3ddc84" stopOpacity="0.16" />
          <stop offset="1" stopColor="#3ddc84" stopOpacity="0.02" />
        </linearGradient>
      </defs>
      <rect x="0" y="6" width="100" height="30" fill="url(#band)" />
      <line x1="0" y1="36" x2="100" y2="36" stroke="#3ddc84" strokeOpacity="0.5" strokeWidth="0.35" strokeDasharray="1.5 1.2" />
      {[20, 40, 60, 80].map((x) => <line key={x} x1={x} y1="2" x2={x} y2="76" stroke="rgba(255,255,255,0.05)" strokeWidth="0.3" />)}
      <text x="1.5" y="4.5" fontSize="3" fill="#6fdc9c" fontWeight="600">GOOD ENOUGH · within 3 points of the best</text>
      {MAP_POINTS.map((p, i) => (
        <motion.g key={p.label} initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 1.1 + i * 0.18, duration: 0.5 }}>
          {p.win && (
            <motion.circle cx={p.x} cy={p.y} fill="none" stroke="#8b7dff" strokeWidth="0.7" animate={{ r: [4, 7, 4], opacity: [1, 0.25, 1] }} transition={{ duration: 2.4, repeat: Infinity, delay: 1.8 }} />
          )}
          <circle cx={p.x} cy={p.y} r={p.win ? 2.6 : 2.1} fill={p.win ? "#8b7dff" : "#4c5273"} />
          <text x={p.x} y={p.y + 8} fontSize="3.1" textAnchor="middle" fill={p.win ? "#d8d3ff" : "#8d93b4"} fontFamily="var(--font-mono)">{p.label} · {p.cost}</text>
        </motion.g>
      ))}
      <text x="1.5" y="79" fontSize="3" fill="#6c7294">cheaper per successful answer ←</text>
      <text x="98.5" y="79" fontSize="3" fill="#6c7294" textAnchor="end">→ costlier</text>
    </svg>
  );
}

function FloatCard({ children, className, x, y, delay = 0 }: { children: ReactNode; className?: string; x?: MotionValue<number>; y?: MotionValue<number>; delay?: number }) {
  return (
    <motion.div
      style={{ x, y }}
      initial={{ opacity: 0, scale: 0.94 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ delay, duration: 0.8, ease: [0.22, 1, 0.36, 1] }}
      className={cx("rounded-[16px] border border-white/10 bg-[#111527]/90 p-4 shadow-[0_30px_60px_-20px_rgba(0,0,0,0.8)] backdrop-blur-xl", className)}
    >
      {children}
    </motion.div>
  );
}

function VerdictCard() {
  return (
    <>
      <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted">Verdict</p>
      <p className="mt-1 text-lg font-semibold">Move to <span className="text-gradient">mini</span></p>
      <p className="mt-1 text-xs text-dim">99.0% pass rate, 10× cheaper per answer</p>
      <p className="mt-3 flex items-baseline gap-1.5 text-2xl font-semibold text-ok"><IconDollar size={18} /> 870<span className="text-xs font-medium text-dim">saved / month</span></p>
    </>
  );
}

function DropCard() {
  return (
    <>
      <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.14em] text-bad"><IconAlert size={13} /> Silent drop caught</p>
      <p className="mt-1 font-mono text-sm text-ink">acme-large</p>
      <p className="mt-1 text-xs text-dim">Same name, worse answers since Tuesday</p>
      <p className="mt-2 flex items-baseline gap-2 font-mono text-lg font-semibold"><span className="text-dim">97.5%</span><span className="text-muted">→</span><span className="text-bad">90.9%</span></p>
    </>
  );
}

function RetestCard({ progress }: { progress: number }) {
  return (
    <>
      <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.14em] text-accent"><IconFlask size={13} /> Re-testing a new model</p>
      <p className="mt-1 font-mono text-sm text-ink">gemini-3.5-flash-lite</p>
      <div className="mt-2.5 h-1.5 overflow-hidden rounded-full bg-surface-3">
        <motion.div className="h-full rounded-full bg-gradient-to-r from-[#9d91ff] to-accent-2" animate={{ width: `${(progress / 50) * 100}%` }} transition={{ duration: 0.2 }} />
      </div>
      <p className="mt-1.5 flex justify-between text-[11px] text-muted"><span className="tabular-nums">{progress} of 50 prompts</span><span className="text-ok">100% passing · $0.01 spent</span></p>
    </>
  );
}

function MapCard({ x, y }: { x?: MotionValue<number>; y?: MotionValue<number> }) {
  return (
    <motion.div
      style={{ x, y }}
      initial={{ opacity: 0, scale: 0.96 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ delay: 0.4, duration: 0.9 }}
      className="rounded-[20px] border border-white/10 bg-[#0d1020]/85 p-4 shadow-[0_40px_80px_-30px_rgba(0,0,0,0.9)] backdrop-blur-xl"
    >
      <div className="mb-2 flex items-center justify-between">
        <span className="text-[11px] font-semibold uppercase tracking-[0.16em] text-muted">invoice-extract · example</span>
        <span className="rounded-full bg-ok-soft px-2 py-0.5 text-[11px] font-semibold text-ok">Cheaper model found</span>
      </div>
      <div className="h-56">
        <VerdictMap />
      </div>
    </motion.div>
  );
}

function Stage() {
  const ref = useRef<HTMLDivElement>(null);
  const reduce = useReducedMotion();
  const mx = useMotionValue(0);
  const my = useMotionValue(0);
  const sx = useSpring(mx, { stiffness: 60, damping: 20 });
  const sy = useSpring(my, { stiffness: 60, damping: 20 });
  const ax = useTransform(sx, (v) => (reduce ? 0 : v * -18));
  const ay = useTransform(sy, (v) => (reduce ? 0 : v * -18));
  const bx = useTransform(sx, (v) => (reduce ? 0 : v * 14));
  const by = useTransform(sy, (v) => (reduce ? 0 : v * 14));
  const cx2 = useTransform(sx, (v) => (reduce ? 0 : v * -9));
  const cy2 = useTransform(sy, (v) => (reduce ? 0 : v * -9));
  const mapx = useTransform(sx, (v) => (reduce ? 0 : v * 5));
  const mapy = useTransform(sy, (v) => (reduce ? 0 : v * 5));
  const [progress, setProgress] = useState(12);
  useEffect(() => {
    if (reduce) return;
    const t = setInterval(() => setProgress((p) => (p >= 50 ? 12 : p + 1)), 180);
    return () => clearInterval(t);
  }, [reduce]);

  return (
    <>
      {/* Wide screens: the rings, the map in the middle, and cards that follow the mouse */}
      <div
        ref={ref}
        className="relative mx-auto hidden h-[640px] w-full max-w-[680px] lg:block"
        onMouseMove={(e) => {
          const r = ref.current?.getBoundingClientRect();
          if (!r) return;
          mx.set(((e.clientX - r.left) / r.width - 0.5) * 2);
          my.set(((e.clientY - r.top) / r.height - 0.5) * 2);
        }}
        onMouseLeave={() => {
          mx.set(0);
          my.set(0);
        }}
      >
        <Rings />
        <div className="absolute left-1/2 top-1/2 w-[78%] max-w-[500px] -translate-x-1/2 -translate-y-1/2">
          <MapCard x={mapx} y={mapy} />
        </div>
        <FloatCard x={ax} y={ay} delay={1.6} className="absolute -left-4 top-6 w-56"><VerdictCard /></FloatCard>
        <FloatCard x={bx} y={by} delay={1.9} className="absolute -right-6 top-24 w-60"><DropCard /></FloatCard>
        <FloatCard x={cx2} y={cy2} delay={2.2} className="absolute bottom-8 left-2 w-64"><RetestCard progress={progress} /></FloatCard>
      </div>

      {/* Phones and tablets: the same pieces, stacked */}
      <div className="flex flex-col gap-3 lg:hidden">
        <MapCard />
        <div className="grid gap-3 sm:grid-cols-3">
          <FloatCard delay={0.8}><VerdictCard /></FloatCard>
          <FloatCard delay={1.0}><DropCard /></FloatCard>
          <FloatCard delay={1.2}><RetestCard progress={progress} /></FloatCard>
        </div>
      </div>
    </>
  );
}

/* ----------------------------------------------------------------------------------------------- */
/* Sections                                                                                         */

const PROVIDERS = ["OpenAI", "Google Gemini", "Anthropic", "Groq", "Together AI", "Mistral", "Ollama", "Any OpenAI-compatible API"];

function Marquee() {
  const reduce = useReducedMotion();
  const items = [...PROVIDERS, ...PROVIDERS];
  return (
    <div className="relative overflow-hidden border-y border-rule py-5" aria-label="Works with every provider">
      <div aria-hidden className="pointer-events-none absolute inset-y-0 left-0 z-10 w-32 bg-gradient-to-r from-bg to-transparent" />
      <div aria-hidden className="pointer-events-none absolute inset-y-0 right-0 z-10 w-32 bg-gradient-to-l from-bg to-transparent" />
      <motion.ul
        className="flex w-max gap-12 whitespace-nowrap px-6 text-sm font-semibold text-muted"
        animate={reduce ? {} : { x: ["0%", "-50%"] }}
        transition={{ repeat: Infinity, duration: 28, ease: "linear" }}
      >
        {items.map((name, i) => (
          <li key={`${name}-${i}`} className="flex items-center gap-3">
            <span className="h-1.5 w-1.5 rounded-full bg-accent/60" aria-hidden />
            {name}
          </li>
        ))}
      </motion.ul>
    </div>
  );
}

/** Measured results from reports/ (see the README), not marketing numbers. */
const FIGURES = [
  { value: 93, suffix: "%", label: "of 5-point quality drops caught", note: "after a model upgrade, 100 trials" },
  { value: 2, suffix: "%", label: "false alarms", note: "on upgrades that changed nothing" },
  { value: 76, suffix: "%", label: "of the time on the right model", note: "against 25% for a frozen test set" },
  { value: 9, suffix: "%", label: "of spend keeps the evidence fresh", note: "re-tests, always within a budget" },
];

const STEPS = [
  { icon: IconBolt, title: "Record", text: "Three lines around the call you already make. Prompt, model, tokens and cost are sent in the background; your call never changes." },
  { icon: IconCheck, title: "Check", text: "Every answer is marked pass or fail by your rule: an answer key, a JSON schema, or a label you add later." },
  { icon: IconSpark, title: "Remember", text: "Evidence ages. Fresh runs count more, runs on a replaced model version fade faster, and new models get re-tested on your prompts." },
  { icon: IconDollar, title: "Advise", text: "Per job: the cheapest model proven to pass within 3 points of the best, what moving saves, and the runs behind it." },
];

const FEATURES = [
  { icon: IconDollar, title: "The cheapest model that still works", text: "A verdict per job, proven on your own traffic with a confidence range, never a public benchmark. With the monthly saving and the expected change in failures." },
  { icon: IconAlert, title: "A warning when an upgrade breaks things", text: "Every version change is compared with the one before it on the same mix of inputs, and a model that quietly gets worse under the same name is caught too. Alerts go to Slack or Discord." },
  { icon: IconFlask, title: "New models tried for you", text: "When a cheaper model appears, a sample of your past prompts is replayed on it within a budget you set, so the evidence exists before you need it." },
  { icon: IconShield, title: "Your data has an end", text: "Prompts and answers are deleted after the retention you choose; the figures stay. Delete a project and everything in it goes." },
];

function Nav({ demo }: { demo: boolean }) {
  const { scrollY } = useScroll();
  const [solid, setSolid] = useState(false);
  useEffect(() => scrollY.on("change", (v) => setSolid(v > 24)), [scrollY]);
  return (
    <header className={cx("fixed inset-x-0 top-0 z-40 transition-colors duration-300", solid ? "border-b border-rule bg-bg/80 backdrop-blur-xl" : "border-b border-transparent")}>
      <div className="mx-auto flex h-16 max-w-[1200px] items-center justify-between gap-4 px-4 md:px-6">
        <Link to="/" className="flex items-center gap-2.5">
          <IconLogo size={28} />
          <span className="text-[15px] font-semibold tracking-tight">Model &amp; Cost Memory</span>
        </Link>
        <nav className="hidden items-center gap-7 text-sm text-dim md:flex" aria-label="Page sections">
          <a href="#how" className="hover:text-ink">How it works</a>
          <a href="#what" className="hover:text-ink">What you get</a>
          <a href="#numbers" className="hover:text-ink">Results</a>
          <a href="#setup" className="hover:text-ink">Set up</a>
        </nav>
        <div className="flex items-center gap-2">
          {demo && <ButtonLink to="/p/demo" variant="ghost" size="sm">Live demo</ButtonLink>}
          <ButtonLink to="/signin" variant="primary" size="sm">Sign in</ButtonLink>
        </div>
      </div>
    </header>
  );
}

export default function Landing() {
  const me = useMe();
  const config = useAuthConfig();
  const { scrollYProgress } = useScroll();
  const glowY = useTransform(scrollYProgress, [0, 1], ["0%", "40%"]);
  if (me.data) return <Navigate to="/projects" replace />;
  if (me.isError && hasApiKey()) return <Navigate to="/p/key" replace />;
  const demo = Boolean(config.data?.demo_project_id);

  return (
    <div className="min-h-screen overflow-x-hidden">
      <Nav demo={demo} />

      {/* Hero */}
      <section className="relative pt-16">
        <motion.div aria-hidden style={{ y: glowY }} className="pointer-events-none absolute -left-40 top-0 h-[640px] w-[640px] rounded-full bg-accent/20 blur-3xl" />
        <div aria-hidden className="pointer-events-none absolute -right-48 top-24 h-[520px] w-[520px] rounded-full bg-accent-2/10 blur-3xl" />
        <div className="relative mx-auto grid max-w-[1200px] items-center gap-10 px-4 pb-16 pt-14 md:px-6 lg:grid-cols-[1fr_1.1fr] lg:pt-20">
          <div className="min-w-0">
            <motion.p initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="inline-flex items-center gap-2 rounded-full border border-rule bg-surface/60 px-3 py-1 text-xs font-semibold text-dim">
              <span className="relative flex h-2 w-2"><span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-ok opacity-60 motion-reduce:animate-none" /><span className="relative inline-flex h-2 w-2 rounded-full bg-ok" /></span>
              Long-term memory for the AI features you run
            </motion.p>
            <motion.h1 initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.05, duration: 0.7 }} className="mt-5 text-[40px] font-semibold leading-[1.02] tracking-tight md:text-[62px]">
              Stop paying for a bigger model than the job needs.
            </motion.h1>
            <motion.p initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.15, duration: 0.7 }} className="mt-5 max-w-xl text-[17px] leading-relaxed text-dim">
              Record every AI call. Each answer is checked, every model's real record on your work is remembered,
              and you get the cheapest model that still <Rotating />, plus a warning the moment an upgrade quietly
              makes things worse.
            </motion.p>
            <motion.div initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.25 }} className="mt-8 flex flex-wrap gap-3">
              <ButtonLink to="/signin" variant="primary" className="px-5 py-2.5">Get started with Google <IconArrowRight size={16} /></ButtonLink>
              {demo && <ButtonLink to="/p/demo" className="px-5 py-2.5">Explore the live demo</ButtonLink>}
            </motion.div>
            <motion.ul initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.5 }} className="mt-8 flex flex-wrap gap-x-5 gap-y-2 text-sm text-dim">
              {["Three lines in your code", "Your provider, your keys", "Free to self-host"].map((t) => (
                <li key={t} className="flex items-center gap-1.5"><IconCheck size={15} className="text-ok" /> {t}</li>
              ))}
            </motion.ul>
          </div>
          <Stage />
        </div>
      </section>

      <Marquee />

      {/* Numbers */}
      <section id="numbers" className="scroll-mt-20">
        <div className="mx-auto max-w-[1200px] px-4 py-20 md:px-6">
          <Reveal>
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-accent">Measured, not promised</p>
            <h2 className="mt-2 max-w-2xl text-3xl font-semibold tracking-tight md:text-4xl">How well it works, in numbers</h2>
          </Reveal>
          <dl className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {FIGURES.map((f, i) => (
              <Reveal key={f.label} delay={i * 0.08}>
                <div className="panel p-6">
                  <dd className="text-[44px] font-semibold leading-none tracking-tight"><span className="text-gradient"><Figure value={f.value} suffix={f.suffix} /></span></dd>
                  <dt className="mt-3 text-sm font-semibold text-ink">{f.label}</dt>
                  <p className="mt-1 text-xs text-muted">{f.note}</p>
                </div>
              </Reveal>
            ))}
          </dl>
          <p className="mt-4 text-xs text-muted">Results from the simulated-time harness run through the production code; the reports are in the repository.</p>
        </div>
      </section>

      {/* How it works: a dark band with a line that draws itself through the steps */}
      <section id="how" className="relative scroll-mt-20 overflow-hidden border-y border-rule bg-[#090b16]">
        <div aria-hidden className="pointer-events-none absolute left-1/2 top-0 h-[400px] w-[800px] -translate-x-1/2 rounded-full bg-accent/10 blur-3xl" />
        <div className="relative mx-auto max-w-[1200px] px-4 py-20 md:px-6">
          <Reveal>
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-accent">How it works</p>
            <h2 className="mt-2 max-w-2xl text-3xl font-semibold tracking-tight md:text-4xl">From every AI call to a decision you can trust</h2>
          </Reveal>
          <div className="relative mt-12">
            <motion.div aria-hidden className="absolute left-0 top-7 hidden h-px bg-gradient-to-r from-accent via-accent-2 to-ok lg:block" initial={{ width: 0 }} whileInView={{ width: "100%" }} viewport={{ once: true }} transition={{ duration: 1.6, ease: "easeOut" }} />
            <ol className="grid gap-5 md:grid-cols-2 lg:grid-cols-4">
              {STEPS.map(({ icon: Icon, title, text }, i) => (
                <Reveal key={title} delay={0.15 + i * 0.15}>
                  <li className="panel relative h-full p-6">
                    <span className="grid h-14 w-14 place-items-center rounded-[16px] bg-gradient-to-br from-[#9d91ff]/25 to-accent-2/15 text-accent ring-1 ring-accent/30"><Icon size={24} /></span>
                    <span className="absolute right-5 top-5 font-mono text-xs text-muted">0{i + 1}</span>
                    <p className="mt-5 text-lg font-semibold">{title}</p>
                    <p className="mt-1.5 text-sm leading-relaxed text-dim">{text}</p>
                  </li>
                </Reveal>
              ))}
            </ol>
          </div>
        </div>
      </section>

      {/* What you get */}
      <section id="what" className="scroll-mt-20">
        <div className="mx-auto max-w-[1200px] px-4 py-20 md:px-6">
          <Reveal>
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-accent">What you get</p>
            <h2 className="mt-2 max-w-2xl text-3xl font-semibold tracking-tight md:text-4xl">Answers, not dashboards to dig through</h2>
          </Reveal>
          <div className="mt-10 grid gap-4 md:grid-cols-2">
            {FEATURES.map(({ icon: Icon, title, text }, i) => (
              <Reveal key={title} delay={i * 0.08}>
                <motion.div whileHover={{ y: -4 }} className="panel group flex h-full gap-5 p-6 transition-colors hover:border-rule-strong">
                  <span className="grid h-11 w-11 shrink-0 place-items-center rounded-[12px] bg-accent-soft text-accent transition-transform group-hover:scale-110"><Icon size={20} /></span>
                  <span>
                    <span className="block text-[17px] font-semibold">{title}</span>
                    <span className="mt-1.5 block text-sm leading-relaxed text-dim">{text}</span>
                  </span>
                </motion.div>
              </Reveal>
            ))}
          </div>
        </div>
      </section>

      {/* Set up */}
      <section id="setup" className="scroll-mt-20 border-t border-rule">
        <div className="mx-auto grid max-w-[1200px] items-center gap-10 px-4 py-20 md:px-6 lg:grid-cols-2">
          <Reveal>
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-accent">Set up</p>
            <h2 className="mt-2 text-3xl font-semibold tracking-tight md:text-4xl">Three lines around the call you already make</h2>
            <p className="mt-4 max-w-lg text-dim">
              Sign in, create a project, and put its key in your app. The recorder only watches: it sends in the
              background, adds well under 5 ms, and never raises into your code.
            </p>
            <div className="mt-8"><ButtonLink to="/signin" variant="primary">Create your first project <IconArrowRight size={16} /></ButtonLink></div>
          </Reveal>
          <Reveal delay={0.1}>
            <div className="panel overflow-hidden p-0">
              <div className="flex items-center gap-1.5 border-b border-rule px-4 py-3">
                {["#ff5f57", "#febc2e", "#28c840"].map((c) => <span key={c} className="h-2.5 w-2.5 rounded-full" style={{ background: c }} />)}
                <span className="ml-2 font-mono text-xs text-muted">your_app.py</span>
              </div>
              <pre className="overflow-x-auto p-5 font-mono text-[13px] leading-relaxed text-dim"><code>
<span className="text-accent">from</span> agent_memory.recorder <span className="text-accent">import</span> RunRecorder, provider_for{"\n\n"}
<span className="text-accent">with</span> <span className="text-ink">RunRecorder</span>(job=<span className="text-ok">"invoice-extract"</span>, provider=provider_for(client.base_url)) <span className="text-accent">as</span> rec:{"\n"}
{"    "}response = client.chat.completions.create(model=<span className="text-ok">"my-model"</span>, messages=[...]){"\n"}
{"    "}rec.capture(response, prompt=prompt, model=<span className="text-ok">"my-model"</span>, expected={"{"}<span className="text-ok">"total"</span>: 1250.0{"}"})
              </code></pre>
            </div>
          </Reveal>
        </div>
      </section>

      {/* Call to action */}
      <section className="px-4 pb-20 md:px-6">
        <Reveal>
          <div className="relative mx-auto max-w-[1200px] overflow-hidden rounded-[28px] border border-accent/30 bg-gradient-to-br from-[#171a3a] via-[#0f1226] to-[#0a1a1f] px-6 py-14 text-center md:py-20">
            <div aria-hidden className="pointer-events-none absolute -left-20 -top-20 h-80 w-80 rounded-full bg-accent/30 blur-3xl" />
            <div aria-hidden className="pointer-events-none absolute -bottom-24 -right-20 h-80 w-80 rounded-full bg-accent-2/20 blur-3xl" />
            <h2 className="relative mx-auto max-w-2xl text-3xl font-semibold tracking-tight md:text-5xl">Find out what your AI features <span className="text-gradient">should</span> cost</h2>
            <p className="relative mx-auto mt-4 max-w-xl text-dim">A verdict per job appears once a model has 25 checked runs. For most jobs that is the first day.</p>
            <div className="relative mt-8 flex flex-wrap justify-center gap-3">
              <ButtonLink to="/signin" variant="primary" className="px-6 py-3">Get started with Google <IconArrowRight size={16} /></ButtonLink>
              {demo && <ButtonLink to="/p/demo" className="px-6 py-3">See the live demo</ButtonLink>}
            </div>
          </div>
        </Reveal>
      </section>

      <footer className="border-t border-rule">
        <div className="mx-auto grid max-w-[1200px] gap-10 px-4 py-12 md:grid-cols-[1.4fr_1fr_1fr_1fr] md:px-6">
          <div>
            <span className="flex items-center gap-2 font-semibold"><IconLogo size={22} /> Model &amp; Cost Memory</span>
            <p className="mt-3 max-w-xs text-sm text-dim">Long-term memory of how every model really performs on your work, so each job runs on the cheapest one that still does it.</p>
          </div>
          {[
            { title: "Product", links: [["How it works", "#how"], ["What you get", "#what"], ["Results", "#numbers"], ["Set up", "#setup"]] },
            { title: "Get in", links: [["Sign in", "/signin"], ["Use a project key", "/key"], ...(demo ? [["Live demo", "/p/demo"]] : [])] },
            { title: "Project", links: [["Source code", "https://github.com/tannaya7/model-cost-memory"], ["Architecture", "https://github.com/tannaya7/model-cost-memory/blob/POC/docs/ARCHITECTURE.md"], ["Measured results", "https://github.com/tannaya7/model-cost-memory/tree/POC/reports"]] },
          ].map((col) => (
            <div key={col.title}>
              <p className="text-xs font-semibold uppercase tracking-[0.14em] text-muted">{col.title}</p>
              <ul className="mt-3 flex flex-col gap-2 text-sm text-dim">
                {col.links.map(([label, href]) => (
                  <li key={label}>
                    {href.startsWith("http") ? (
                      <a href={href} target="_blank" rel="noopener noreferrer" className="hover:text-ink">{label}</a>
                    ) : href.startsWith("#") ? (
                      <a href={href} className="hover:text-ink">{label}</a>
                    ) : (
                      <Link to={href} className="hover:text-ink">{label}</Link>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
        <div className="border-t border-rule">
          <div className="mx-auto flex max-w-[1200px] flex-wrap items-center justify-between gap-2 px-4 py-5 text-xs text-muted md:px-6">
            <span>© 2026 Model &amp; Cost Memory</span>
            <span>The verdict and alert cards on this page are worked examples; the numbers row is measured.</span>
          </div>
        </div>
      </footer>
    </div>
  );
}
