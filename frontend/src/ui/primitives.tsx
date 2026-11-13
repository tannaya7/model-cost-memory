/** The building blocks every screen is made of. */
import { motion } from "framer-motion";
import type { ButtonHTMLAttributes, ReactNode } from "react";
import { Link } from "react-router-dom";
import { IconAlert, IconCheck, IconClock, IconInfo } from "./icons";

export function cx(...parts: Array<string | false | null | undefined>) {
  return parts.filter(Boolean).join(" ");
}

/** A raised surface. `glow` adds the accent wash for the one panel that carries the page's point. */
export function Panel({
  children,
  className,
  glow = false,
  as: Tag = "section",
  ...rest
}: {
  children: ReactNode;
  className?: string;
  glow?: boolean;
  as?: "section" | "div" | "article";
} & React.HTMLAttributes<HTMLElement>) {
  return (
    <Tag className={cx("panel relative overflow-hidden", className)} {...rest}>
      {glow && (
        <span
          aria-hidden
          className="pointer-events-none absolute -right-24 -top-32 h-80 w-80 rounded-full bg-accent/20 blur-3xl"
        />
      )}
      <div className="relative">{children}</div>
    </Tag>
  );
}

export function PanelHeader({
  title,
  hint,
  actions,
  eyebrow,
}: {
  title: ReactNode;
  hint?: ReactNode;
  actions?: ReactNode;
  eyebrow?: ReactNode;
}) {
  return (
    <header className="flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0">
        {eyebrow && <p className="mb-1 text-[11px] font-semibold uppercase tracking-[0.16em] text-muted">{eyebrow}</p>}
        <h2 className="text-[15px] font-semibold tracking-tight text-ink">{title}</h2>
        {hint && <p className="mt-0.5 text-[13px] text-dim">{hint}</p>}
      </div>
      {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
    </header>
  );
}

type Variant = "primary" | "secondary" | "ghost" | "danger";

const variants: Record<Variant, string> = {
  primary:
    "bg-gradient-to-r from-[#9d91ff] to-accent text-on-accent shadow-[0_8px_24px_-8px_rgba(139,125,255,0.7)] hover:brightness-110",
  secondary: "border border-rule-strong bg-surface-2 text-ink hover:bg-surface-3",
  ghost: "text-dim hover:bg-surface-2 hover:text-ink",
  danger: "bg-bad/90 text-white hover:bg-bad",
};

export function Button({
  variant = "secondary",
  size = "md",
  className,
  children,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: "sm" | "md" }) {
  return (
    <button
      type="button"
      className={cx(
        "inline-flex items-center justify-center gap-2 rounded-[10px] font-semibold transition-all disabled:cursor-not-allowed disabled:opacity-50",
        size === "sm" ? "px-3 py-1.5 text-xs" : "px-4 py-2 text-sm",
        variants[variant],
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  );
}

export function ButtonLink({
  to,
  variant = "secondary",
  size = "md",
  className,
  children,
}: {
  to: string;
  variant?: Variant;
  size?: "sm" | "md";
  className?: string;
  children: ReactNode;
}) {
  return (
    <Link
      to={to}
      className={cx(
        "inline-flex items-center justify-center gap-2 rounded-[10px] font-semibold transition-all",
        size === "sm" ? "px-3 py-1.5 text-xs" : "px-4 py-2 text-sm",
        variants[variant],
        className,
      )}
    >
      {children}
    </Link>
  );
}

export type Tone = "good" | "warn" | "bad" | "info" | "neutral" | "accent";

const toneClass: Record<Tone, string> = {
  good: "bg-ok-soft text-ok",
  warn: "bg-warn-soft text-warn",
  bad: "bg-bad-soft text-bad",
  info: "bg-accent-soft text-accent",
  accent: "bg-accent-soft text-accent",
  neutral: "bg-surface-3 text-dim",
};

const toneIcon: Partial<Record<Tone, ReactNode>> = {
  good: <IconCheck size={13} strokeWidth={2.2} />,
  warn: <IconClock size={13} strokeWidth={2} />,
  bad: <IconAlert size={13} strokeWidth={2} />,
  info: <IconInfo size={13} strokeWidth={2} />,
};

/** A state, always as an icon and a word, never colour alone. */
export function Pill({ tone = "neutral", children, icon = true }: { tone?: Tone; children: ReactNode; icon?: boolean }) {
  return (
    <span
      className={cx(
        "inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2.5 py-1 text-[11px] font-semibold",
        toneClass[tone],
      )}
    >
      {icon && toneIcon[tone]}
      {children}
    </span>
  );
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: Array<{ value: T; label: ReactNode; count?: number }>;
  onChange: (v: T) => void;
  label: string;
}) {
  return (
    <div role="tablist" aria-label={label} className="inline-flex rounded-[12px] border border-rule bg-surface p-1">
      {options.map((o) => {
        const active = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(o.value)}
            className={cx(
              "relative rounded-[9px] px-3 py-1.5 text-xs font-semibold transition-colors",
              active ? "text-ink" : "text-muted hover:text-dim",
            )}
          >
            {active && (
              <motion.span
                layoutId={`seg-${label}`}
                className="absolute inset-0 rounded-[9px] bg-surface-3 shadow-[inset_0_1px_0_rgba(255,255,255,0.06)]"
                transition={{ type: "spring", stiffness: 500, damping: 38 }}
              />
            )}
            <span className="relative inline-flex items-center gap-1.5">
              {o.label}
              {o.count !== undefined && <span className="tabular rounded-full bg-bg/60 px-1.5 text-[10px] text-dim">{o.count}</span>}
            </span>
          </button>
        );
      })}
    </div>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cx("animate-pulse rounded-[10px] bg-skeleton/70", className)} />;
}

export function EmptyState({ icon, title, hint, action }: { icon?: ReactNode; title: string; hint?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 rounded-[14px] border border-dashed border-rule-strong px-6 py-10 text-center">
      {icon && <div className="mb-1 grid h-10 w-10 place-items-center rounded-full bg-surface-3 text-dim">{icon}</div>}
      <p className="font-semibold text-ink">{title}</p>
      {hint && <p className="max-w-md text-sm text-dim">{hint}</p>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const message = error instanceof Error ? error.message : "Something went wrong";
  return (
    <div role="alert" className="flex flex-wrap items-center justify-between gap-3 rounded-[14px] border border-bad/30 bg-bad-soft px-4 py-3">
      <p className="flex items-center gap-2 text-sm text-bad">
        <IconAlert size={16} /> Could not load this: {message}
      </p>
      {onRetry && (
        <Button size="sm" variant="secondary" onClick={onRetry}>
          Try again
        </Button>
      )}
    </div>
  );
}

/** Fades and lifts children in, one after another. */
export function Reveal({ children, delay = 0, className }: { children: ReactNode; delay?: number; className?: string }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 14 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.45, delay, ease: [0.22, 1, 0.36, 1] }}
      className={className}
    >
      {children}
    </motion.div>
  );
}

export function ModelName({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={cx("font-mono text-[0.92em] font-medium text-ink", className)}>{children}</span>;
}
