/** The whole app's frame: a slim top bar with four destinations, a project switcher, a command
 * palette (Ctrl/⌘ K), alerts and the account menu. Everything else lives inside those four places. */
import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion, MotionConfig } from "framer-motion";
import { Link, NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import { useP, useProject } from "./project";
import { RouteErrorBoundary } from "../shared/components/RouteErrorBoundary";
import { useAlertsCount } from "../features/alerts/hooks/useAlertsCount";
import { useLogout, useMe } from "../features/auth/hooks/useAuth";
import { useJobs } from "../features/jobs/hooks/useJobs";
import { useProjects } from "../features/projects/hooks/useProjects";
import {
  IconActivity,
  IconArrowRight,
  IconBell,
  IconChevron,
  IconJobs,
  IconLogo,
  IconModels,
  IconOverview,
  IconSearch,
  IconSettings,
} from "../ui/icons";
import { cx, Skeleton } from "../ui/primitives";

const NAV = [
  { to: "/", label: "Overview", icon: IconOverview, end: true },
  { to: "/jobs", label: "Jobs", icon: IconJobs },
  { to: "/models", label: "Models", icon: IconModels },
  { to: "/activity", label: "Activity", icon: IconActivity },
];

/** The four destinations, inside the current project. */
function useNav() {
  const p = useP();
  return NAV.map((item) => ({ ...item, to: p(item.to) }));
}

function useOutsideClose(open: boolean, close: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) close();
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, close]);
  return ref;
}

function ProjectSwitcher() {
  const { id: active, mode } = useProject();
  const projects = useProjects();
  const [open, setOpen] = useState(false);
  const ref = useOutsideClose(open, () => setOpen(false));
  const navigate = useNavigate();
  const list = mode === "owned" ? projects.data ?? [] : [];
  const current = list.find((p) => p.project_id === active);
  if (mode !== "owned") {
    return (
      <span className="rounded-full border border-rule px-2.5 py-1 text-xs font-semibold text-dim">
        {mode === "demo" ? "Public demo · read only" : "Using a project key"}
      </span>
    );
  }
  if (projects.isError || list.length === 0) return null;
  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex max-w-48 items-center gap-1.5 rounded-[9px] px-2 py-1 text-sm text-dim transition-colors hover:bg-surface-2 hover:text-ink"
      >
        <span className="truncate font-medium">{current?.name ?? "Choose a project"}</span>
        <IconChevron size={14} className={cx("shrink-0 transition-transform", open ? "-rotate-90" : "rotate-90")} />
      </button>
      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: -6, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -6, scale: 0.98 }}
            transition={{ duration: 0.15 }}
            className="absolute left-0 top-full z-50 mt-2 w-64 rounded-[14px] border border-rule-strong bg-surface-2 p-1.5 shadow-2xl"
          >
            {list.map((p) => (
              <button
                key={p.project_id}
                type="button"
                onClick={() => {
                  setOpen(false);
                  navigate(`/p/${encodeURIComponent(p.project_id)}`);
                }}
                className={cx(
                  "flex w-full items-center justify-between rounded-[10px] px-3 py-2 text-left text-sm transition-colors hover:bg-surface-3",
                  p.project_id === active ? "text-ink" : "text-dim",
                )}
              >
                <span className="truncate">{p.name}</span>
                {p.project_id === active && <span className="h-1.5 w-1.5 rounded-full bg-accent" />}
              </button>
            ))}
            <div className="my-1 h-px bg-rule" />
            <Link to="/projects" onClick={() => setOpen(false)} className="block rounded-[10px] px-3 py-2 text-sm text-accent hover:bg-surface-3">
              All projects · new project
            </Link>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function AccountMenu() {
  const p = useP();
  const { mode } = useProject();
  const { data: user } = useMe();
  const logout = useLogout();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const ref = useOutsideClose(open, () => setOpen(false));
  const initials = (user?.name || user?.email || "?").slice(0, 1).toUpperCase();
  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label="Account and settings"
        aria-expanded={open}
        className="grid h-9 w-9 place-items-center rounded-full bg-gradient-to-br from-[#b4aaff] to-accent-2 text-sm font-bold text-on-accent"
      >
        {initials}
      </button>
      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: -6, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -6, scale: 0.98 }}
            transition={{ duration: 0.15 }}
            className="absolute right-0 top-full z-50 mt-2 w-60 rounded-[14px] border border-rule-strong bg-surface-2 p-1.5 shadow-2xl"
          >
            {user && (
              <div className="px-3 py-2">
                <p className="truncate text-sm font-semibold text-ink">{user.name || user.email}</p>
                <p className="truncate text-xs text-muted">{user.email}</p>
              </div>
            )}
            <div className="my-1 h-px bg-rule" />
            {[
              ...(user ? [{ to: "/projects", label: "All projects" }] : []),
              { to: p("/settings"), label: mode === "demo" ? "About this demo" : "Project settings" },
              { to: p("/settings#limits"), label: "Usage limits" },
            ].map((item) => (
              <Link key={item.to} to={item.to} onClick={() => setOpen(false)} className="block rounded-[10px] px-3 py-2 text-sm text-dim hover:bg-surface-3 hover:text-ink">
                {item.label}
              </Link>
            ))}
            {user && (
              <>
                <div className="my-1 h-px bg-rule" />
                <button
                  type="button"
                  onClick={async () => {
                    try {
                      await logout.mutateAsync();
                    } catch {
                      /* signed out either way */
                    }
                    navigate("/");
                  }}
                  className="block w-full rounded-[10px] px-3 py-2 text-left text-sm text-dim hover:bg-surface-3 hover:text-ink"
                >
                  Sign out
                </button>
              </>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

interface Command {
  label: string;
  hint: string;
  to: string;
}

function CommandPalette({ open, onClose }: { open: boolean; onClose: () => void }) {
  const p = useP();
  const jobs = useJobs();
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const commands = useMemo<Command[]>(() => {
    const pages: Command[] = [
      { label: "Overview", hint: "Savings, spend and what needs attention", to: p("/") },
      { label: "Jobs", hint: "Every job and its verdict", to: p("/jobs") },
      { label: "Models", hint: "Prices, retirements and the catalog", to: p("/models") },
      { label: "Activity", hint: "Alerts, re-tests, live runs and AI news", to: p("/activity") },
      { label: "Alerts", hint: "Regressions, silent drops, retirements", to: p("/activity?tab=alerts") },
      { label: "Live pipeline", hint: "Runs crossing the system right now", to: p("/activity?tab=live") },
      { label: "AI news", hint: "Stories about your models", to: p("/activity?tab=news") },
      { label: "Settings", hint: "Project, keys, alerts webhook, retention", to: p("/settings") },
      { label: "Usage limits", hint: "Plan limits and when they run out", to: p("/settings#limits") },
    ];
    const jobItems = (jobs.data ?? []).map((j) => ({ label: j.name, hint: "Job", to: p(`/jobs/${encodeURIComponent(j.name)}`) }));
    const q = query.trim().toLowerCase();
    return [...jobItems, ...pages].filter((c) => !q || c.label.toLowerCase().includes(q) || c.hint.toLowerCase().includes(q)).slice(0, 9);
  }, [jobs.data, query]);

  useEffect(() => {
    if (open) {
      setQuery("");
      setIndex(0);
    }
  }, [open]);

  const go = (c: Command | undefined) => {
    if (!c) return;
    onClose();
    navigate(c.to);
  };

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="fixed inset-0 z-[100] flex items-start justify-center bg-black/60 px-4 pt-[12vh] backdrop-blur-sm"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          onMouseDown={(e) => e.target === e.currentTarget && onClose()}
        >
          <motion.div
            role="dialog"
            aria-label="Go to"
            initial={{ opacity: 0, y: 12, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 12, scale: 0.98 }}
            transition={{ duration: 0.18 }}
            className="w-full max-w-xl overflow-hidden rounded-[18px] border border-rule-strong bg-surface-2 shadow-2xl"
          >
            <div className="flex items-center gap-3 border-b border-rule px-4">
              <IconSearch size={18} className="text-muted" />
              <input
                autoFocus
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  setIndex(0);
                }}
                onKeyDown={(e) => {
                  if (e.key === "ArrowDown") setIndex((i) => Math.min(i + 1, commands.length - 1));
                  else if (e.key === "ArrowUp") setIndex((i) => Math.max(i - 1, 0));
                  else if (e.key === "Enter") go(commands[index]);
                  else if (e.key === "Escape") onClose();
                }}
                placeholder="Jump to a job, a page or a setting…"
                aria-label="Search"
                className="h-14 flex-1 bg-transparent text-[15px] text-ink outline-none placeholder:text-muted"
              />
              <kbd className="rounded-md border border-rule px-1.5 py-0.5 font-mono text-[10px] text-muted">esc</kbd>
            </div>
            <ul className="max-h-[50vh] overflow-auto p-2">
              {commands.length === 0 && <li className="px-3 py-6 text-center text-sm text-muted">Nothing matches “{query}”.</li>}
              {commands.map((c, i) => (
                <li key={`${c.to}-${c.label}`}>
                  <button
                    type="button"
                    onMouseEnter={() => setIndex(i)}
                    onClick={() => go(c)}
                    className={cx(
                      "flex w-full items-center justify-between gap-3 rounded-[10px] px-3 py-2.5 text-left",
                      i === index ? "bg-surface-3 text-ink" : "text-dim",
                    )}
                  >
                    <span className="min-w-0">
                      <span className={cx("block truncate text-sm font-medium", c.hint === "Job" && "font-mono")}>{c.label}</span>
                      <span className="block truncate text-xs text-muted">{c.hint}</span>
                    </span>
                    {i === index && <IconArrowRight size={15} className="shrink-0 text-accent" />}
                  </button>
                </li>
              ))}
            </ul>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

function PageFallback() {
  return (
    <div className="grid gap-4" role="status" aria-label="Loading page">
      <Skeleton className="h-28 w-full" />
      <div className="grid gap-4 md:grid-cols-3">
        <Skeleton className="h-36" />
        <Skeleton className="h-36" />
        <Skeleton className="h-36" />
      </div>
      <Skeleton className="h-72 w-full" />
    </div>
  );
}

export function Frame() {
  const p = useP();
  const nav = useNav();
  const { data: user } = useMe();
  const { pathname, search } = useLocation();
  const { count: alerts } = useAlertsCount();
  const [paletteOpen, setPaletteOpen] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen((v) => !v);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    window.scrollTo({ top: 0 });
  }, [pathname]);

  return (
    <MotionConfig reducedMotion="user">
      <div className="min-h-screen">
        <header className="sticky top-0 z-40 border-b border-rule bg-bg/75 backdrop-blur-xl">
          <div className="mx-auto flex h-16 max-w-[1320px] items-center gap-3 px-4 md:px-6">
            <Link to={user ? "/projects" : p("/")} className="flex items-center gap-2.5" aria-label={user ? "All projects" : "Overview"}>
              <IconLogo size={28} />
              <span className="hidden text-[15px] font-semibold tracking-tight lg:inline">Model &amp; Cost Memory</span>
            </Link>
            <span aria-hidden className="hidden h-5 w-px bg-rule-strong sm:block" />
            <div className="hidden sm:block">
              <ProjectSwitcher />
            </div>

            <nav aria-label="Main" className="mx-auto hidden items-center gap-1 md:flex">
              {nav.map(({ to, label, icon: Icon, end }) => (
                <NavLink
                  key={to}
                  to={to}
                  end={end}
                  className={({ isActive }) =>
                    cx("relative flex items-center gap-2 rounded-[10px] px-3.5 py-2 text-sm font-medium transition-colors", isActive ? "text-ink" : "text-muted hover:text-dim")
                  }
                >
                  {({ isActive }) => (
                    <>
                      {isActive && (
                        <motion.span
                          layoutId="nav-active"
                          className="absolute inset-0 rounded-[10px] bg-surface-2 shadow-[inset_0_1px_0_rgba(255,255,255,0.06)]"
                          transition={{ type: "spring", stiffness: 500, damping: 40 }}
                        />
                      )}
                      <Icon size={16} className="relative" />
                      <span className="relative">{label}</span>
                      {label === "Activity" && alerts > 0 && (
                        <span className="relative rounded-full bg-bad px-1.5 text-[10px] font-bold leading-4 text-white tabular">{alerts}</span>
                      )}
                    </>
                  )}
                </NavLink>
              ))}
            </nav>

            <div className="ml-auto flex items-center gap-2 md:ml-0">
              <button
                type="button"
                onClick={() => setPaletteOpen(true)}
                className="hidden items-center gap-2 rounded-[10px] border border-rule bg-surface px-3 py-1.5 text-sm text-muted transition-colors hover:text-dim lg:flex"
              >
                <IconSearch size={15} />
                <span>Jump to…</span>
                <kbd className="rounded border border-rule px-1 font-mono text-[10px]">Ctrl K</kbd>
              </button>
              <button
                type="button"
                onClick={() => setPaletteOpen(true)}
                aria-label="Search"
                className="grid h-9 w-9 place-items-center rounded-[10px] text-muted hover:bg-surface-2 hover:text-ink lg:hidden"
              >
                <IconSearch size={17} />
              </button>
              <Link
                to={p("/activity?tab=alerts")}
                aria-label={alerts ? `${alerts} open alerts` : "Alerts"}
                className="relative grid h-9 w-9 place-items-center rounded-[10px] text-muted transition-colors hover:bg-surface-2 hover:text-ink"
              >
                <IconBell size={18} />
                {alerts > 0 && <span className="absolute right-1.5 top-1.5 h-2 w-2 rounded-full bg-bad ring-2 ring-bg" />}
              </Link>
              <Link to={p("/settings")} aria-label="Project settings" className="hidden h-9 w-9 place-items-center rounded-[10px] text-muted hover:bg-surface-2 hover:text-ink sm:grid">
                <IconSettings size={18} />
              </Link>
              <AccountMenu />
            </div>
          </div>
        </header>

        <main className="mx-auto max-w-[1320px] px-4 pb-28 pt-6 md:px-6 md:pb-16 md:pt-8">
          <RouteErrorBoundary key={pathname}>
            <Suspense fallback={<PageFallback />}>
              <AnimatePresence mode="wait">
                <motion.div
                  key={pathname + search.replace(/tab=[^&]*/, "")}
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -4 }}
                  transition={{ duration: 0.22, ease: "easeOut" }}
                >
                  <Outlet />
                </motion.div>
              </AnimatePresence>
            </Suspense>
          </RouteErrorBoundary>
        </main>

        {/* Phone: the four destinations as a bottom bar */}
        <nav aria-label="Main" className="fixed inset-x-0 bottom-0 z-40 border-t border-rule bg-bg/90 backdrop-blur-xl md:hidden" style={{ paddingBottom: "env(safe-area-inset-bottom)" }}>
          <ul className="grid grid-cols-4">
            {nav.map(({ to, label, icon: Icon, end }) => (
              <li key={to}>
                <NavLink
                  to={to}
                  end={end}
                  className={({ isActive }) => cx("flex flex-col items-center gap-1 py-2.5 text-[11px] font-medium", isActive ? "text-accent" : "text-muted")}
                >
                  <span className="relative">
                    <Icon size={20} />
                    {label === "Activity" && alerts > 0 && <span className="absolute -right-1 -top-0.5 h-2 w-2 rounded-full bg-bad" />}
                  </span>
                  {label}
                </NavLink>
              </li>
            ))}
          </ul>
        </nav>

        <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
      </div>
    </MotionConfig>
  );
}
