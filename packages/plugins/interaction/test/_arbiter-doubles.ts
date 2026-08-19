/**
 * Recording doubles for the gesture arbiter's five feature interfaces.
 *
 * Every call appends one line to a shared log, so a test asserts what the machine *dispatched* —
 * "selection.barPress(3)", "drag.cancel" — rather than counting mock invocations. The two decisions
 * a feature makes for the machine (which axis a press-move became, whether the menu is composed)
 * are programmable fields, so one harness drives every branch of the table.
 */
import { createArbiter } from "../src/internal/gesture/arbiter";
import type { Arbiter, ArbiterState, DragAxis } from "../src/internal/gesture/arbiter";

export interface ArbiterHarness {
  readonly arbiter: Arbiter;
  /** Every dispatch the machine made, in order. */
  readonly log: string[];
  /** What the drag module reports a press-move became. Default `"none"`. */
  axis: DragAxis;
  /** What the drag module reports a grid press-move became. Default `"none"`. */
  gridAxis: "none" | "row";
  /** The selection mode the machine reads. Default `"single"`. */
  mode: "single" | "multi" | "none";
  /** Whether the context-menu feature is composed. Default `false`. */
  menuEnabled: boolean;
  /** Whether the context-menu module's `openAt*` calls report a successful open. Default `true`. */
  menuOpens: boolean;
  /** The raw id `editDialog.press` was last called with, alongside its `target` detector key. */
  lastEditDialogId?: unknown;
  /** Whether a rubber band was in flight when `rubberBandCancel` was last called. */
  bandInFlight: boolean;
  /** Clears the log, so a test asserts only what one input did. */
  clear(): void;
  /** The machine's current state. */
  state(): ArbiterState;
}

export function harness(): ArbiterHarness {
  const log: string[] = [];
  // The bare name; the calls whose *arguments* are part of the assertion get their own closure
  // below, so the log stays readable instead of stringifying whole event payloads.
  const record =
    (name: string) =>
    (): void => {
      log.push(name);
    };

  const h: ArbiterHarness = {
    arbiter: undefined as unknown as Arbiter,
    log,
    axis: "none",
    gridAxis: "none",
    mode: "single",
    menuEnabled: false,
    menuOpens: true,
    bandInFlight: false,
    clear: () => {
      log.length = 0;
    },
    state: () => h.arbiter.state(),
  };

  const arbiter = createArbiter({
    selection: {
      mode: () => h.mode,
      barPress: (press) => log.push(`selection.barPress(${String(press.id)})`),
      gridPress: (press) => log.push(`selection.gridPress(${String(press.id)})`),
      pointerMove: record("selection.pointerMove"),
      pointerUp: record("selection.pointerUp"),
      clearPending: record("selection.clearPending"),
      rubberBandBegin: (x, y) => log.push(`selection.rubberBandBegin(${x},${y})`),
      rubberBandMove: (x, y) => log.push(`selection.rubberBandMove(${x},${y})`),
      rubberBandEnd: (x, y, release) =>
        log.push(`selection.rubberBandEnd(${x},${y},${release.cancelled ? "cancelled" : "release"})`),
      rubberBandCancel: () => {
        log.push("selection.rubberBandCancel");
        return h.bandInFlight;
      },
    },
    drag: {
      press: (e) => log.push(`drag.press(${String(e.hit.id)})`),
      pressMove: () => {
        log.push("drag.pressMove");
        return h.axis;
      },
      dragMove: record("drag.dragMove"),
      up: record("drag.up"),
      background: record("drag.background"),
      gridPress: (e) => log.push(`drag.gridPress(${String(e.id)})`),
      gridPressMove: () => {
        log.push("drag.gridPressMove");
        return h.gridAxis;
      },
      gridDragMove: record("drag.gridDragMove"),
      gridUp: record("drag.gridUp"),
      cancel: record("drag.cancel"),
      clearPress: record("drag.clearPress"),
    },
    tooltip: {
      hover: record("tooltip.hover"),
      press: record("tooltip.press"),
      suppress: record("tooltip.suppress"),
      dismiss: record("tooltip.dismiss"),
    },
    contextMenu: {
      enabled: () => h.menuEnabled,
      openAtHit: (e) => {
        log.push(`menu.openAtHit(${String(e.hit.id)})`);
        return h.menuOpens;
      },
      openAtBackground: () => {
        log.push("menu.openAtBackground");
        return h.menuOpens;
      },
      openAtRow: (e) => {
        log.push(`menu.openAtRow(${String(e.id)})`);
        return h.menuOpens;
      },
      openAtGridBackground: () => {
        log.push("menu.openAtGridBackground");
        return h.menuOpens;
      },
      close: record("menu.close"),
    },
    editDialog: {
      press: (target, id, counts) => {
        log.push(`dialog.press(${target},${counts ? "counts" : "filtered"})`);
        // Recorded separately from `log` (which stays a plain string trail) so a test can assert
        // the *type* of the raw id the arbiter passed alongside `target` — major M1: `target` is
        // only ever a detector key, never something to parse an id back out of.
        h.lastEditDialogId = id;
      },
      reset: record("dialog.reset"),
    },
  });

  (h as { arbiter: Arbiter }).arbiter = arbiter;
  return h;
}
