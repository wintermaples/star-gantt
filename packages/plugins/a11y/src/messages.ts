// docs/specs/plugins/a11y.md § Messages
/**
 * The replaceable text this plugin hands to a screen reader, together with its built-in English
 * defaults and the per-key merge that produces the catalog a running instance uses.
 */
import { isoDay } from "@stargantt/sdk";
import type { A11yMessages } from "./types";

/** How a faulty host builder is reported: the key it failed under, and what it threw. */
export type MessageFault = (key: keyof A11yMessages, cause: unknown) => void;

/** `2024-01-31` from an epoch-ms instant, or the empty string when it does not format. */
function day(t: number): string {
  return isoDay(t) ?? "";
}

// docs/specs/plugins/a11y.md § Messages — normative defaults; omitting `messages` must reproduce
// them byte for byte, which is what keeps the committed ARIA-text expectations valid.
/** The built-in English catalog. */
export const DEFAULT_MESSAGES: A11yMessages = {
  rowText: (parts) => {
    const out = [parts.name, `${day(parts.start)} – ${day(parts.end)}`];
    if (parts.progress !== undefined) out.push(`${Math.round(parts.progress * 100)}%`);
    return out.join(", ");
  },
  rowExpanded: (name) => (name === undefined ? "expanded" : `${name}, expanded`),
  rowCollapsed: (name) => (name === undefined ? "collapsed" : `${name}, collapsed`),
  selectionCount: (count) => `${count} selected`,
  sortChanged: ({ header, direction }) =>
    direction === null ? `${header}, sort off` : `${header}, sorted ${direction}`,
  editCommitted: (name) => (name === undefined ? "updated" : `${name}, updated`),
  rowDependencies: ({ predecessors, successors }) => {
    const parts: string[] = [];
    if (predecessors.length > 0) parts.push(`Depends on: ${predecessors.join(", ")}`);
    if (successors.length > 0) parts.push(`Blocks: ${successors.join(", ")}`);
    return parts.join(". ");
  },
  shortcutHelpTitle: () => "Keyboard shortcuts",
  shortcutHelpClose: () => "Close",
  zoomChanged: (level) => `Zoom: ${level}`,
  summaryTitle: ({ total, shown }) =>
    shown === total
      ? `Gantt chart summary, ${total} tasks`
      : `Gantt chart summary, first ${shown} of ${total} tasks`,
  summaryHeader: (column) =>
    ({ name: "Name", start: "Start", end: "End", progress: "Progress" })[column],
};

/**
 * The catalog this instance speaks: the defaults with every usable host-supplied member merged over
 * them, one key at a time.
 *
 * A member that is not a function is unusable and leaves its default in place. A supplied builder
 * is foreign code, so each call is guarded: a throw is reported through `onFault` and the built-in
 * default answers **that one call**, so a faulty catalog never silences the grid and never latches
 * a key off for the rest of the session.
 */
export function resolveMessages(
  overrides: Partial<A11yMessages> | undefined,
  onFault: MessageFault,
): A11yMessages {
  const resolved: A11yMessages = { ...DEFAULT_MESSAGES };
  if (overrides === null || typeof overrides !== "object") return resolved;

  for (const key of Object.keys(DEFAULT_MESSAGES) as (keyof A11yMessages)[]) {
    const supplied = overrides[key];
    if (typeof supplied !== "function") continue;
    const build = supplied as (arg: never) => string;
    const builtIn = DEFAULT_MESSAGES[key] as (arg: never) => string;
    resolved[key] = ((arg: never): string => {
      try {
        return build(arg);
      } catch (error) {
        onFault(key, error);
        return builtIn(arg);
      }
    }) as never;
  }
  return resolved;
}
