// docs/specs/plugins/scheduling.md §2.4 (`engine/modes.ts`)
/**
 * Per-task scheduling mode — the manual/auto mixed-mode surface.
 *
 * A task is **manually scheduled** when its `meta.scheduleMode` is the string `"manual"`; every
 * other shape (absent `meta`, absent key, any other value) is **automatically scheduled**, the
 * default. The mode lives in `task.meta` so it rides the ordinary patch/undo pipeline and needs no
 * store change.
 *
 * A manual task is never *moved* by the engine — not by forward propagation, not by the back-clamp
 * pass, not by a reschedule run — but it still participates as a predecessor: its current times
 * feed its successors' bounds, and it still rolls up into its parent summary. A manual summary
 * keeps its own dates instead of rolling up.
 */
import type { Task } from "@stargantt/plugin-data-store";

/** The two scheduling modes a task can be in. */
export type TaskScheduleMode = "auto" | "manual";

/** The `task.meta` key the mode is stored under. */
export const SCHEDULE_MODE_META_KEY = "scheduleMode";

/**
 * The task's scheduling mode. `"manual"` only when `meta.scheduleMode === "manual"`; any other
 * shape — absent meta, absent key, any other value — is `"auto"`.
 */
export function scheduleModeOf(task: Readonly<Task> | undefined): TaskScheduleMode {
  if (task?.meta === undefined) return "auto";
  return task.meta[SCHEDULE_MODE_META_KEY] === "manual" ? "manual" : "auto";
}

/** Whether the engine must leave this task's dates untouched. */
export function isManualTask(task: Readonly<Task>): boolean {
  return scheduleModeOf(task) === "manual";
}
