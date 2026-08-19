/**
 * The reader's colour-scheme choice.
 *
 * Three states rather than two, because a light/dark pair has no way back: a reader who tries the
 * other scheme once is stuck with it on a machine that switches at sunset. `"system"` is the state
 * a first visit is in, and the one the button cycles back to.
 */
export type ThemeChoice = "system" | "light" | "dark";

export const THEME_ORDER: readonly ThemeChoice[] = ["system", "light", "dark"];

export const THEME_LABEL: Readonly<Record<ThemeChoice, string>> = {
  system: "follows your system",
  light: "light",
  dark: "dark",
};

const KEY = "stargantt-docs-theme";

/**
 * Notified after the choice has been applied to `<html>`.
 *
 * A chart watches its own element for theme-relevant attribute changes, not its ancestors — so a
 * `data-theme` written on `<html>` gives every mounted chart new CSS values and no idea that they
 * changed. Telling them is the host's job, and this is how this host discharges it; `GanttPreview`
 * turns each notification into a `theme.refresh()` on the instance it owns.
 */
const listeners = new Set<() => void>();

export function subscribeTheme(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const isChoice = (value: unknown): value is ThemeChoice =>
  value === "system" || value === "light" || value === "dark";

/** The stored choice, or `"system"` — including when storage is unavailable or holds nonsense. */
export function storedTheme(): ThemeChoice {
  try {
    const raw = localStorage.getItem(KEY);
    return isChoice(raw) ? raw : "system";
  } catch {
    // Storage can throw outright (a browser with cookies blocked), which is a reason to fall back
    // to the OS scheme, never a reason to fail to paint the page.
    return "system";
  }
}

/**
 * Puts the choice on `<html>` and remembers it.
 *
 * `"system"` removes the attribute rather than writing a value: the stylesheet's default is the
 * OS-following one, so the absence of an override is what following the OS means.
 */
export function applyTheme(choice: ThemeChoice): void {
  const root = document.documentElement;
  if (choice === "system") delete root.dataset["theme"];
  else root.dataset["theme"] = choice;
  try {
    localStorage.setItem(KEY, choice);
  } catch {
    // A choice that cannot be remembered still applies for this visit.
  }
  for (const listener of listeners) listener();
}

export function nextTheme(choice: ThemeChoice): ThemeChoice {
  return THEME_ORDER[(THEME_ORDER.indexOf(choice) + 1) % THEME_ORDER.length]!;
}
