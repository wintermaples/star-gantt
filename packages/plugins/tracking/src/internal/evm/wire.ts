// docs/specs/plugins/tracking.md §1.4 / §2.14 / §2.15 / §2.16 — entry point of the EVM area,
// following this codebase's `wire.ts` convention: the session `EvmState` store, the computation engine over the
// §2.14 fan-in, the KPI formulas, the two panels with their §2.13 LATCHED body seam, and the
// assembled `EvmService`.
//
// §5 presence semantics: the SERVICE is built unconditionally — `config.evm === undefined` simply
// means every §5.4 default applies. Only the two PANELS are nest-gated (and additionally gated on
// `stargantt.view` resolving, §2.16).
import { createStore } from "@stargantt/core";
import { latchedSeam } from "@stargantt/sdk";
import type { TaskId } from "@stargantt/plugin-data-store";
// Type-only: brings the sibling packages' `declare module "@stargantt/core"` augmentations into
// this program so `useOptional("stargantt.view")` / `dispatch("task/update")` are checked against
// the real declarations. Erased at emit — no runtime dependency is added.
import type { ThemeService, ViewService } from "@stargantt/plugin-view";
import type {
  BaselineTaskSnapshot,
  EvmCurvePoint,
  EvmIndices,
  EvmFormulaInput,
  EvmKpiTile,
  EvmPanelModel,
  EvmPanelRenderContext,
  EvmService,
  EvmSnapshot,
  EvmState,
  EvmTaskMetrics,
  TaskCost,
} from "../../types";
import type { TrackingAreaDeps } from "../areas";
import { formatAmount } from "../shared/format";
import { normalizeSeededSeriesDedupeByDay, recordOrReplaceByDay } from "../shared/snapshot-series";
import { startOfUtcDay } from "../shared/status-date";
import { createEvmEngine, earnedOf, taskMetrics } from "./engine";
import { formulaTiles, normalizeFormulas } from "./formulas";
import type { EvmPanel } from "./panels";
import {
  createCurvePanel,
  createDashboardPanel,
  dashboardTiles,
  hasDashboardData,
} from "./panels";
import { scurvePoints } from "./scurve";
import type { CurveTask } from "./scurve";
import { createSetFields, evmValuesOf, usableAmount } from "./values";

/**
 * Direct calls into the other three areas — plain function references the root wires in, never a
 * `*Service` type import (keeps this area decoupled from the other three at the type level, per
 * §2.14's recorded resolution).
 */
export interface EvmAreaExtras {
  /**
   * The cost area's `costOf` — the BAC/AC fallback (§2.14). Always present: the cost area's service
   * is built unconditionally regardless of nest presence, per §5's presence semantics.
   */
  costOf(id: TaskId): Readonly<TaskCost> | undefined;
  /**
   * The baselines area's active-baseline snapshot lookup — the planned-dates fallback (§2.14).
   * Always present, same reasoning. Called with just the task id: it defaults to the ACTIVE
   * baseline (mirroring the baselines area's own `snapshotOf(taskId, baselineId?)` signature), so
   * an `undefined` return already means "no usable planned-date override" — there is no separate
   * "is a baseline active" question for this area to ask.
   */
  baselineSnapshotOf(id: TaskId): Readonly<BaselineTaskSnapshot> | undefined;
}

/** Whether a raw snapshot init carries usable EV/AC figures (§5.4: "unusable dropped"). */
function usableSnapshot(raw: EvmSnapshot): boolean {
  if (typeof raw !== "object" || raw === null) return false;
  return usableAmount(raw.ev) && usableAmount(raw.ac);
}

/**
 * Wires the EVM area and returns its service. `extras` is the §2.14 fan-in the plugin root fills in
 * with the other three areas' already-built functions.
 */
export function wireEvm(deps: TrackingAreaDeps, extras: EvmAreaExtras): EvmService {
  const { ctx, config, messages } = deps;
  const evmConfig = config.evm;

  /* --- §1.4 session state ------------------------------------------------ */

  // §5.4's `snapshots` seed uses the DEDUPE variant: "last entry per UTC day kept, unusable
  // dropped". The seed is the store's INITIAL value: state a subscriber reads on its first
  // `get()`, so there is no extra `set()` to make here.
  const seededSnapshots = normalizeSeededSeriesDedupeByDay<EvmSnapshot>(
    evmConfig?.snapshots,
    (s) => s.t,
    usableSnapshot,
    (s, day) => ({ t: day, ev: s.ev, ac: s.ac }),
  );
  const rawBac: unknown = evmConfig?.projectBac;
  const seededBac = usableAmount(rawBac) ? rawBac : undefined;
  const state = createStore<EvmState>({
    projectBacOverride: seededBac,
    snapshots: seededSnapshots,
  });

  /* --- §2.14 / §2.15 the engine ------------------------------------------ */

  const engine = createEvmEngine(deps, extras, () => state.get().projectBacOverride);
  const formulas = normalizeFormulas(evmConfig?.formulas);
  const setFields = createSetFields(deps);

  /** The S-curve, optionally reusing indices the caller already computed (§2.15). */
  function scurve(indices?: Readonly<EvmIndices>): EvmCurvePoint[] {
    const at = engine.statusDate();
    const tasks: CurveTask[] = engine.allTasks().map((task) => {
      const planned = engine.plannedDatesOf(task);
      return {
        plannedStart: planned.start,
        plannedEnd: planned.end,
        bac: engine.bacOfTask(task),
      };
    });
    const current = indices ?? engine.projectMetrics();
    return scurvePoints(tasks, state.get().snapshots, at, current.ev, current.ac);
  }

  /* --- §2.13 the LATCHED renderPanel seam -------------------------------- */

  // One latch across BOTH panels (§2.13: "evm's [latch spans] its two"): the first throw reports
  // once and the seam is never called again for the instance's life, dashboard or curve.
  const seam = evmConfig?.renderPanel;
  const runSeam =
    seam === undefined
      ? undefined
      : latchedSeam<EvmPanelRenderContext>(seam, (error) => deps.reportError("renderPanel", error));

  function renderBody(body: HTMLElement, model: EvmPanelModel): boolean {
    if (runSeam === undefined) return false;
    return runSeam(body, { panel: model.panel, model, close: () => closePanels() });
  }

  /* --- §2.16 the two panels ---------------------------------------------- */

  let panel: EvmPanel | undefined;
  // Owned once at setup: disposal removes whichever panel is current. The panel is a `createDialog`
  // that owns its own chrome listeners and drains them in `dispose()`, so this area never
  // re-registers a per-open bag through `ctx.own()`.
  ctx.own({ dispose: () => closePanels() });

  function closePanels(): void {
    panel?.dispose();
    panel = undefined;
  }

  /**
   * The dialog host, or `undefined` when a panel must not open: the `evm` nest is dormant (§5), or
   * `stargantt.view` does not resolve (§2.16). Resolved per use, never latched at setup (§8).
   */
  function panelHost(): HTMLElement | undefined {
    if (evmConfig === undefined) return undefined;
    const view: ViewService | undefined = ctx.useOptional("stargantt.view");
    return view === undefined ? undefined : ctx.root;
  }

  // §8: theme is optional and resolved per use, so a composition activating it after this plugin
  // still gets its tokens; the panels fall back to the §2.15 default colors when it is absent.
  const themeGet = (token: string): string => {
    const theme: ThemeService | undefined = ctx.useOptional("stargantt.theme");
    return theme?.get(token) ?? "";
  };

  /**
   * The dashboard's tiles: the ten built-in ones (absent entirely when there is no figure worth a
   * dashboard — the panel then shows its empty state), then one per custom formula (§2.15).
   */
  function dashboardModel(): EvmKpiTile[] {
    const metrics = engine.projectMetrics();
    const tiles = hasDashboardData(metrics) ? dashboardTiles(metrics, messages) : [];
    if (formulas.length === 0) return tiles;
    // The already-computed project indices are threaded into the curve rather than recomputed.
    const input: EvmFormulaInput = {
      indices: metrics,
      curve: scurve(metrics),
      statusDate: engine.statusDate(),
    };
    return [...tiles, ...formulaTiles(formulas, input, formatAmount, deps.reportError)];
  }

  function openDashboardPanel(): boolean {
    const host = panelHost();
    if (host === undefined) return false;
    closePanels();
    panel = createDashboardPanel(host, dashboardModel(), messages, {
      close: closePanels,
      themeGet,
      renderBody,
    });
    panel.focus();
    return true;
  }

  function openCurvePanel(): boolean {
    const host = panelHost();
    if (host === undefined) return false;
    closePanels();
    panel = createCurvePanel(host, scurve(), messages, {
      close: closePanels,
      themeGet,
      renderBody,
      pointText: (point) => messages.evmCurvePoint(point),
    });
    panel.focus();
    return true;
  }

  /* --- §1.4 the service -------------------------------------------------- */

  const service: EvmService = {
    state,
    valuesOf: (id) => evmValuesOf(deps.data.getTask(id)),
    setFields,
    bacOf(id) {
      const task = deps.data.getTask(id);
      return task === undefined ? 0 : engine.bacOfTask(task);
    },
    projectBac: engine.projectBac,
    setProjectBac(amount) {
      const current = state.get().projectBacOverride;
      const next = amount === undefined ? undefined : usableAmount(amount) ? amount : current;
      if (next === current) return;
      state.set({ ...state.get(), projectBacOverride: next });
    },
    method: () => engine.defaultMethod,
    methodOf(id) {
      return evmValuesOf(deps.data.getTask(id)).method ?? engine.defaultMethod;
    },
    earnedOf(id) {
      const task = deps.data.getTask(id);
      if (task === undefined) return 0;
      return earnedOf(engine.inputOf(task, engine.statusDate()));
    },
    statusDate: engine.statusDate,
    metricsOf(id): EvmTaskMetrics | undefined {
      const task = deps.data.getTask(id);
      if (task === undefined) return undefined;
      const at = engine.statusDate();
      return taskMetrics(engine.inputOf(task, at), at, engine.eacMethod, engine.runEac);
    },
    metrics: engine.allMetrics,
    projectMetrics: engine.projectMetrics,
    scurve: () => scurve(),
    recordSnapshot(): EvmSnapshot {
      // The figures are always the CURRENT project EV/AC (the engine keeps no history), always
      // stamped onto the status date's UTC day — no `date` parameter to backdate through (§1.4).
      const current = engine.projectMetrics();
      const snapshot: EvmSnapshot = {
        t: startOfUtcDay(engine.statusDate()),
        ev: current.ev,
        ac: current.ac,
      };
      const snapshots = state.get().snapshots;
      const prev = snapshots.find((s) => s.t === snapshot.t);
      // A same-day re-record with identical figures changes nothing observable — no store set.
      if (prev === undefined || prev.ev !== snapshot.ev || prev.ac !== snapshot.ac) {
        state.set({
          ...state.get(),
          snapshots: recordOrReplaceByDay(snapshots, snapshot, (s) => s.t),
        });
      }
      return snapshot;
    },
    openDashboardPanel,
    openCurvePanel,
    closePanels,
  };

  return service;
}
