// docs/specs/plugins/interaction.md §6.6 — the zoom toolbar in its claimed overlay corner
/**
 * Wiring entry point of the `zoom` feature.
 *
 * Two deliberate design choices, both normative from `interaction.md` §2.4:
 *
 * - There is no `ZoomControlsService`: nothing beyond the DOM toolbar is published. Zoom
 *   stepping goes through `stargantt.timeline` directly (this module's own anchored-ladder
 *   behaviour); the toolbar's fit / today / selection jumps are internal actions with no public
 *   counterpart.
 * - The corner slot is claimed through `ctx.claimSlot("overlay-corner", …)` (architecture.md §1.2)
 *   rather than an uncontested placement — first claimant wins, a later one gets an alternative
 *   slot proposal plus a warning-level `core/pluginError` the core reports on its own.
 */
import type {} from "@stargantt/plugin-view";
import type {} from "@stargantt/plugin-tree-grid";
import { MS_DAY } from "@stargantt/sdk";
import type { TaskId } from "@stargantt/plugin-data-store";
import type { PeripheralWiring } from "../peripheral";
import { createLadder, normalizeLevels } from "./ladder";
import { createToolbar } from "./toolbar";
import type { ToolbarPosition } from "./toolbar";

/** The resolved zoom-controls options (§6.6): every member present, every value usable. */
export interface ResolvedZoomConfig {
  levels: readonly string[];
  slider: boolean;
  zoomButtons: boolean;
  fitButton: boolean;
  todayButton: boolean;
  selectionButton: boolean;
  position: ToolbarPosition;
}

/** Anything but the literal `false` keeps the default `true` (§6 rule 3 convention). */
function validFlag(value: unknown): boolean {
  return value !== false;
}

function validPosition(value: unknown): ToolbarPosition {
  return value === "top-left" ||
    value === "top-right" ||
    value === "bottom-left" ||
    value === "bottom-right"
    ? value
    : "bottom-right";
}

/** Resolves the feature's own nest, exactly as `PeripheralWiring.config` hands it over. */
export function resolveZoomConfig(raw: Record<string, unknown>): ResolvedZoomConfig {
  return {
    levels: normalizeLevels(raw["levels"]),
    slider: validFlag(raw["slider"]),
    zoomButtons: validFlag(raw["zoomButtons"]),
    fitButton: validFlag(raw["fitButton"]),
    todayButton: validFlag(raw["todayButton"]),
    selectionButton: validFlag(raw["selectionButton"]),
    position: validPosition(raw["position"]),
  };
}

/** Wires the zoom feature into the composition. */
export function wireZoom(deps: PeripheralWiring): void {
  const { ctx, messages, selection } = deps;
  const config = resolveZoomConfig(deps.config);

  const view = ctx.use("stargantt.view");
  const timeline = ctx.use("stargantt.timeline");
  const rows = ctx.use("stargantt.rows");
  // `stargantt.data-store` is a hard dependency of the whole interaction plugin (always present),
  // so this is hoisted to wire time (review round 1 minor-5) rather than re-looked-up on every fit /
  // jump-to-selection click.
  const data = ctx.use("stargantt.data");
  const ladder = createLadder(config.levels, timeline);

  /** The instant currently at the viewport's horizontal center — the zoom anchor. */
  function centerTime(): number {
    const vp = view.viewport.get();
    return timeline.xToT(vp.scrollLeft + vp.width / 2);
  }

  // Steps to the densest ladder level at which every task fits the viewport width, then scrolls
  // so the whole project span is centered. No-op with no data store, no tasks, or no valid task
  // dates.
  function fitToProject(): void {
    let min = Number.POSITIVE_INFINITY;
    let max = Number.NEGATIVE_INFINITY;
    for (const id of data.taskIds()) {
      const task = data.getTask(id);
      if (task === undefined) continue;
      if (Number.isFinite(task.start) && task.start < min) min = task.start;
      if (Number.isFinite(task.end) && task.end > max) max = task.end;
    }
    const spanMs = max - min;
    if (!Number.isFinite(spanMs) || spanMs <= 0) return;
    const width = view.viewport.get().width;
    const entry = ladder.fitEntry(spanMs, width);
    if (entry === undefined) return;
    if (timeline.zoomLevel.get().id !== entry.id) {
      ladder.activateUnanchored(entry.id);
      // The activation is failure-tolerant; if it did not take (id absent from the composed list),
      // centering with the stale scale would scroll somewhere meaningless — bail.
      if (timeline.zoomLevel.get().id !== entry.id) return;
    }
    const spanPx = spanMs * timeline.pxPerMs;
    view.scrollTo({ scrollLeft: timeline.tToX(min) - (width - spanPx) / 2 });
  }

  // Scrolls to the start of the current UTC day at the viewport's horizontal center; the zoom
  // level and the vertical scroll position are untouched.
  function jumpToToday(): void {
    const todayStart = Math.floor(Date.now() / MS_DAY) * MS_DAY;
    const width = view.viewport.get().width;
    view.scrollTo({ scrollLeft: timeline.tToX(todayStart) - width / 2 });
  }

  // Centers on the first selected task (by row order when one resolves), both ways. No-op with
  // nothing selected.
  function jumpToSelection(): void {
    const selected = selection.state.get().taskIds;
    if (selected.size === 0) return;

    let targetId: TaskId | undefined;
    let targetRow: number | undefined;
    for (const id of selected) {
      const row = rows.rowOf(id);
      if (row === undefined) {
        if (targetId === undefined) targetId = id;
        continue;
      }
      if (targetRow === undefined || row < targetRow) {
        targetRow = row;
        targetId = id;
      }
    }
    if (targetId === undefined) return;

    const vp = view.viewport.get();
    const target: { scrollLeft?: number; scrollTop?: number } = {};
    const task = data.getTask(targetId);
    if (task !== undefined && Number.isFinite(task.start) && Number.isFinite(task.end)) {
      target.scrollLeft = timeline.tToX((task.start + task.end) / 2) - vp.width / 2;
    }
    if (targetRow !== undefined) {
      target.scrollTop = rows.yOf(targetRow) + rows.rowHeight(targetRow) / 2 - vp.height / 2;
    }
    if (target.scrollLeft !== undefined || target.scrollTop !== undefined) view.scrollTo(target);
  }

  /* --- the toolbar --- */

  // docs/specs/plugins/interaction.md §3 corner-slot arbitration note — first claimant wins; a
  // later one gets the lexicographically smallest free known slot as `alternative` plus a
  // warning-level `core/pluginError` the core reports on its own (nothing further to do here).
  const grant = ctx.claimSlot("overlay-corner", config.position, [
    "top-left",
    "top-right",
    "bottom-left",
    "bottom-right",
  ]);
  const position: ToolbarPosition = grant.granted
    ? config.position
    : ((grant.alternative as ToolbarPosition | undefined) ?? config.position);

  const pane = view.chartPaneElement();
  const doc = pane.ownerDocument;
  const toolbar = createToolbar({
    doc,
    messages,
    position,
    slider: config.slider,
    zoomButtons: config.zoomButtons,
    fitButton: config.fitButton,
    todayButton: config.todayButton,
    selectionButton: config.selectionButton,
    sliderSteps: config.levels.length,
    onZoomIn: () => ladder.step(1, centerTime()),
    onZoomOut: () => ladder.step(-1, centerTime()),
    onSlider: (index) => {
      ladder.setIndex(index, centerTime());
      // An index the composition doesn't carry an active level for (e.g. an id not composed) leaves
      // `setIndex` a no-op, but the slider thumb has already visually moved to `index` via its own
      // `input` event — re-sync it to the timeline's actual active level.
      syncFromScale();
    },
    onFit: fitToProject,
    onToday: jumpToToday,
    onSelection: jumpToSelection,
  });

  function syncFromScale(): void {
    toolbar.syncIndex(config.levels.indexOf(timeline.zoomLevel.get().id));
  }

  const element = toolbar.element;
  if (element !== null) {
    pane.appendChild(element);
    ctx.own({ dispose: () => element.remove() });
  }

  /* --- state sync --- */
  syncFromScale();
  ctx.own(timeline.zoomLevel.subscribe(syncFromScale));
  toolbar.setSelectionEnabled(selection.state.get().taskIds.size > 0);
  ctx.own(selection.state.subscribe((s) => toolbar.setSelectionEnabled(s.taskIds.size > 0)));
}
