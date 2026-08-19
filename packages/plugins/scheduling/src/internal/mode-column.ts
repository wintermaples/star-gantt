// docs/specs/plugins/scheduling.md §2.4
/**
 * The opt-in schedule-mode indicator column: one read-only tree-grid column showing whether each
 * task is manually or automatically scheduled. Contributed to `grid/columns` only under
 * `autoSchedule.modeColumn: true`, so the default configuration renders byte-identically to a build
 * without this feature. Without the tree-grid plugin the contribution is inert.
 *
 * The column id is `"scheduling.mode"` — renamed from the earlier `"auto-schedule.mode"`, which named a
 * plugin that no longer exists (§2.4, recorded resolution).
 */
// Type-only: it loads tree-grid's `ColumnDef` and its extension-point augmentation without adding a
// runtime dependency.
import type { ColumnDef } from "@stargantt/plugin-tree-grid";
import { scheduleModeOf } from "../engine/modes";
import type { SchedulingMessages } from "./messages";

/** Identity of the column in the `grid/columns` point. */
export const MODE_COLUMN_ID = "scheduling.mode";

/** Width of the mode column, px. */
const MODE_COLUMN_WIDTH = 64;

/** Builds the read-only schedule-mode column. */
export function buildModeColumn(messages: SchedulingMessages): ColumnDef {
  const label = (mode: "auto" | "manual"): string =>
    mode === "manual" ? messages.modeManual : messages.modeAuto;
  return {
    id: MODE_COLUMN_ID,
    header: messages.modeColumnHeader,
    width: MODE_COLUMN_WIDTH,
    render(el, task) {
      el.textContent = label(scheduleModeOf(task));
    },
    getValue(task) {
      return label(scheduleModeOf(task));
    },
    compare(a, b) {
      return label(scheduleModeOf(a)).localeCompare(label(scheduleModeOf(b)));
    },
  };
}
