/** Full motion or calm: one small button, next to the theme switch. Calm holds every 3D scene still and turns off the page's effects. */
import { useMotion } from "../shared/motion/useMotion";

export function MotionToggle({ className = "inline-flex", tone = "ink" }: { className?: string; tone?: "ink" | "light" }) {
  const { calm, set } = useMotion();
  return (
    <button
      type="button"
      onClick={() => set(calm ? "full" : "calm")}
      aria-pressed={calm}
      title={calm ? "Calm: animations are held still. Choose to turn them back on." : "Full motion. Choose to calm the animations."}
      className={`items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-medium transition focus-visible:outline-2 ${tone === "light" ? "border-white/25 bg-white/10 text-[#e4f5fa] hover:bg-white/20" : "border-rule bg-surface/70 text-dim hover:text-ink"} ${className}`}
    >
      <span aria-hidden className={`h-2 w-2 rounded-full ${calm ? "bg-muted" : "bg-accent-2 shadow-[0_0_8px_var(--color-accent-2)]"}`} />
      {calm ? "Motion: calm" : "Motion: full"}
    </button>
  );
}
