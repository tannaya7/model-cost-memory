/** Puts a view into the 3D world on the page, or the flat picture the page already had.
 *
 *  `at` is the moment of the landing film to look at: 0 is the opening, 0.2 the river of coins, 0.5 the checking gate, 0.85 the layers of
 *  evidence, 1 the verdict. A person who asked for calm motion still sees the picture, held still. It is hidden from screen readers: it
 *  carries no information, and the real content sits beside it in plain HTML. It draws nothing while off screen, and if drawing ever
 *  fails (a lost graphics context, an old driver) the flat picture takes over. */
import { Component, lazy, Suspense, useRef, type ReactNode } from "react";
import { useInView } from "framer-motion";
import { useMotion } from "../motion/useMotion";
import { canUseWebGL, isLowPower } from "../motion/webgl";

const LandingWorld = lazy(() => import("./LandingWorld"));

class Catch extends Component<{ fallback: ReactNode; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

export function Scene3D({ at, fallback = null, className }: { at: number; fallback?: ReactNode; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const progress = useRef(at);
  progress.current = at;
  const inView = useInView(ref, { margin: "160px" });
  const { calm } = useMotion();
  const ok = canUseWebGL();
  return (
    <div ref={ref} className={className} aria-hidden="true" data-scene={ok ? `world@${at}` : "flat"}>
      {ok ? (
        <Catch fallback={fallback}>
          <Suspense fallback={fallback}>
            <LandingWorld progress={progress} lite={isLowPower()} still={calm} active={inView} />
          </Suspense>
        </Catch>
      ) : (
        fallback
      )}
    </div>
  );
}
