/** The first-visit tour, as plain data: what each step says and which real part of the app it points at.
 * A step with no `target` is shown as a centred card. Every other step points at an element marked
 * `data-tour="<target>"` (the sidebar and the phone's bottom bar both carry the marks). */

export interface TourStep {
  id: string;
  title: string;
  /** One or two short sentences about what the page is for. */
  body: string;
  /** What the person will see there once calls arrive. The screens are empty now. */
  later: string;
  target?: string;
  /** Shown with the exact line of code. */
  code?: boolean;
}

export const TOUR_STEPS: readonly TourStep[] = [
  {
    id: "first-call",
    title: "Send your first call",
    body: "Your project is ready, but your app has not sent anything yet. Put this around the AI call your code already makes. Your project key is under API keys in Settings.",
    later: "Once a call arrives, everything on the next pages starts to fill in.",
    code: true,
  },
  {
    id: "overview",
    title: "Overview",
    body: "This is your home page. It shows what your app spends on AI and how often the answers are correct.",
    later: "Once calls arrive, you will see your spending and your correct-answer rate here.",
    target: "overview",
  },
  {
    id: "tasks",
    title: "AI tasks",
    body: "An AI task is one kind of work your code asks an AI to do, such as reading invoices. The task name you put in your code decides which AI task a call belongs to.",
    later: "Once calls arrive, each task is listed here with its own cost and results.",
    target: "tasks",
  },
  {
    id: "compare",
    title: "Smart compare",
    body: "Here you can see which AI model costs the least and still gives answers that are good enough.",
    later: "Once enough of your answers are checked, we show how each model did on your own work.",
    target: "compare",
  },
  {
    id: "activity",
    title: "Activity and alerts",
    body: "This page shows warnings, such as answers getting worse or a model being retired. A red dot appears when something needs you.",
    later: "Once calls arrive, you will see them here as they come in.",
    target: "activity",
  },
  {
    id: "settings",
    title: "Settings",
    body: "Set your limits here and we warn you before you reach them. We never stop your app. You can also change your alerts and keys.",
    later: "Nothing is watched until you set a limit.",
    target: "settings",
  },
];

export interface GuideFlags {
  tour_seen?: boolean;
  first_results_seen?: boolean;
  welcome_seen?: boolean;
}

/** The tour opens by itself once: for a signed-in owner, on a project with no calls yet, who has not seen it. */
export function shouldAutoStartTour(a: { flagsLoaded: boolean; flags: GuideFlags; owned: boolean; dataLoaded: boolean; totalRuns: number }): boolean {
  return a.owned && a.flagsLoaded && a.dataLoaded && !a.flags.tour_seen && a.totalRuns === 0;
}

/** What "next", "back" and "skip" do. `null` means the tour is over. */
export function nextStep(at: number, dir: 1 | -1, count: number = TOUR_STEPS.length): number | null {
  const to = at + dir;
  if (to < 0) return 0;
  return to >= count ? null : to;
}
