// docs/specs/plugins/undo-redo.md — Replay
/**
 * Provenance stamped on every transaction a replay produces.
 *
 * Replayed patches are the exact patches an earlier action applied, so a plugin that derives
 * follow-on changes from a user edit — automatic scheduling above all — must not derive them
 * again: doing so would recompute state the replay is in the middle of restoring and overwrite it.
 * Marking the replay as something other than a user edit is what lets those plugins stand aside.
 *
 * This is also the ONLY origin-sensitive logic this plugin has (docs/specs/plugins/undo-redo.md
 * "Origin sensitivity note"): a replay is recognized by this cause, never by a
 * "currently replaying" flag.
 */
export const REPLAY_ORIGIN = "history";

// docs/specs/plugins/data-store.md — the store publishes its own patch-inversion logic
// (`invertPatch`); this plugin imports it rather than keeping a copy that could drift from the
// store's own apply/invert pairing.
export { invertPatch } from "@stargantt/plugin-data-store";
