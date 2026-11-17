/** "Add widget": a drawer from the right listing every widget. Pick one with its Add button (the keyboard and pointer alternative to dragging, WCAG 2.5.7), or drag its
 * card out onto the overview; the card tilts while it is carried and a drop zone shows where it lands. */
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "framer-motion";
import { IconCheck, IconClose, IconGrip } from "../../ui/icons";
import { Button, cx } from "../../ui/primitives";
import { WIDGETS, type Thumb, type WidgetId } from "./layout";

/** A small picture of what each kind of widget looks like. */
function Thumbnail({ kind }: { kind: Thumb }) {
  const a = "var(--color-accent)";
  const m = "var(--color-rule-strong)";
  const g = "var(--color-ok)";
  return (
    <svg viewBox="0 0 80 56" className="h-full w-full" aria-hidden>
      {kind === "kpi" && [0, 1].map((i) => (
        <g key={i} transform={`translate(${4 + i * 38} 10)`}>
          <rect width="34" height="36" rx="6" fill="var(--color-surface)" stroke={m} />
          <rect x="5" y="7" width="14" height="3" rx="1.5" fill={m} />
          <rect x="5" y="16" width="18" height="6" rx="2" fill="var(--color-ink)" opacity="0.8" />
          <rect x="5" y="27" width="10" height="4" rx="2" fill={i ? "var(--color-bad)" : g} opacity="0.7" />
        </g>
      ))}
      {kind === "hero" && <>
        <rect x="6" y="12" width="44" height="6" rx="3" fill="var(--color-ink)" opacity="0.8" />
        <rect x="6" y="22" width="30" height="6" rx="3" fill={a} />
        <rect x="6" y="34" width="52" height="3" rx="1.5" fill={m} />
        <rect x="54" y="40" width="20" height="8" rx="4" fill={a} />
      </>}
      {kind === "line" && <>
        <path d="M6 42 L18 34 L28 38 L40 22 L52 28 L62 16 L74 20" fill="none" stroke={a} strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M6 44 L18 40 L28 42 L40 34 L52 36 L62 30 L74 32" fill="none" stroke="var(--color-muted)" strokeWidth="1.6" strokeDasharray="3 3" />
        <circle cx="62" cy="16" r="3.2" fill={a} stroke="var(--color-surface)" strokeWidth="1.5" />
      </>}
      {kind === "gauge" && Array.from({ length: 15 }, (_, i) => {
        const t = ((200 - i * 15.7) * Math.PI) / 180;
        return <line key={i} x1={40 + 15 * Math.cos(t)} y1={40 - 15 * Math.sin(t)} x2={40 + 23 * Math.cos(t)} y2={40 - 23 * Math.sin(t)} stroke={i < 10 ? g : m} strokeWidth="3" strokeLinecap="round" />;
      })}
      {kind === "split" && ["var(--series-1)", "var(--series-3)", "var(--series-2)"].map((c, i) => (
        <g key={c} transform={`translate(${6 + [0, 30, 52][i]} 14)`}>
          <rect width="2" height="24" fill={c} />
          <rect x="5" y="3" width="12" height="5" rx="2" fill="var(--color-ink)" opacity="0.75" />
          <rect x="5" y="12" width="9" height="3" rx="1.5" fill={m} />
          <rect y="26" width={[26, 20, 16][i]} height="4" rx="2" fill={c} />
        </g>
      ))}
      {kind === "pills" && [16, 22, 34, 18, 12, 20, 24].map((h, i) => (
        <rect key={i} x={8 + i * 9.5} y={46 - h} width="6.5" height={h} rx="3.25" fill={i === 2 ? a : m} />
      ))}
      {kind === "table" && [0, 1, 2, 3].map((i) => (
        <g key={i} transform={`translate(6 ${8 + i * 11})`}>
          <rect width="22" height="4" rx="2" fill={i ? "var(--color-ink)" : m} opacity={i ? 0.7 : 1} />
          <rect x="34" width="12" height="4" rx="2" fill={m} />
          <rect x="54" width="14" height="4" rx="2" fill={i ? (i === 2 ? "var(--color-bad)" : g) : m} opacity="0.7" />
        </g>
      ))}
      {kind === "list" && [0, 1, 2].map((i) => (
        <g key={i} transform={`translate(8 ${9 + i * 13})`}>
          <rect width="64" height="10" rx="3" fill="var(--color-surface)" stroke={m} />
          <circle cx="6" cy="5" r="2" fill={i ? "var(--color-warn)" : "var(--color-bad)"} />
          <rect x="12" y="3.5" width={[38, 30, 44][i]} height="3" rx="1.5" fill={m} />
        </g>
      ))}
      {kind === "area" && <>
        <path d="M6 46 L6 34 L20 30 L34 36 L48 24 L62 28 L74 18 L74 46 Z" fill="var(--series-1)" opacity="0.35" />
        <path d="M6 46 L6 40 L20 38 L34 42 L48 34 L62 38 L74 30 L74 46 Z" fill="var(--series-3)" opacity="0.45" />
      </>}
      {kind === "steps" && [0, 1, 2, 3].map((i) => (
        <g key={i}>
          <circle cx={12 + i * 19} cy="28" r="6" fill={i < 3 ? a : m} opacity={0.4 + i * 0.2} />
          {i < 3 && <line x1={18 + i * 19} y1="28" x2={25 + i * 19} y2="28" stroke={m} strokeWidth="2" />}
        </g>
      ))}
    </svg>
  );
}

export function WidgetDrawer({ open, onClose, ids, onAdd, onRemove }: { open: boolean; onClose: () => void; ids: WidgetId[]; onAdd: (id: WidgetId) => void; onRemove: (id: WidgetId) => void }) {
  const panel = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState<WidgetId | null>(null);
  const [overZone, setOverZone] = useState(false);
  const [justAdded, setJustAdded] = useState<WidgetId | null>(null);

  // ARIA modal dialog: focus goes in, Tab stays in, Escape closes, focus goes back, the page behind is inert.
  useEffect(() => {
    if (!open) return;
    const opener = document.activeElement as HTMLElement | null;
    const app = document.getElementById("root");
    app?.setAttribute("inert", "");
    app?.setAttribute("aria-hidden", "true");
    const focusables = () =>
      Array.from(panel.current?.querySelectorAll<HTMLElement>('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])') ?? []).filter(
        (el) => !el.hasAttribute("disabled"),
      );
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") return onClose();
      if (e.key !== "Tab") return;
      const items = focusables();
      if (items.length === 0) return e.preventDefault();
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement as HTMLElement | null;
      const inside = !!active && !!panel.current?.contains(active) && active !== panel.current;
      if (e.shiftKey && (!inside || active === first)) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && (!inside || active === last)) { e.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", onKey);
    panel.current?.focus();
    return () => {
      document.removeEventListener("keydown", onKey);
      app?.removeAttribute("inert");
      app?.removeAttribute("aria-hidden");
      opener?.focus();
    };
  }, [open, onClose]);

  const outside = (x: number) => {
    const left = panel.current?.getBoundingClientRect().left ?? Infinity;
    return x < left - 16;
  };
  const add = (id: WidgetId) => {
    onAdd(id);
    setJustAdded(id);
    window.setTimeout(() => setJustAdded((v) => (v === id ? null : v)), 1600);
  };
  const all = Object.keys(WIDGETS) as WidgetId[];

  // Rendered in <body>, outside #root, so the app behind can be made inert while the dialog is open.
  return createPortal(
    <AnimatePresence>
      {open && (
        <div className="fixed inset-0 z-50">
          <motion.div className="absolute inset-0 bg-overlay/45 backdrop-blur-[2px]" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={onClose} />

          {/* where a carried card lands */}
          <AnimatePresence>
            {dragging && (
              <motion.div
                initial={{ opacity: 0, scale: 0.98 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0 }}
                className={cx(
                  "pointer-events-none absolute bottom-8 left-8 right-[min(460px,90vw)] top-8 mr-8 hidden place-items-center rounded-[24px] border-2 border-dashed transition-colors md:grid",
                  overZone ? "border-accent bg-accent/15" : "border-white/50 bg-white/5",
                )}
              >
                <p className={cx("rounded-full px-4 py-2 text-sm font-semibold shadow-lg", overZone ? "bg-accent text-on-accent" : "bg-surface text-ink")}>
                  {overZone ? `Drop to add ${WIDGETS[dragging].title}` : "Drag here to add it to your overview"}
                </p>
              </motion.div>
            )}
          </AnimatePresence>

          <motion.aside
            ref={panel}
            tabIndex={-1}
            role="dialog"
            aria-modal="true"
            aria-label="Add widget"
            initial={{ x: "100%" }}
            animate={{ x: 0 }}
            exit={{ x: "100%" }}
            transition={{ type: "spring", stiffness: 320, damping: 34 }}
            className="absolute bottom-0 right-0 top-0 flex w-[min(460px,100vw)] flex-col border-l border-rule bg-surface shadow-2xl outline-none sm:bottom-3 sm:right-3 sm:top-3 sm:rounded-[22px] sm:border"
          >
            <header className="flex items-center justify-between border-b border-rule px-6 py-5">
              <div>
                <h2 className="text-lg font-semibold tracking-tight text-ink">Add widget</h2>
                <p className="mt-0.5 text-xs text-muted">Each widget is a card on your overview. Pick one to add it, or drag its card onto your overview.</p>
              </div>
              <button type="button" onClick={onClose} aria-label="Close" className="grid h-9 w-9 place-items-center rounded-full border border-rule text-muted hover:text-ink"><IconClose size={16} /></button>
            </header>
            <ul className={cx("flex flex-1 flex-col gap-3 px-6 py-5", dragging ? "overflow-visible" : "overflow-y-auto")}>
              {all.map((id, i) => {
                const w = WIDGETS[id];
                const added = ids.includes(id);
                return (
                  <motion.li key={id} initial={{ opacity: 0, x: 24 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: 0.08 + i * 0.03 }} className="relative">
                    <motion.div
                      drag={!added}
                      dragSnapToOrigin
                      dragElastic={0.9}
                      onDragStart={() => setDragging(id)}
                      onDrag={(e) => setOverZone(outside((e as PointerEvent).clientX))}
                      onDragEnd={(e) => {
                        if (outside((e as PointerEvent).clientX)) add(id);
                        setDragging(null);
                        setOverZone(false);
                      }}
                      whileDrag={{ rotate: -5, scale: 1.04, zIndex: 60, boxShadow: "0 30px 60px -20px rgba(30,20,80,0.45)" }}
                      className={cx(
                        "flex gap-4 rounded-[16px] border bg-surface p-3 transition-colors",
                        added ? "border-rule opacity-80" : "cursor-grab border-rule hover:border-accent/40 active:cursor-grabbing",
                        justAdded === id && "border-ok",
                      )}
                    >
                      <div className="h-[72px] w-[100px] shrink-0 rounded-[12px] border border-rule bg-surface-2 p-1.5">
                        <Thumbnail kind={w.thumb} />
                      </div>
                      <div className="flex min-w-0 flex-1 flex-col">
                        <div className="flex items-start justify-between gap-2">
                          <p className="text-sm font-semibold text-ink">{w.title}</p>
                          {!added && <IconGrip size={16} className="shrink-0 text-muted" />}
                        </div>
                        <p className="mt-0.5 text-xs leading-snug text-dim">{w.text}</p>
                        <div className="mt-auto flex items-center justify-between gap-2 pt-2">
                          <span className="rounded-[6px] border border-rule bg-surface-2 px-1.5 py-0.5 text-[11px] text-muted">#{w.tag}</span>
                          {added ? (
                            <span className="flex items-center gap-2">
                              <span className="flex items-center gap-1 text-xs font-semibold text-ok"><IconCheck size={13} /> On your overview</span>
                              <button type="button" onClick={() => onRemove(id)} className="text-xs font-semibold text-muted underline-offset-2 hover:text-bad hover:underline">Remove</button>
                            </span>
                          ) : (
                            <Button size="sm" variant="primary" onClick={() => add(id)}>Add</Button>
                          )}
                        </div>
                      </div>
                    </motion.div>
                  </motion.li>
                );
              })}
            </ul>
          </motion.aside>
        </div>
      )}
    </AnimatePresence>,
    document.body,
  );
}
