/** The landing page's opening film.
 *
 *  A tall page with one sticky screen. The 3D world of your AI calls fills the screen from the first frame; scrolling flies the camera
 *  through four chapters, each told in a line of large type:
 *    1. your calls go straight through (we are never in the path),
 *    2. a copy is checked in the background (passed or failed, failures included),
 *    3. evidence is remembered and ages (a verdict is replaced, never overwritten),
 *    4. the cheapest model that still works (a worked example, labelled).
 *  All of the words are ordinary text in reading order, laid out in normal flow (never positioned independently, so they cannot collide).
 *  The world carries no figure and no claim. It is used only when the browser can draw it and the person has not chosen calm motion;
 *  otherwise the page shows its classic opening instead. */
import { Component, lazy, Suspense, useRef, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { motion, useInView, useMotionValue, useMotionValueEvent, useScroll, useSpring, useTransform, type MotionValue } from "framer-motion";
import { IconArrowRight } from "../../ui/icons";
import { isLowPower } from "../../shared/motion/webgl";
import { useMediaQuery } from "../../shared/motion/useMediaQuery";

const LandingWorld = lazy(() => import("../../shared/three/LandingWorld"));

/** The headline, with each word rising out of a mask in turn. The words are ordinary text with ordinary spaces between them. */
function Kinetic({ parts }: { parts: { text: string; italic?: boolean }[] }) {
  let i = 0;
  return (
    <>
      {parts.flatMap((part) =>
        part.text.split(" ").map((word) => {
          const k = i++;
          return (
            <span key={k}>
              <span className="inline-block overflow-hidden pb-[0.12em] align-bottom">
                <motion.span
                  className={`inline-block ${part.italic ? "italic-serif" : ""}`}
                  initial={{ y: "112%", rotate: 4 }}
                  animate={{ y: "0%", rotate: 0 }}
                  transition={{ delay: 0.25 + k * 0.075, duration: 1, ease: [0.16, 1, 0.3, 1] }}
                >
                  {word}
                </motion.span>
              </span>{" "}
            </span>
          );
        }),
      )}
    </>
  );
}

/** The button leans toward the pointer, a little, as if it were magnetic. */
function Magnetic({ children }: { children: ReactNode }) {
  const x = useMotionValue(0);
  const y = useMotionValue(0);
  const sx = useSpring(x, { stiffness: 220, damping: 18 });
  const sy = useSpring(y, { stiffness: 220, damping: 18 });
  return (
    <motion.div
      style={{ x: sx, y: sy }}
      onPointerMove={(e) => {
        if (e.pointerType === "touch") return;
        const r = e.currentTarget.getBoundingClientRect();
        x.set((e.clientX - (r.left + r.width / 2)) * 0.22);
        y.set((e.clientY - (r.top + r.height / 2)) * 0.3);
      }}
      onPointerLeave={() => {
        x.set(0);
        y.set(0);
      }}
    >
      {children}
    </motion.div>
  );
}

class Catch extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? null : this.props.children;
  }
}

interface ChapterProps {
  p: MotionValue<number>;
  range: [number, number];
  side: "left" | "right";
  title: string;
  children: ReactNode;
  /** The last chapter stays up to the end of the film instead of fading out. */
  last?: boolean;
}

function Chapter({ p, range: [a, b], side, title, children, last }: ChapterProps) {
  const input = last ? [a, a + 0.035, 1] : [a, a + 0.035, b - 0.035, b];
  const opacity = useTransform(p, input, last ? [0, 1, 1] : [0, 1, 1, 0]);
  const y = useTransform(p, input, last ? [36, 0, 0] : [36, 0, 0, -36]);
  return (
    <motion.div
      style={{ opacity, y }}
      data-chapter
      className={`pointer-events-none absolute bottom-[19vh] flex max-w-[34rem] flex-col gap-4 px-6 lg:bottom-[17vh] lg:px-0 ${side === "left" ? "left-0 items-start text-left lg:left-[5vw]" : "right-0 items-end text-right lg:right-[5vw]"}`}
    >
      <h2 className="font-display text-[clamp(2rem,min(4.6vw,8.4vh),4.4rem)] leading-[1.04] tracking-[-0.015em] text-[#e4f5fa] [text-shadow:0_2px_30px_rgba(7,16,43,0.85)]">{title}</h2>
      <div className="max-w-md text-[14px] leading-relaxed text-[#d2e7ef] [text-shadow:0_1px_18px_rgba(7,16,43,0.9)] md:text-[15px]">{children}</div>
    </motion.div>
  );
}

export function Cinema({ signedIn, onTone }: { signedIn: boolean; onTone: (dark: boolean) => void }) {
  const wide = useMediaQuery("(min-width: 1024px)");
  const wrap = useRef<HTMLElement>(null);
  const glow = useRef<HTMLDivElement>(null);
  const progress = useRef(0);
  const inView = useInView(wrap, { margin: "300px" });
  const { scrollYProgress: p } = useScroll({ target: wrap, offset: ["start start", "end end"] });
  useMotionValueEvent(p, "change", (v) => {
    progress.current = v;
    onTone(v < 0.998);
  });

  const heroOpacity = useTransform(p, [0, 0.1], [1, 0]);
  const heroY = useTransform(p, [0, 0.1], [0, -50]);
  const hintOpacity = useTransform(p, [0, 0.05], [1, 0]);

  return (
    <section ref={wrap} aria-label="How it works, as a film" className="relative h-[560vh] lg:h-[620vh]" data-scene="film">
      <div
        className="sticky top-0 h-screen overflow-hidden bg-[#07102b]"
        onPointerMove={(e) => {
          glow.current?.style.setProperty("--mx", `${e.clientX}px`);
          glow.current?.style.setProperty("--my", `${e.clientY}px`);
        }}
      >
        {/* the world: full screen from the first frame */}
        <div aria-hidden="true" className="absolute inset-0">
          <Catch>
            <Suspense fallback={null}>
              <LandingWorld progress={progress} lite={isLowPower() || !wide} premium={wide && !isLowPower()} active={inView} />
            </Suspense>
          </Catch>
        </div>

        {/* a pool of light that follows the pointer */}
        <div ref={glow} aria-hidden="true" className="pointer-events-none absolute inset-0 [background:radial-gradient(520px_circle_at_var(--mx,72%)_var(--my,42%),rgba(76,195,227,0.14),transparent_62%)]" />

        {/* a soft shade behind the opening words, so they read over moving coins */}
        <motion.div aria-hidden="true" style={{ opacity: heroOpacity }} className="pointer-events-none absolute inset-0 bg-[linear-gradient(90deg,rgba(7,16,43,0.88)_0%,rgba(7,16,43,0.55)_38%,transparent_72%)]" />

        {/* the opening words: one column in normal flow, so nothing can overlap */}
        <motion.div style={{ opacity: heroOpacity, y: heroY }} className="pointer-events-none absolute inset-x-0 bottom-[16vh] top-[13vh] flex flex-col justify-between px-6 lg:px-[5vw]" data-hero>
          <div className="max-w-[min(40rem,92vw)]">
            <h1 className="font-display text-[clamp(2.2rem,min(5.2vw,9.4vh),5.4rem)] leading-[1.03] tracking-[-0.018em] text-[#e4f5fa]">
              <Kinetic parts={[{ text: "Stop paying for a" }, { text: "bigger model", italic: true }, { text: "than the work needs." }]} />
            </h1>
            <p className="mt-5 max-w-md text-[15px] leading-relaxed text-[#cfe5ee] md:text-[16px]">
              Every call is checked and remembered. A cheaper model is recommended only when it is proven as good on your own work, never on a guess.
            </p>
          </div>
          <motion.div style={{ opacity: hintOpacity }} className="flex justify-between gap-6 border-t border-white/25 pt-3 text-[10px] font-medium uppercase tracking-[0.24em] text-[#a9cbd8]">
            <span>Scroll down</span>
            <span className="hidden text-right sm:inline">To see what it remembers</span>
          </motion.div>
        </motion.div>

        {/* the four chapters */}
        <Chapter p={p} range={[0.24, 0.43]} side="left" title="Your calls go straight through.">
          <p>Your app talks to the AI provider exactly as it does today. We are never in that path, so we can never slow it down or break it.</p>
        </Chapter>
        <Chapter p={p} range={[0.45, 0.63]} side="right" title="A copy is checked.">
          <p>In the background, each answer is checked: passed or failed, and the failures are kept, not hidden. This is the only place a verdict is made.</p>
        </Chapter>
        <Chapter p={p} range={[0.65, 0.84]} side="left" title="Evidence is remembered, and it ages.">
          <p>Newer evidence counts more. Evidence about a model that was replaced fades. A verdict is replaced, never overwritten, so you can always see why it changed.</p>
        </Chapter>
        <Chapter p={p} range={[0.87, 1]} last side="right" title="The cheapest model that still works.">
          <p>
            A worked example, not live data: a model that is right as often at about a tenth of the cost per correct answer can save about $870 a month on a busy task. We recommend; you decide whether to switch.
          </p>
        </Chapter>

        {/* the one button */}
        <div className="absolute bottom-[3.5vh] left-1/2 z-30 -translate-x-1/2">
          <Magnetic>
            <Link to={signedIn ? "/projects" : "/signin"} className="pill-cta text-[14px]">
              {signedIn ? "Open your projects" : "Get started"}
              <span className="dot" aria-hidden="true"><IconArrowRight size={16} /></span>
            </Link>
          </Magnetic>
        </div>
      </div>
    </section>
  );
}
