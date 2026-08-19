/**
 * `@stargantt/preset-standard` — the standard StarGantt composition.
 *
 * A single function that returns the official plugins in dependency order. Nothing here is
 * privileged: the returned value is a plain array that callers may reorder, filter or extend
 * before handing it to `Gantt.create`.
 *
 * Nine plugins, closed by design: the four read-only foundation plugins (data-store, view,
 * tree-grid, task-bars) plus interaction, undo-redo, a11y, scheduling and export. The remaining
 * six official plugins — tracking, resource, data-sync, portfolio, i18n and perf-tools — are
 * opt-in: they ship in the `stargantt` bundle as named factory exports, but never in this preset,
 * so a chart never carries their behavior (progress/cost/EVM tracking, resource pools, sync
 * transports, portfolio rollups, translation, perf overlays) unless a caller explicitly composes
 * them in.
 */
import type { AnyPlugin } from "@stargantt/core";
// The bare imports carry each plugin's `declare module "@stargantt/core"` augmentation to preset
// consumers even though the named *value* imports below would pull the same modules in anyway —
// see docs/specs/architecture.md chapter 2 on module augmentation reach.
import "@stargantt/plugin-data-store";
import "@stargantt/plugin-view";
import "@stargantt/plugin-tree-grid";
import "@stargantt/plugin-task-bars";
import "@stargantt/plugin-interaction";
import "@stargantt/plugin-undo-redo";
import "@stargantt/plugin-a11y";
import "@stargantt/plugin-scheduling";
import "@stargantt/plugin-export";
import { dataStore } from "@stargantt/plugin-data-store";
import type { DataStoreConfig } from "@stargantt/plugin-data-store";
import { view } from "@stargantt/plugin-view";
import type { ViewConfig } from "@stargantt/plugin-view";
import { treeGrid } from "@stargantt/plugin-tree-grid";
import type { TreeGridConfig } from "@stargantt/plugin-tree-grid";
import { taskBars } from "@stargantt/plugin-task-bars";
import type { TaskBarsConfig } from "@stargantt/plugin-task-bars";
import { interaction } from "@stargantt/plugin-interaction";
import type { InteractionConfig } from "@stargantt/plugin-interaction";
import { undoRedo } from "@stargantt/plugin-undo-redo";
import type { UndoRedoConfig } from "@stargantt/plugin-undo-redo";
import { a11y } from "@stargantt/plugin-a11y";
import type { A11yConfig } from "@stargantt/plugin-a11y";
import { scheduling } from "@stargantt/plugin-scheduling";
import type { SchedulingConfig } from "@stargantt/plugin-scheduling";
import { exportPlugin } from "@stargantt/plugin-export";
import type { ExportConfig } from "@stargantt/plugin-export";

/**
 * Options for the plugins of the standard preset, keyed by plugin short name.
 *
 * Every key is optional and names one of the composed plugins; the value is that plugin's own
 * config object. An omitted key means the plugin is created with its own defaults, so
 * `presetStandard()` and `presetStandard({})` produce identical charts.
 */
export interface PresetStandardConfig {
  /** Options for the data store, which holds tasks, links, resources and assignments. */
  dataStore?: DataStoreConfig;
  /** Options for the canvas renderer, pane layout, timeline header and theming. */
  view?: ViewConfig;
  /** Options for the row grid, including row height, pane width and indent step. */
  treeGrid?: TreeGridConfig;
  /** Options for the task bars drawn on the chart. */
  taskBars?: TaskBarsConfig;
  /**
   * Options for pointer/keyboard interaction: selection, drag editing, snapping, and the tooltip,
   * context menu, zoom toolbar, clipboard, filter/search, edit dialog and side panel peripherals.
   */
  interaction?: InteractionConfig;
  /** Options for the undo/redo history. */
  undoRedo?: UndoRedoConfig;
  /** Options for keyboard operability and screen-reader support. */
  a11y?: A11yConfig;
  /**
   * Options for the auto-scheduling engine, dependency links, working calendars, critical-path
   * analysis and the schedule-diagnostics panel.
   */
  scheduling?: SchedulingConfig;
  /**
   * Options for image/PDF export, CSV/JSON/iCal/MS-Project/Excel interchange, snapshots and
   * read-only/embed viewing. Keyed `export` (not `exportPlugin`) to match the plugin's own
   * directory/config-nest name — `export` is a reserved word as an identifier, not as a property
   * key, so `config?.export` is valid.
   */
  export?: ExportConfig;
}

/**
 * Returns the standard set of StarGantt plugins, in an order that satisfies every plugin's
 * declared dependencies: data store, view (renderer/panes/timeline-scale/theme), row model, task
 * bars, interaction, undo/redo, accessibility, scheduling, export.
 *
 * Pass the result straight to `Gantt.create({ element, plugins: presetStandard() })`.
 *
 * To configure a plugin without rebuilding the composition, give it its key in `config`:
 * `presetStandard({ treeGrid: { rowHeight: 28 } })` is the standard composition with that option
 * applied and everything else at its defaults.
 *
 * A fresh array of fresh plugin instances is returned on every call, so mutating it is safe.
 */
export function presetStandard(config?: PresetStandardConfig): AnyPlugin[] {
  return [
    dataStore(config?.dataStore),
    view(config?.view),
    treeGrid(config?.treeGrid),
    taskBars(config?.taskBars),
    interaction(config?.interaction),
    undoRedo(config?.undoRedo),
    a11y(config?.a11y),
    scheduling(config?.scheduling),
    exportPlugin(config?.export),
  ];
}
