// docs/specs/plugins/interaction.md §6.5 — the plugin-local "start link from here" state, with its
// one-shot lifetime as explicit, named transitions.
/**
 * The one-shot lifetime of the pending link source: it survives exactly until the *next* menu
 * invocation completes, however that invocation ends (a link created, some other action chosen, or
 * the menu simply dismissed).
 *
 * An invocation that arms, re-arms (even to the same task) or consumes the source carries the
 * result forward; an invocation that never touches it expires it on completion. A value snapshot
 * cannot express this — re-arming on the same task writes the same value, yet must carry the
 * source forward — so the state tracks whether the current invocation touched it at all.
 */
import type { TaskId } from "@stargantt/plugin-data-store";

export interface LinkSourceState {
  /** The armed source task, or `undefined` while unarmed. */
  get(): TaskId | undefined;
  /**
   * Arms or re-arms the source (or, with `undefined`, consumes it), marking the current
   * invocation as having touched it so `endInvocation` carries the written value forward.
   */
  set(id: TaskId | undefined): void;
  /** A menu invocation opened: nothing has touched the source yet. */
  beginInvocation(): void;
  /**
   * The invocation completed — an activation ran, or the menu was dismissed. A source the
   * invocation never touched is stale and expires here.
   */
  endInvocation(): void;
  /** Freshness: drops an armed source whose task `exists` no longer recognizes. */
  dropUnless(exists: (id: TaskId) => boolean): void;
}

/** Creates the (initially unarmed) pending-link-source state. */
export function createLinkSource(): LinkSourceState {
  let pending: TaskId | undefined;
  let touched = false;
  return {
    get: () => pending,
    set(id) {
      pending = id;
      touched = true;
    },
    beginInvocation() {
      touched = false;
    },
    endInvocation() {
      if (!touched) pending = undefined;
    },
    dropUnless(exists) {
      if (pending !== undefined && !exists(pending)) pending = undefined;
    },
  };
}
