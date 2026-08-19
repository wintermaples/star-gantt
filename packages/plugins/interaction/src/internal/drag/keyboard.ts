// docs/specs/plugins/interaction.md §5 — the keyboard equivalents of the pointer edits: which
// chords exist, and what one press computes.
/**
 * The chords are data and the arithmetic is a function of the task's own values, so both can be
 * exercised without a host, a focus owner or a key-binding point.
 */
import { MS_DAY } from "@stargantt/sdk";
import type { DragMode, TimeRange } from "./gesture";
import { proposeRange, sameRange, unrounded } from "./gesture";

// Every pointer edit needs a keyboard equivalent (WCAG 2.1.1). The chords mirror the pointer
// gestures: plain arrows already walk the rows in the a11y plugin, so Ctrl moves the focused task,
// Ctrl+Shift resizes its end and Ctrl+Alt its start.
/** Chords the keyboard equivalent of a date drag is bound to, paired with what each one does. */
export const EDIT_KEYS: readonly { key: string; mode: DragMode; direction: 1 | -1 }[] = [
  { key: "Ctrl+ArrowRight", mode: "move", direction: 1 },
  { key: "Ctrl+ArrowLeft", mode: "move", direction: -1 },
  { key: "Ctrl+Shift+ArrowRight", mode: "resize-end", direction: 1 },
  { key: "Ctrl+Shift+ArrowLeft", mode: "resize-end", direction: -1 },
  { key: "Ctrl+Alt+ArrowRight", mode: "resize-start", direction: 1 },
  { key: "Ctrl+Alt+ArrowLeft", mode: "resize-start", direction: -1 },
];

/** Chords the keyboard equivalent of a progress drag is bound to, paired with its direction. */
export const PROGRESS_KEYS: readonly { key: string; direction: 1 | -1 }[] = [
  { key: "Ctrl+Shift+ArrowUp", direction: 1 },
  { key: "Ctrl+Shift+ArrowDown", direction: -1 },
];

/** How far one keyboard press steps the completion fraction. */
export const PROGRESS_STEP = 0.1;

/** The rounding rule a chord consults: how far one step moves, and where the result lands. */
export interface Stepping {
  snap(t: number): number;
  step(t: number, direction: 1 | -1): number;
}

/**
 * How far one keyboard step moves a time, signed, as the chart's rounding rule measures it.
 *
 * With no rounding rule composed a chord still has to move the task by something, and one UTC day
 * is what a scale-less chart resolves to. The chords have no Alt-style bypass, so they always
 * consult the rule when there is one.
 */
export function stepFrom(t: number, direction: 1 | -1, rounding: Stepping | undefined): number {
  return rounding?.step(t, direction) ?? direction * MS_DAY;
}

/**
 * The dates one chord press would commit, or `undefined` when the press changes nothing.
 *
 * The edge the chord moves is the one the step is measured from, so a month-long step out of
 * February is a February-sized step; the stepped instant is then rounded by the same rule the
 * pointer path uses.
 */
export function steppedRange(
  mode: DragMode,
  origin: Readonly<TimeRange>,
  direction: 1 | -1,
  rounding: Stepping | undefined,
  minDuration = 0,
): TimeRange | undefined {
  const anchor = mode === "resize-end" ? origin.end : origin.start;
  const round = rounding === undefined ? unrounded : (t: number): number => rounding.snap(t);
  const range = proposeRange(mode, origin, stepFrom(anchor, direction, rounding), round, minDuration);
  return sameRange(range, origin) ? undefined : range;
}

/**
 * The completion fraction one progress chord press would commit, clamped to 0..1.
 *
 * Rounded to avoid the binary-fraction drift repeated 0.1 steps would otherwise accumulate, while
 * still landing on whatever precision the task's own stored progress already carries. A result
 * equal to `current` means the press changes nothing.
 */
export function nextProgress(current: number, direction: 1 | -1): number {
  const stepped = Math.min(1, Math.max(0, current + direction * PROGRESS_STEP));
  return Math.round(stepped * 1e10) / 1e10;
}
