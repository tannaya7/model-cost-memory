/** The light / dark switch: a small pill whose knob slides, with the sun and moon swapping. */
import { AnimatePresence, motion } from "framer-motion";
import { useTheme } from "../shared/theme/theme";
import { IconMoon, IconSun } from "./icons";
import { cx } from "./primitives";

export function ThemeToggle({ className }: { className?: string }) {
  const [theme, setTheme] = useTheme();
  const dark = theme === "dark";
  return (
    <button
      type="button"
      role="switch"
      aria-checked={dark}
      aria-label="Dark mode"
      title={dark ? "Switch to light mode" : "Switch to dark mode"}
      onClick={() => setTheme(dark ? "light" : "dark")}
      className={cx(
        "relative inline-flex h-8 w-14 shrink-0 items-center rounded-full border border-rule-strong bg-surface-2 p-0.5 transition-colors hover:border-accent/50",
        className,
      )}
    >
      <motion.span
        layout
        transition={{ type: "spring", stiffness: 500, damping: 32 }}
        className={cx(
          "grid h-6 w-6 place-items-center rounded-full text-white shadow-[0_4px_12px_-2px_rgba(124,58,237,0.6)]",
          "bg-gradient-to-br from-[var(--grad-from)] to-accent-2",
          dark ? "ml-auto" : "",
        )}
      >
        <AnimatePresence mode="wait" initial={false}>
          <motion.span
            key={theme}
            initial={{ rotate: -90, scale: 0.4, opacity: 0 }}
            animate={{ rotate: 0, scale: 1, opacity: 1 }}
            exit={{ rotate: 90, scale: 0.4, opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="grid place-items-center"
          >
            {dark ? <IconMoon size={13} strokeWidth={2} /> : <IconSun size={13} strokeWidth={2} />}
          </motion.span>
        </AnimatePresence>
      </motion.span>
    </button>
  );
}
