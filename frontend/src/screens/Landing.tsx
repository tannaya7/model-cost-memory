/** The public front door, for everyone: a signed-in visitor gets a way to their projects in the nav.
 * Every figure on this page is either a measured result from reports/ (the numbers row says so) or a
 * worked example, and the example cards say "example". */
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
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
import { Link } from "react-router-dom";
import { useAuthConfig, useMe } from "../features/auth/hooks/useAuth";
import { CountUp } from "../shared/motion/CountUp";
import { IconAlert, IconArrowRight, IconBolt, IconCheck, IconDollar, IconFlask, IconLogo, IconShield, IconSpark } from "../ui/icons";
import { ButtonLink, cx } from "../ui/primitives";
import { ThemeToggle } from "../ui/ThemeToggle";

/* ----------------------------------------------------------------------------------------------- */
/* Small pieces                                                                                     */

/** Rises into place when scrolled into view, and sinks back out when scrolled away (both directions). */
function Reveal({ children, delay = 0, className, y = 24 }: { children: ReactNode; delay?: number; className?: string; y?: number }) {
  return (
    <motion.div
      initial={{ opacity: 0, y }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: false, amount: 0.2 }}
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
/* The hero scene: a glass tube over white slabs, with runs (gold coins) flowing through it.        */
/* Each coin is one AI call: recorded at the top, checked at the glowing gate (it gains a violet   */
/* halo when it passes), and remembered on the slab below. The scene tilts toward the mouse.        */

const TUBE = "M 470 -40 C 470 80, 300 120, 350 240 S 120 360, 190 470 S 330 600, 300 700";
const RUN_SECONDS = 7;
const COINS = 3;
const GATE = 0.4; // where along the tube a run is checked
const STAGES = [
  { at: 0.2, label: "Recorded", icon: IconBolt, side: "left" },
  { at: GATE, label: "Checked", icon: IconCheck, side: "right" },
  { at: 0.74, label: "Remembered", icon: IconSpark, side: "left" },
] as const;
const FALLBACK: Record<number, { x: number; y: number }> = { 0.2: { x: 400, y: 150 }, [GATE]: { x: 330, y: 268 }, 0.74: { x: 200, y: 500 } };

type Pt = [number, number];

/** An isometric slab: top face, two front faces, and a neon line along one bottom edge. */
function Slab({ top, depth, glow, id }: { top: [Pt, Pt, Pt, Pt]; depth: number; glow: "left" | "right"; id: string }) {
  const [a, b, c, d] = top; // back, right, front, left corners
  const pts = (ps: Pt[]) => ps.map((p) => p.join(",")).join(" ");
  const down = (p: Pt): Pt => [p[0], p[1] + depth];
  const [e1, e2] = glow === "left" ? [down(d), down(c)] : [down(c), down(b)];
  return (
    <g>
      <polygon points={pts([a, b, c, d].map(([x, y]) => [x + 34, y + depth + 22] as Pt))} fill="var(--scene-shadow)" filter="url(#scene-blur-lg)" />
      <polygon points={pts([d, c, down(c), down(d)])} fill="var(--scene-slab-front)" />
      <polygon points={pts([c, b, down(b), down(c)])} fill="var(--scene-slab-side)" />
      <polygon points={pts([a, b, c, d])} fill={`url(#${id}-top)`} />
      <polyline points={pts([d, a, b])} fill="none" stroke="var(--glass-border)" strokeWidth="1.2" opacity="0.8" />
      <line x1={e1[0]} y1={e1[1]} x2={e2[0]} y2={e2[1]} stroke="#c026d3" strokeWidth="16" filter="url(#scene-blur-lg)" className="scene-pulse" />
      <line x1={e1[0]} y1={e1[1]} x2={e2[0]} y2={e2[1]} stroke="#a855f7" strokeWidth="5" filter="url(#scene-blur-sm)" />
      <line x1={e1[0]} y1={e1[1] - 1} x2={e2[0]} y2={e2[1] - 1} stroke="#f5e8ff" strokeWidth="1.4" />
    </g>
  );
}

/** Small violet specks scattered over the floor, a third of them twinkling. */
const SPECKS = Array.from({ length: 46 }, (_, i) => {
  const r = (n: number) => (((Math.sin(i * 127.1 + n * 311.7) * 43758.5453) % 1) + 1) % 1;
  return { x: r(1) * 640, y: r(2) * 640, s: 0.8 + r(3) * 1.4, d: r(4) * 4, twinkle: i % 3 === 0 };
});

function Scene({ reduce }: { reduce: boolean }) {
  const tube = useRef<SVGPathElement>(null);
  const [points, setPoints] = useState(FALLBACK);
  useLayoutEffect(() => {
    const path = tube.current;
    if (!path || typeof path.getTotalLength !== "function") return;
    try {
      const len = path.getTotalLength();
      const next: Record<number, { x: number; y: number }> = {};
      for (const s of STAGES) {
        const p = path.getPointAtLength(len * s.at);
        next[s.at] = { x: p.x, y: p.y };
      }
      setPoints(next);
    } catch {
      /* keep the fallback positions */
    }
  }, []);
  const gate = points[GATE];
  const spacing = RUN_SECONDS / COINS;
  const firstAtGate = (GATE * RUN_SECONDS) % spacing;
  const times = `0;${(GATE - 0.005).toFixed(3)};${(GATE + 0.02).toFixed(3)};1`;

  return (
    <div className="absolute inset-0">
      <svg viewBox="0 0 640 640" className="h-full w-full" aria-hidden preserveAspectRatio="xMidYMid slice">
        <defs>
          <filter id="scene-blur-sm" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="3" /></filter>
          <filter id="scene-blur-lg" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="12" /></filter>
          <filter id="scene-blur-xl" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="22" /></filter>
          {["a", "b"].map((id) => (
            <linearGradient key={id} id={`${id}-top`} x1="0" y1="0" x2="1" y2="1">
              <stop offset="0" stopColor="var(--scene-slab-top)" />
              <stop offset="1" stopColor="var(--scene-slab-front)" />
            </linearGradient>
          ))}
          <linearGradient id="beam" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0" stopColor="var(--scene-beam)" stopOpacity="0" />
            <stop offset="0.5" stopColor="var(--scene-beam)" />
            <stop offset="1" stopColor="var(--scene-beam)" stopOpacity="0" />
          </linearGradient>
          <radialGradient id="coin" cx="0.35" cy="0.3" r="0.8">
            <stop offset="0" stopColor="#fff6c4" />
            <stop offset="0.45" stopColor="#f2c14e" />
            <stop offset="1" stopColor="#a8740a" />
          </radialGradient>
        </defs>

        {/* the floor: hairlines in two directions, and two shafts of light */}
        <g stroke="var(--scene-line)" strokeWidth="1">
          {Array.from({ length: 9 }, (_, i) => <line key={`a${i}`} x1={-200} y1={-120 + i * 110} x2={840} y2={450 + i * 110} />)}
          {Array.from({ length: 7 }, (_, i) => <line key={`b${i}`} x1={-200} y1={300 + i * 150} x2={840} y2={-270 + i * 150} />)}
        </g>
        <polygon points="40,-40 200,-40 640,520 640,700 520,700" fill="url(#beam)" opacity="0.9" />
        <polygon points="-40,260 40,200 420,700 300,700" fill="url(#beam)" opacity="0.6" />

        <Slab id="b" top={[[120, 390], [330, 495], [220, 560], [10, 455]]} depth={28} glow="right" />
        <Slab id="a" top={[[300, 150], [520, 260], [400, 330], [180, 220]]} depth={36} glow="left" />

        {/* the glass tube: its shadow, edge and body */}
        <path d={TUBE} fill="none" stroke="var(--scene-shadow)" strokeWidth="40" strokeLinecap="round" transform="translate(26 18)" filter="url(#scene-blur-lg)" />
        <path d={TUBE} fill="none" stroke="var(--scene-tube-edge)" strokeWidth="46" strokeLinecap="round" />
        <path ref={tube} d={TUBE} fill="none" stroke="var(--scene-tube)" strokeWidth="40" strokeLinecap="round" />

        {/* violet energy running down the tube */}
        {!reduce && (
          <path d={TUBE} pathLength={100} fill="none" stroke="#c084fc" strokeWidth="22" strokeLinecap="round" strokeDasharray="7 93" filter="url(#scene-blur-sm)" opacity="0.8">
            <animate attributeName="stroke-dashoffset" from="100" to="0" dur={`${RUN_SECONDS / 2}s`} repeatCount="indefinite" />
          </path>
        )}

        {/* runs: gold coins rolling through the glass, haloed once checked */}
        {!reduce &&
          Array.from({ length: COINS }, (_, i) => {
            const begin = `${(-i * spacing).toFixed(3)}s`;
            return (
              <g key={i}>
                <animateMotion dur={`${RUN_SECONDS}s`} begin={begin} repeatCount="indefinite" rotate="auto" path={TUBE} />
                <circle r="22" fill="#a855f7" filter="url(#scene-blur-sm)" opacity="0">
                  <animate attributeName="opacity" values="0;0;0.9;0.7" keyTimes={times} dur={`${RUN_SECONDS}s`} begin={begin} repeatCount="indefinite" />
                </circle>
                <ellipse rx="7" ry="17" fill="#8a5e05" transform="translate(-2.5 0)" />
                <ellipse rx="6" ry="17" fill="url(#coin)" stroke="#c99318" strokeWidth="1" />
              </g>
            );
          })}

        {/* the glass on top: a soft inner light and a sharp highlight */}
        <path d={TUBE} fill="none" stroke="#ffffff" strokeOpacity="0.3" strokeWidth="14" strokeLinecap="round" transform="translate(-7 -3)" />
        <path d={TUBE} fill="none" stroke="#ffffff" strokeOpacity="0.85" strokeWidth="2.5" strokeLinecap="round" transform="translate(-13 -6)" />

        {/* the gate: a glow that pulses each time a run passes the check */}
        <ellipse cx={gate.x} cy={gate.y} rx="60" ry="30" fill="#a855f7" filter="url(#scene-blur-xl)" opacity="0.45" />
        {!reduce && (
          <ellipse cx={gate.x} cy={gate.y} rx="26" ry="13" fill="none" stroke="#c084fc" strokeWidth="2" opacity="0">
            <animate attributeName="rx" values="26;72" dur={`${spacing}s`} begin={`${firstAtGate.toFixed(3)}s`} repeatCount="indefinite" />
            <animate attributeName="ry" values="13;36" dur={`${spacing}s`} begin={`${firstAtGate.toFixed(3)}s`} repeatCount="indefinite" />
            <animate attributeName="opacity" values="0.9;0" dur={`${spacing}s`} begin={`${firstAtGate.toFixed(3)}s`} repeatCount="indefinite" />
          </ellipse>
        )}

        {SPECKS.map((s, i) => (
          <circle key={i} cx={s.x} cy={s.y} r={s.s} fill="var(--scene-speck)" className={s.twinkle && !reduce ? "scene-twinkle" : undefined} style={{ animationDelay: `${s.d}s` }} />
        ))}
      </svg>

      {/* the three stages, as glass chips pinned beside the tube */}
      {STAGES.map(({ at, label, icon: Icon, side }, i) => {
        const p = points[at];
        return (
          <motion.span
            key={label}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.9 + i * 0.25, duration: 0.6 }}
            className="glass absolute hidden -translate-y-1/2 items-center lg:flex gap-1.5 whitespace-nowrap rounded-full py-1.5 pl-1.5 pr-3 text-xs font-semibold text-ink"
            style={side === "right" ? { left: `calc(${(p.x / 640) * 100}% + 34px)`, top: `${(p.y / 640) * 100}%` } : { right: `calc(${100 - (p.x / 640) * 100}% + 34px)`, top: `${(p.y / 640) * 100}%` }}
          >
            <span className="grid h-5 w-5 place-items-center rounded-full bg-gradient-to-br from-[var(--grad-from)] to-accent-2 text-white"><Icon size={11} strokeWidth={2.2} /></span>
            {label}
          </motion.span>
        );
      })}
    </div>
  );
}

/* ----------------------------------------------------------------------------------------------- */
/* The verdict map and the floating cards                                                           */

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
          <stop offset="0" stopColor="var(--color-ok)" stopOpacity="0.16" />
          <stop offset="1" stopColor="var(--color-ok)" stopOpacity="0.02" />
        </linearGradient>
      </defs>
      <rect x="0" y="6" width="100" height="30" fill="url(#band)" />
      <line x1="0" y1="36" x2="100" y2="36" stroke="var(--color-ok)" strokeOpacity="0.5" strokeWidth="0.35" strokeDasharray="1.5 1.2" />
      {[20, 40, 60, 80].map((x) => <line key={x} x1={x} y1="2" x2={x} y2="76" stroke="var(--scene-line)" strokeWidth="0.3" />)}
      <text x="1.5" y="4.5" fontSize="3" fill="var(--color-ok)" fontWeight="600">GOOD ENOUGH · within 3 points of the best</text>
      {MAP_POINTS.map((p, i) => (
        <motion.g key={p.label} initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 1.1 + i * 0.18, duration: 0.5 }}>
          {p.win && (
            <motion.circle cx={p.x} cy={p.y} fill="none" stroke="var(--color-accent)" strokeWidth="0.7" animate={{ r: [4, 7, 4], opacity: [1, 0.25, 1] }} transition={{ duration: 2.4, repeat: Infinity, delay: 1.8 }} />
          )}
          <circle cx={p.x} cy={p.y} r={p.win ? 2.6 : 2.1} fill={p.win ? "var(--color-accent)" : "var(--series-other)"} />
          <text x={p.x} y={p.y + 8} fontSize="3.1" textAnchor="middle" fill={p.win ? "var(--color-accent-ink)" : "var(--color-muted)"} fontFamily="var(--font-mono)">{p.label} · {p.cost}</text>
        </motion.g>
      ))}
      <text x="1.5" y="79" fontSize="3" fill="var(--color-muted)">cheaper per successful answer ←</text>
      <text x="98.5" y="79" fontSize="3" fill="var(--color-muted)" textAnchor="end">→ costlier</text>
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
      className={cx("glass rounded-[18px] p-4", className)}
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
        <motion.div className="h-full rounded-full bg-gradient-to-r from-accent to-accent-2" animate={{ width: `${(progress / 50) * 100}%` }} transition={{ duration: 0.2 }} />
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
      className="glass rounded-[20px] p-4"
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
  const reduce = Boolean(useReducedMotion());
  const mx = useMotionValue(0);
  const my = useMotionValue(0);
  const sx = useSpring(mx, { stiffness: 60, damping: 20 });
  const sy = useSpring(my, { stiffness: 60, damping: 20 });
  const tiltY = useTransform(sx, (v) => (reduce ? 0 : v * 6));
  const tiltX = useTransform(sy, (v) => (reduce ? 0 : v * -5));
  const ax = useTransform(sx, (v) => (reduce ? 0 : v * -18));
  const ay = useTransform(sy, (v) => (reduce ? 0 : v * -18));
  const bx = useTransform(sx, (v) => (reduce ? 0 : v * 14));
  const by = useTransform(sy, (v) => (reduce ? 0 : v * 14));
  const cx2 = useTransform(sx, (v) => (reduce ? 0 : v * -10));
  const cy2 = useTransform(sy, (v) => (reduce ? 0 : v * -10));
  const [progress, setProgress] = useState(12);
  useEffect(() => {
    if (reduce) return;
    const t = setInterval(() => setProgress((p) => (p >= 50 ? 12 : p + 1)), 180);
    return () => clearInterval(t);
  }, [reduce]);
  const fade = "radial-gradient(closest-side, #000 72%, transparent 100%)";

  return (
    <>
      {/* Wide screens: the scene, tilting toward the mouse, with cards that drift the other way */}
      <div
        ref={ref}
        className="relative mx-auto hidden h-[560px] w-full max-w-[600px] lg:block"
        style={{ perspective: "1400px" }}
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
        <motion.div
          className="absolute -inset-10"
          style={{ rotateX: tiltX, rotateY: tiltY, WebkitMaskImage: fade, maskImage: fade }}
          initial={{ opacity: 0, scale: 0.96 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ duration: 1.1, ease: [0.22, 1, 0.36, 1] }}
        >
          <Scene reduce={reduce} />
        </motion.div>
        <FloatCard x={ax} y={ay} delay={1.6} className="absolute -left-6 top-[30%] w-56"><VerdictCard /></FloatCard>
        <FloatCard x={bx} y={by} delay={1.9} className="absolute -right-8 top-[50%] w-60"><DropCard /></FloatCard>
        <FloatCard x={cx2} y={cy2} delay={2.2} className="absolute -right-2 bottom-0 w-64"><RetestCard progress={progress} /></FloatCard>
      </div>

      {/* Phones and tablets: the scene as a banner, then the cards stacked */}
      <div className="flex flex-col gap-3 lg:hidden">
        <div className="relative h-[360px] overflow-hidden rounded-[24px] border border-rule bg-[var(--scene-floor)] sm:h-[440px]">
          <Scene reduce={reduce} />
        </div>
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

function Nav({ demo, signedIn }: { demo: boolean; signedIn: boolean }) {
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
          <ThemeToggle className="mr-1" />
          {demo && <ButtonLink to="/p/demo" variant="ghost" size="sm" className="hidden sm:inline-flex">Live demo</ButtonLink>}
          {signedIn ? (
            <ButtonLink to="/projects" variant="primary" size="sm">Open your projects</ButtonLink>
          ) : (
            <ButtonLink to="/signin" variant="primary" size="sm">Sign in</ButtonLink>
          )}
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
  // The landing page is always the front door: nothing saved in the browser redirects away from it.
  const signedIn = Boolean(me.data);
  const demo = Boolean(config.data?.demo_project_id);

  return (
    <div className="min-h-screen overflow-x-hidden">
      <Nav demo={demo} signedIn={signedIn} />

      {/* Hero */}
      <section className="relative flex min-h-[100svh] items-center pt-16">
        <motion.div aria-hidden style={{ y: glowY }} className="pointer-events-none absolute -left-40 top-0 h-[640px] w-[640px] rounded-full bg-accent/20 blur-3xl" />
        <div aria-hidden className="pointer-events-none absolute -right-48 top-24 h-[520px] w-[520px] rounded-full bg-accent-2/10 blur-3xl" />
        <div className="relative mx-auto grid w-full max-w-[1200px] items-center gap-10 px-4 py-10 md:px-6 lg:grid-cols-[1fr_1.1fr]">
          <div className="min-w-0">
            <motion.p initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="inline-flex items-center gap-2 rounded-full border border-rule bg-surface/60 px-3 py-1 text-xs font-semibold text-dim">
              <span className="relative flex h-2 w-2"><span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-ok opacity-60 motion-reduce:animate-none" /><span className="relative inline-flex h-2 w-2 rounded-full bg-ok" /></span>
              Long-term memory for the AI features you run
            </motion.p>
            <motion.h1 initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.05, duration: 0.7 }} className="mt-5 text-[34px] font-semibold leading-[1.04] tracking-tight md:text-[52px]">
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
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-accent-ink">Measured, not promised</p>
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
      <section id="how" data-theme="dark" className="relative scroll-mt-20 overflow-hidden border-y border-rule bg-bg">
        <div aria-hidden className="pointer-events-none absolute left-1/2 top-0 h-[400px] w-[800px] -translate-x-1/2 rounded-full bg-accent/10 blur-3xl" />
        <div className="relative mx-auto max-w-[1200px] px-4 py-20 md:px-6">
          <Reveal>
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-accent-ink">How it works</p>
            <h2 className="mt-2 max-w-2xl text-3xl font-semibold tracking-tight md:text-4xl">From every AI call to a decision you can trust</h2>
          </Reveal>
          <div className="relative mt-12">
            <motion.div aria-hidden className="absolute left-0 top-7 hidden h-px bg-gradient-to-r from-accent via-accent-2 to-ok lg:block" initial={{ width: 0 }} whileInView={{ width: "100%" }} viewport={{ once: false, amount: 0.3 }} transition={{ duration: 1.6, ease: "easeOut" }} />
            <ol className="grid gap-5 md:grid-cols-2 lg:grid-cols-4">
              {STEPS.map(({ icon: Icon, title, text }, i) => (
                <Reveal key={title} delay={0.15 + i * 0.15}>
                  <li className="panel relative h-full p-6">
                    <span className="grid h-14 w-14 place-items-center rounded-[16px] bg-gradient-to-br from-accent/25 to-accent-2/15 text-accent ring-1 ring-accent/30"><Icon size={24} /></span>
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
          <div className="grid items-center gap-8 lg:grid-cols-[1fr_1.1fr]">
            <Reveal>
              <p className="text-xs font-semibold uppercase tracking-[0.18em] text-accent-ink">What you get</p>
              <h2 className="mt-2 max-w-2xl text-3xl font-semibold tracking-tight md:text-4xl">Answers, not dashboards to dig through</h2>
              <p className="mt-4 max-w-lg text-dim">
                Every model you have tried, placed by what it really costs per successful answer and how often it
                passes on your own work. The verdict is the cheapest one inside the good-enough band.
              </p>
            </Reveal>
            <Reveal delay={0.1}><MapCard /></Reveal>
          </div>
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
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-accent-ink">Set up</p>
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
          <div data-theme="dark" className="relative mx-auto max-w-[1200px] overflow-hidden rounded-[28px] border border-accent/30 bg-gradient-to-br from-[#2b1470] via-[#160f3d] to-[#3d0f52] px-6 py-14 text-center md:py-20">
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
