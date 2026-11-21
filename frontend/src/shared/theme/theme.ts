/** Light or dark. Light is the default; a choice is remembered in this browser only. */
import { useSyncExternalStore } from "react";

export type Theme = "light" | "dark";

const KEY = "mcm_theme";
const listeners = new Set<() => void>();

export function getTheme(): Theme {
  return document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "light";
}

export function setTheme(theme: Theme) {
  const root = document.documentElement;
  root.classList.add("theme-switching");
  root.setAttribute("data-theme", theme);
  try {
    if (theme === "dark") localStorage.setItem(KEY, "dark");
    else localStorage.removeItem(KEY);
  } catch {
    /* storage blocked: the choice lasts until the page closes */
  }
  window.setTimeout(() => root.classList.remove("theme-switching"), 400);
  listeners.forEach((fn) => fn());
}

function subscribe(fn: () => void) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function useTheme(): [Theme, (t: Theme) => void] {
  const theme = useSyncExternalStore(subscribe, getTheme, () => "light" as Theme);
  return [theme, setTheme];
}
