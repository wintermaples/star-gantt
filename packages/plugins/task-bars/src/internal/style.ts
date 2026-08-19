/**
 * Colour resolution for `stargantt.task-bars`: which fill a bar is painted in, and the fault
 * barrier around a `taskbars/style` contribution.
 *
 * The constants and the token names live in `./paint`; this module only decides precedence.
 */
import type { Task } from "@stargantt/plugin-data-store";
import type { BarStyle, BarStyleProvider } from "../types";
import type { ThemeReader } from "./deps";
import { DEFAULT_TRACK_ALPHA, TRACK_ALPHA_TOKEN, defaultColorFor, tokenFor } from "./paint";

// Function-shaped contributions are invoked by the point-owning plugin, which must guard them and
// report through `core/pluginError`.
/**
 * Wraps one `taskbars/style` contribution in the fault barrier, latched.
 *
 * The composite runs once per visible row per frame, so an unlatched report would emit
 * `core/pluginError` at frame rate. A throwing contribution is reported once and then declines for
 * good; a new contribution rebuilds the reduction, which produces fresh wrappers with clear
 * latches.
 */
export function guardStyleProvider(
  fn: BarStyleProvider,
  fault: (error: unknown) => void,
): BarStyleProvider {
  let faulted = false;
  return (task) => {
    if (faulted) return undefined;
    try {
      return fn(task);
    } catch (error) {
      faulted = true;
      fault(error);
      return undefined;
    }
  };
}

// docs/specs/plugins/task-bars.md "Extension points" — precedence over the bar's fill is
// style point > `task.meta.color` > type-driven theme token. The extension point wins because it is
// the interception mechanism and can itself read `task.meta`.
/**
 * The fill one bar is painted in: the reduced `taskbars/style` provider's colour, else
 * `task.meta.color`, else the theme token for the task's type, else the built-in constant.
 *
 * `provider` is the reduced value of the `taskbars/style` point, resolved once per pass by the
 * caller; anything that is not a function (a faulting reducer yields `undefined` from the core)
 * simply declines to override.
 */
export function resolveBarColor(
  task: Readonly<Task>,
  provider: BarStyleProvider | undefined,
  theme: ThemeReader,
): string {
  const style: BarStyle | undefined = typeof provider === "function" ? provider(task) : undefined;
  const styled = style?.color;
  if (typeof styled === "string" && styled !== "") return styled;
  const meta = task.meta?.["color"];
  if (typeof meta === "string" && meta !== "") return meta;
  // The built-in fill is a theme token; an empty string (token unset, no computed style) falls back
  // to the hard-coded light-mode constant. The theme service memoises one bulk `getComputedStyle`
  // per theme generation, so this read per bar per pass is a map lookup.
  const token = theme.get(tokenFor(task));
  return token !== "" ? token : defaultColorFor(task);
}

// The track alpha is a token as well, read with the same consumer pattern extended to numbers: the
// caller parses with `parseFloat` and falls back on a non-finite result. It has no `task.meta` /
// `taskbars/style` override — it applies to whatever fill the bar resolved to — so it is read
// unconditionally, once per pass rather than once per bar.
/** The opacity of the uncompleted part of a bar for one pass. */
export function resolveTrackAlpha(theme: ThemeReader): number {
  const parsed = Number.parseFloat(theme.get(TRACK_ALPHA_TOKEN));
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(1, parsed) : DEFAULT_TRACK_ALPHA;
}
