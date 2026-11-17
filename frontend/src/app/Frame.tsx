/** The whole app's frame: a left sidebar (the project, four destinations and the project's own pages),
 * a top bar with search (Ctrl/⌘ K), theme, alerts and the account menu, and a bottom bar on phones. */
import { useBillingMode } from "../features/projects/hooks/useBillingMode";
import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion, MotionConfig } from "framer-motion";
import { Link, NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import { useP, useProject } from "./project";
import { RouteErrorBoundary } from "../shared/components/RouteErrorBoundary";
import { useAlertsCount } from "../features/alerts/hooks/useAlertsCount";
import { useLogout, useMe } from "../features/auth/hooks/useAuth";
import { jobTitle } from "../features/jobs/jobTitle";
import { useJobs } from "../features/jobs/hooks/useJobs";
import { useProjects } from "../features/projects/hooks/useProjects";
import { projectPath } from "../shared/projectPath";
import {
  IconActivity,
  IconArrowRight,
  IconBell,
  IconBolt,
  IconChart,
  IconChevron,
  IconFlask,
  IconJobs,
  IconLogo,
  IconModels,
  IconOverview,
  IconSearch,
  IconSettings,
  IconSidebar,
} from "../ui/icons";
import { ThemeToggle } from "../ui/ThemeToggle";
import { useModalFocus } from "../ui/useModalFocus";
import { TourHost } from "../features/guide/TourHost";
import { cx, Skeleton } from "../ui/primitives";

/** Which part of the tour points at which item (the tour looks for data-tour="..."). */
const TOUR_TARGET: Record<string, string> = { Overview: "overview", "AI tasks": "tasks", Compare: "compare", Activity: "activity", Settings: "settings" };

const NAV = [
  { to: "/", label: "Overview", icon: IconOverview, end: true },
  { to: "/jobs", label: "AI tasks", icon: IconJobs },
  { to: "/models", label: "Models", icon: IconModels },
  { to: "/compare", label: "Compare", icon: IconChart },
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
  if (projects.isPending) return <span role="status" className="block truncate px-2 py-1 text-sm text-muted">Loading projects…</span>;
  if (projects.isError || list.length === 0) return null;
  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full min-w-0 items-center justify-between gap-1.5 rounded-[9px] px-2 py-1 text-sm text-dim transition-colors hover:bg-surface-2 hover:text-ink"
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
            className="absolute left-0 top-full z-50 mt-2 w-56 rounded-[14px] border border-rule-strong bg-surface-2 p-1.5 shadow-2xl"
          >
            {list.map((p) => (
              <button
                key={p.project_id}
                type="button"
                onClick={() => {
                  setOpen(false);
                  navigate(projectPath(p));
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

function AccountMenu({ onTour }: { onTour: () => void }) {
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
        className="grid h-9 w-9 place-items-center rounded-full bg-gradient-to-br from-[var(--grad-from)] to-accent-2 text-sm font-bold text-on-accent"
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
            {user && mode === "owned" && (
              <button
                type="button"
                onClick={() => {
                  setOpen(false);
                  onTour();
                }}
                className="block w-full rounded-[10px] px-3 py-2 text-left text-sm text-dim hover:bg-surface-3 hover:text-ink"
              >
                Take the tour again
              </button>
            )}
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
  /** The name used in code, shown as a chip and matched by search. */
  code?: string;
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
      { label: "AI tasks", hint: "Every kind of work your app asks an AI to do, and our recommendation for each", to: p("/jobs") },
      { label: "Models", hint: "Prices, retirements and the catalog", to: p("/models") },
      { label: "Activity", hint: "Quality drops, trials on new models, live AI calls and AI news", to: p("/activity") },
      { label: "Alerts", hint: "Quality drops, quiet slowdowns and models being retired", to: p("/activity?tab=alerts") },
      { label: "Live pipeline", hint: "AI calls arriving right now", to: p("/activity?tab=live") },
      { label: "AI news", hint: "Stories about your models", to: p("/activity?tab=news") },
      { label: "Settings", hint: "Project name, keys, alert webhook and data retention (how long data is kept)", to: p("/settings") },
      { label: "Usage limits", hint: "Caps we warn you about before you reach them", to: p("/settings#limits") },
    ];
    const jobItems = (jobs.data ?? []).map((j) => ({ label: jobTitle(j.name), code: j.name, hint: "AI task", to: p(`/jobs/${encodeURIComponent(j.name)}`) }));
    const q = query.trim().toLowerCase();
    return [...jobItems, ...pages].filter((c) => !q || c.label.toLowerCase().includes(q) || (c.code ?? "").toLowerCase().includes(q) || c.hint.toLowerCase().includes(q)).slice(0, 9);
  }, [jobs.data, query]);

  useEffect(() => {
    if (open) {
      setQuery("");
      setIndex(0);
    }
  }, [open]);
  const dialogRef = useModalFocus<HTMLDivElement>(open, onClose, "input");

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
            ref={dialogRef}
            role="dialog"
            aria-modal="true"
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
                role="combobox"
                aria-expanded="true"
                aria-controls="palette-results"
                aria-autocomplete="list"
                aria-activedescendant={commands[index] ? `palette-opt-${index}` : undefined}
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  setIndex(0);
                }}
                onKeyDown={(e) => {
                  if (e.key === "ArrowDown") setIndex((i) => Math.min(i + 1, commands.length - 1));
                  else if (e.key === "ArrowUp") setIndex((i) => Math.max(i - 1, 0));
                  else if (e.key === "Enter") go(commands[index]);
                }}
                placeholder="Jump to an AI task, a page or a setting…"
                aria-label="Search"
                className="h-14 flex-1 bg-transparent text-[15px] text-ink outline-none placeholder:text-muted"
              />
              <kbd className="rounded-md border border-rule px-1.5 py-0.5 font-mono text-[10px] text-muted">esc</kbd>
            </div>
            <ul id="palette-results" role="listbox" aria-label="Results" className="max-h-[50vh] overflow-auto p-2">
              {commands.length === 0 && <li role="presentation" className="px-3 py-6 text-center text-sm text-muted">Nothing matches “{query}”.</li>}
              {commands.map((c, i) => (
                <li key={`${c.to}-${c.label}`} role="presentation">
                  <div
                    id={`palette-opt-${i}`}
                    role="option"
                    aria-selected={i === index}
                    onMouseEnter={() => setIndex(i)}
                    onClick={() => go(c)}
                    className={cx(
                      "cursor-pointer",
                      "flex w-full items-center justify-between gap-3 rounded-[10px] px-3 py-2.5 text-left",
                      i === index ? "bg-surface-3 text-ink" : "text-dim",
                    )}
                  >
                    <span className="min-w-0">
                      <span className="block truncate text-sm font-medium">
                        {c.label}
                        {c.code && <span className="ml-2 rounded-md border border-rule bg-surface-2 px-1.5 py-0.5 font-mono text-[11px] font-normal text-dim">{c.code}</span>}
                      </span>
                      <span className="block truncate text-xs text-muted">{c.hint}</span>
                    </span>
                    {i === index && <IconArrowRight size={15} className="shrink-0 text-accent" />}
                  </div>
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
      <span className="sr-only">Loading…</span>
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

const SIDEBAR_KEY = "mcm_sidebar_collapsed";

function readCollapsed(): boolean {
  try {
    return localStorage.getItem(SIDEBAR_KEY) === "1";
  } catch {
    return false;
  }
}

/** The left sidebar: the project, the four destinations, the project's own pages, and a way to try a
 * cheaper model. Collapses to icons; the choice is remembered in this browser. */
function Sidebar({ collapsed, onToggle, alerts }: { collapsed: boolean; onToggle: () => void; alerts: number }) {
  const { mode: billing } = useBillingMode();
  const p = useP();
  const nav = useNav();
  const { mode } = useProject();
  const { data: user } = useMe();
  const { hash } = useLocation();
  const item = (active: boolean) =>
    cx(
      "relative flex items-center gap-3 rounded-[11px] px-3 py-2.5 text-[14px] font-medium transition-colors",
      collapsed && "justify-center px-0",
      active ? "text-accent-ink" : "text-dim hover:bg-surface-2 hover:text-ink",
    );
  const project = [
    { to: p("/retest"), label: "Model trials", icon: IconFlask, match: (on: boolean) => on },
    { to: p("/settings"), label: mode === "demo" ? "About this demo" : "Settings", icon: IconSettings, match: (on: boolean) => on && hash !== "#limits" },
    { to: p("/settings#limits"), label: "Usage limits", icon: IconBolt, match: (on: boolean) => on && hash === "#limits" },
  ];
  return (
    <motion.aside
      initial={false}
      animate={{ width: collapsed ? 76 : 256 }}
      transition={{ type: "spring", stiffness: 300, damping: 34 }}
      className="sticky top-0 hidden h-screen shrink-0 flex-col border-r border-rule bg-surface/70 backdrop-blur-xl md:flex"
      aria-label="Sidebar"
    >
      <div className={cx("flex h-16 shrink-0 items-center gap-2.5 border-b border-rule px-4", collapsed && "justify-center px-0")}>
        <Link to={user ? "/projects" : p("/")} className="flex min-w-0 items-center gap-2.5" aria-label={collapsed ? (user ? "All projects" : "Overview") : `Model & Cost Memory, ${user ? "all projects" : "overview"}`}>
          <IconLogo size={28} />
          {!collapsed && <span className="truncate text-[15px] font-semibold tracking-tight">Model &amp; Cost Memory</span>}
        </Link>
        {!collapsed && (
          <button type="button" onClick={onToggle} aria-label="Collapse the sidebar" className="ml-auto grid h-8 w-8 place-items-center rounded-[8px] text-muted hover:bg-surface-2 hover:text-ink">
            <IconSidebar size={17} />
          </button>
        )}
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto overflow-x-hidden px-3 py-4">
        {collapsed ? (
          <button type="button" onClick={onToggle} aria-label="Expand the sidebar" className="mb-2 grid h-10 place-items-center rounded-[11px] text-muted hover:bg-surface-2 hover:text-ink">
            <IconSidebar size={18} />
          </button>
        ) : (
          <div className="mb-3 rounded-[12px] border border-rule bg-surface px-2 py-1.5">
            <p className="px-2 pt-0.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted">Project</p>
            <ProjectSwitcher />
          </div>
        )}

        <nav aria-label="Main" className="flex flex-col gap-1">
          {nav.map(({ to, label, icon: Icon, end }) => (
            <NavLink key={to} to={to} end={end} data-tour={TOUR_TARGET[label]} title={collapsed ? label : undefined} className={({ isActive }) => item(isActive)}>
              {({ isActive }) => (
                <>
                  {isActive && <ActiveMark />}
                  <Icon size={18} className="relative shrink-0" />
                  {!collapsed && <span className="relative flex-1">{label}</span>}
                  {label === "Activity" && alerts > 0 &&
                    (collapsed ? (
                      <span className="absolute right-3 top-2 h-2 w-2 rounded-full bg-bad" />
                    ) : (
                      <span className="relative rounded-full bg-bad-soft px-2 text-[11px] font-bold leading-5 text-bad tabular">{alerts}</span>
                    ))}
                </>
              )}
            </NavLink>
          ))}
        </nav>

        <div className="my-3 h-px shrink-0 bg-rule" />
        {!collapsed && <p className="px-3 pb-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted">This project</p>}
        <nav aria-label="Project" className="flex flex-col gap-1">
          {project.map(({ to, label, icon: Icon, match }) => (
            <NavLink key={to} to={to} data-tour={TOUR_TARGET[label]} title={collapsed ? label : undefined} className={({ isActive }) => item(match(isActive))}>
              {({ isActive }) => (
                <>
                  {match(isActive) && <ActiveMark />}
                  <Icon size={18} className="relative shrink-0" />
                  {!collapsed && <span className="relative">{label}</span>}
                </>
              )}
            </NavLink>
          ))}
        </nav>

        {!collapsed && mode !== "demo" && (
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.2 }}
            className="relative mt-auto shrink-0 overflow-hidden rounded-[16px] bg-gradient-to-br from-[var(--promo-from)] via-[var(--promo-via)] to-[var(--promo-to)] p-4 text-white shadow-[0_18px_40px_-18px_var(--accent-glow)]"
          >
            <div aria-hidden className="pointer-events-none absolute inset-0 opacity-30" style={{ backgroundImage: "radial-gradient(rgba(255,255,255,0.35) 1px, transparent 1px)", backgroundSize: "10px 10px" }} />
            <span className="relative grid h-8 w-8 place-items-center rounded-[9px] bg-white/20"><IconFlask size={16} /></span>
            <p className="relative mt-2.5 text-sm font-semibold">{billing === "subscription" ? "Try a smaller model" : "Try a cheaper model"}</p>
            <p className="relative mt-1 text-xs text-white/80">Replays your past prompts, within a budget you set.</p>
            <Link to={p("/retest")} className="relative mt-3 block rounded-[10px] bg-white/95 px-3 py-2 text-center text-xs font-semibold text-[var(--promo-ink)] transition-colors hover:bg-white">
              Start a trial
            </Link>
          </motion.div>
        )}
      </div>
    </motion.aside>
  );
}

/** The highlight behind the current page in the sidebar, sliding between items. */
function ActiveMark() {
  return (
    <motion.span layoutId="side-active" className="absolute inset-0 rounded-[11px] bg-accent-soft" transition={{ type: "spring", stiffness: 500, damping: 40 }}>
      <span className="absolute -left-3 bottom-1.5 top-1.5 w-[3px] rounded-r-full bg-accent" />
    </motion.span>
  );
}

export function Frame() {
  const p = useP();
  const nav = useNav();
  const { pathname, search } = useLocation();
  const { count: alerts } = useAlertsCount();
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const [tour, setTour] = useState(false);
  const toggle = () => {
    const next = !collapsed;
    setCollapsed(next);
    try {
      localStorage.setItem(SIDEBAR_KEY, next ? "1" : "0");
    } catch {
      /* kept for this visit */
    }
  };

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
      <div className="min-h-screen md:flex">
        <Sidebar collapsed={collapsed} onToggle={toggle} alerts={alerts} />

        <div className="flex min-w-0 flex-1 flex-col">
          <header className="sticky top-0 z-40 border-b border-rule bg-bg/75 backdrop-blur-xl">
            <div className="mx-auto flex h-16 w-full max-w-[1320px] items-center gap-3 px-4 md:px-6">
              {/* phones: the logo and project, since the sidebar is hidden */}
              <Link to={p("/")} className="flex shrink-0 items-center md:hidden" aria-label="Overview">
                <IconLogo size={28} />
              </Link>
              <div className="min-w-0 md:hidden">
                <ProjectSwitcher />
              </div>

              <button
                type="button"
                onClick={() => setPaletteOpen(true)}
                className="hidden w-full max-w-sm items-center gap-2 rounded-[11px] border border-rule bg-surface px-3 py-2 text-sm text-muted shadow-sm transition-colors hover:border-rule-strong hover:text-dim md:flex"
              >
                <IconSearch size={15} />
                <span className="flex-1 text-left">Search AI tasks, models, pages…</span>
                <kbd className="rounded-[6px] border border-rule bg-surface-2 px-1.5 font-mono text-[10px]">Ctrl K</kbd>
              </button>

              <div className="ml-auto flex shrink-0 items-center gap-2">
                <button
                  type="button"
                  onClick={() => setPaletteOpen(true)}
                  aria-label="Search"
                  className="grid h-9 w-9 place-items-center rounded-full text-muted hover:bg-surface-2 hover:text-ink md:hidden"
                >
                  <IconSearch size={17} />
                </button>
                <ThemeToggle />
                <Link
                  to={p("/activity?tab=alerts")}
                  aria-label={alerts ? `${alerts} open alerts` : "Alerts"}
                  className="relative grid h-9 w-9 place-items-center rounded-full border border-rule bg-surface text-muted transition-colors hover:text-ink"
                >
                  <IconBell size={17} />
                  {alerts > 0 && <span className="absolute right-1.5 top-1.5 h-2 w-2 rounded-full bg-bad ring-2 ring-surface" />}
                </Link>
                <AccountMenu onTour={() => setTour(true)} />
              </div>
            </div>
          </header>

          <main className="mx-auto w-full max-w-[1320px] px-4 pb-28 pt-6 md:px-6 md:pb-16 md:pt-8">
            <RouteErrorBoundary key={pathname}>
              <Suspense fallback={<PageFallback />}>
                <AnimatePresence mode="wait">
                  <motion.div
                    key={pathname + search.replace(/(tab|days)=[^&]*/g, "")}
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
        </div>

        {/* Phone: the four destinations as a bottom bar */}
        <nav aria-label="Main" className="fixed inset-x-0 bottom-0 z-40 border-t border-rule bg-bg/90 backdrop-blur-xl md:hidden" style={{ paddingBottom: "env(safe-area-inset-bottom)" }}>
          <ul className="grid grid-cols-5">
            {nav.map(({ to, label, icon: Icon, end }) => (
              <li key={to}>
                <NavLink
                  to={to}
                  end={end}
                  data-tour={TOUR_TARGET[label]}
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
        <TourHost replay={tour} onReplayDone={() => setTour(false)} />
      </div>
    </MotionConfig>
  );
}
