// docs/specs/plugins/scheduling.md §5.6
/**
 * The two-step keyboard link chord (`Alt+L`): what a press means given the pending link source and
 * the task that currently holds the keyboard focus, and what is announced for it.
 *
 * Pure decision only — no focus service, no command bus — so the chord's four outcomes and their
 * announcements are unit-testable without a host.
 * The announcements are this area's own prose rather than catalog keys: §12 merges the
 * dependencies catalog unchanged at 10 keys, and none of them covers the chord.
 */
import type { TaskId } from "@stargantt/plugin-data-store";
import type { LinkedPredicate } from "./pairs";

/** The chord in `keys/bindings` form (§5.6). */
export const LINK_CHORD = "Alt+L";

/** What one press of the link chord does. */
export type LinkChordStep =
  /** Marks the focused task as the pending link source; nothing is dispatched. */
  | { kind: "mark"; sourceId: TaskId }
  /** The second press landed on the pending source itself: the pending state is dropped. */
  | { kind: "cancel"; sourceId: TaskId }
  /** The second press landed on another task: the link between the two is created. */
  | { kind: "create"; sourceId: TaskId; targetId: TaskId }
  /** The two tasks are linked already: nothing is dispatched, and the pending state is dropped. */
  | { kind: "duplicate"; sourceId: TaskId; targetId: TaskId };

/**
 * What a press of the chord means, given the currently pending source (`null` when none), the
 * focused task, and whether the store already links the pair the press would join.
 */
export function linkChordStep(
  pending: TaskId | null,
  focused: TaskId,
  isLinked: LinkedPredicate,
): LinkChordStep {
  if (pending === null) return { kind: "mark", sourceId: focused };
  if (focused === pending) return { kind: "cancel", sourceId: pending };
  // §5.6 — one dependency per ordered pair: the store would refuse a second one, so the chord
  // resolves the press without dispatching and says why. The pointer path shows the same refusal
  // by withholding the drop-candidate ring; this path paints nothing, so the announcement is the
  // whole feedback.
  if (isLinked(pending, focused)) return { kind: "duplicate", sourceId: pending, targetId: focused };
  return { kind: "create", sourceId: pending, targetId: focused };
}

/**
 * The message announced for a step, naming the tasks involved through `nameOf`, so that the
 * two-step gesture is followable without sight.
 */
export function linkChordAnnouncement(
  step: LinkChordStep,
  nameOf: (id: TaskId) => string,
): string {
  switch (step.kind) {
    case "mark":
      return `${nameOf(step.sourceId)} marked as link source`;
    case "cancel":
      return "Link creation cancelled";
    case "create":
      return `Linked ${nameOf(step.sourceId)} to ${nameOf(step.targetId)}`;
    case "duplicate":
      return `${nameOf(step.sourceId)} is already linked to ${nameOf(step.targetId)}`;
    default: {
      // A new step kind must be given an announcement here rather than falling through silently.
      const never: never = step;
      return never;
    }
  }
}
