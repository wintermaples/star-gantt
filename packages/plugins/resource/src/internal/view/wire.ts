// docs/specs/plugins/resource.md §3.4 — the resource view strip.
/**
 * Entry point of the resource-view area: the `stargantt.resource-view:panel` bottom-pane strip at
 * `order: -1`, its row/segment/team model, the `resourceView/toggled` emission, and the
 * `drag/lanes` provider whose flow inverts the naive upward seam (§4.2).
 *
 * Dormant while the `view` nest is omitted, and inert without `stargantt.view` — with no bottom
 * region to mount into, the contribution is simply never delivered, nothing paints, and the lane
 * seam answers `undefined` for every y while `reassign` keeps working off the row model.
 *
 * Wiring only: the row model (`model.ts`), the lane arithmetic (`lanes.ts`), the write-path
 * decision (`reassign.ts`) and the DOM (`panel.ts`) are all hostless modules beside this file.
 */
import type { Patch, ResourceId, Task, TaskId } from "@stargantt/plugin-data-store";
import type { LaneBox } from "@stargantt/plugin-interaction";
import {
  createFrameScheduler,
  createTransactionBatcher,
  latchedBuilderBarrier,
  parsePx,
} from "@stargantt/sdk";
import type { ResourceAreaDeps } from "../areas";
import { buildModel, buildUniverse, rowKeyOfTask } from "./model";
import type { RvGroup, RvResourceInput } from "./model";
import { createPanelView } from "./panel";
import type { PanelMetrics } from "./panel";
import { planReassign } from "./reassign";

/** The strip's contribution id (§4.2). */
const PANE_ID = "stargantt.resource-view:panel";
/**
 * `order: -1` — above the load chart's aggregate band (0) and lanes (1), so a reader sees chart,
 * resource view, total, lanes top to bottom and a lane drag travels the shortest distance.
 */
const PANE_ORDER = -1;
/** Provenance of the lane-drop transaction (§3.4); the batcher suffixes a per-call sequence. */
const REASSIGN_ORIGIN = "stargantt.resource/reassign";

const DEFAULT_ROW_HEIGHT = 28;
const DEFAULT_LABEL_WIDTH = 160;
const DEFAULT_STRIP_HEIGHT = 200;

/** Shared empty list, so a task with no assignments allocates nothing on the drag path. */
const NO_ASSIGNMENTS = [] as const;

/** Wires the resource-view area. */
export function wireView(deps: ResourceAreaDeps): void {
  // §6 presence semantics: no `view` nest, no strip, no `drag/lanes` provider, no event — this
  // composition renders exactly as if the resource-view area were absent.
  const config = deps.config.view;
  if (config === undefined) return;
  // Destructured right here so the presence narrowing above reaches the hoisted function
  // declarations below without every one of them re-testing the nest.
  const { resizable, startOpen, teams } = config;

  const { ctx, data, messages } = deps;
  // `deps.resourcePool()`, not `ctx.use("stargantt.resource-pool")`: this plugin provides that
  // service on ITSELF (`wirePool` runs before this area in `index.ts`'s single `setup()`), and
  // `ctx.use()` on a self-provided service makes `expectDepsConsistency`'s mock context (which does
  // not model the real core's `consumer === provider` self-use exemption) misreport it as an
  // undeclared hard dependency — `meta.dependsOn` must stay exactly `["stargantt.data-store"]`
  // (§9). `bindResourcePool`/`resourcePool` in `areas.ts` is the sanctioned cross-area path
  // instead. Unreachable `undefined` in the real host (§6: provided unconditionally, before this
  // area wires); this area does nothing useful without it, so it degrades like a missing nest.
  const poolOrUndefined = deps.resourcePool();
  if (poolOrUndefined === undefined) return;
  // Re-bound to a non-optional name: TS's control-flow narrowing of a `const` does not carry into
  // a function declared later in the same scope (several closures below read `pool`).
  const pool = poolOrUndefined;

  /* --- layout tokens: read once, at first need ---------------------------------------------- */

  /**
   * The three layout tokens, memoized on first read rather than latched at `setup()` (§9's timing
   * rule: a chart-surface edge is resolved at `lifecycle/ready` or per use). The first read happens
   * when the bottom region asks the contribution for its height, which is after every plugin's
   * `setup()` has run. Later token changes restyle colors through the CSS cascade; these three are
   * geometry and stay as first read.
   */
  let tokens: (PanelMetrics & { stripHeight: number }) | null = null;
  function metrics(): PanelMetrics & { stripHeight: number } {
    if (tokens === null) {
      const theme = ctx.useOptional("stargantt.theme");
      const rowHeight = parsePx(theme?.get("--sg-rv-row-height") ?? "", DEFAULT_ROW_HEIGHT);
      tokens = {
        rowHeight,
        // One row height, so the lane arithmetic below a team band stays exact.
        teamHeight: rowHeight,
        labelWidth: parsePx(theme?.get("--sg-rv-label-width") ?? "", DEFAULT_LABEL_WIDTH),
        stripHeight: parsePx(theme?.get("--sg-rv-height") ?? "", DEFAULT_STRIP_HEIGHT),
      };
    }
    return tokens;
  }

  /* --- the panel ----------------------------------------------------------------------------- */

  const panel = createPanelView({ root: ctx.root, metrics });
  ctx.own(panel);
  panel.describe(messages.panelLabel);

  /* --- the model, cached until the data or the pool moves ------------------------------------ */

  /**
   * `projectOf` runs once per assigned task per model rebuild, so it sits under the latched
   * barrier every function-shaped configuration member of this plugin does: the first throw is
   * reported once through `core/pluginError` and every later call answers the built-in fallback
   * without calling through, for the rest of the instance's life. The barrier is the SDK's own
   * builder barrier, with the empty string standing for "no attribution" on the way in and out —
   * an unusable (non-string, empty) answer is a fallback, not a fault.
   */
  const rawProjectOf = config.projectOf;
  const projectText = latchedBuilderBarrier<[Readonly<Task>]>(
    (task) => {
      const value = rawProjectOf(task);
      return typeof value === "string" && value !== "" ? value : "";
    },
    () => "",
    deps.reportError,
  );
  const projectOf = (task: Readonly<Task>): string | null => {
    const text = projectText(task);
    return text === "" ? null : text;
  };

  let cachedGroups: RvGroup[] | null = null;
  /**
   * The row universe by string id, cached alongside `cachedGroups` under the same invalidation: a
   * `reassign` call resolves two ids, and rebuilding the universe twice per call — a pool listing
   * plus a store scan each time — is pure waste.
   */
  let cachedUniverse: Map<string, RvResourceInput> | null = null;

  function universe(): Map<string, RvResourceInput> {
    if (cachedUniverse === null) {
      cachedUniverse = buildUniverse(pool.entries(), data.query().resources);
    }
    return cachedUniverse;
  }

  function groups(): RvGroup[] {
    if (cachedGroups === null) {
      const view = data.query();
      cachedGroups = buildModel({
        tasks: view.byId,
        assignmentsByTask: view.assignmentsByTask,
        resources: [...universe().values()],
        teams,
        ungroupedName: messages.ungroupedTeam,
        projectOf,
      });
    }
    return cachedGroups;
  }

  function invalidate(): void {
    cachedGroups = null;
    cachedUniverse = null;
    scheduler.schedule();
  }

  /* --- painting: at most one panel repaint per frame ----------------------------------------- */

  function paint(): void {
    if (!shown || !panel.isMounted()) return;
    // Both edges are the view plugin's and are resolved per use, never latched: a composition
    // without it never reaches here (no strip, no mount), and one with it answers both.
    const timeline = ctx.useOptional("stargantt.timeline");
    const surface = ctx.useOptional("stargantt.view");
    panel.render({
      groups: groups(),
      scrollLeft: surface?.viewport.get().scrollLeft ?? 0,
      tToX: timeline === undefined ? null : (t: number) => timeline.tToX(t),
      messages,
    });
  }

  const scheduler = createFrameScheduler(paint);
  ctx.own(scheduler);

  /* --- the strip (§3.4) ---------------------------------------------------------------------- */

  /**
   * Whether the strip currently shows. Visibility rides the height: the boot state is the
   * contribution's own, and every later change arrives as an applied height through `onResize`.
   * There is no `open()` / `close()` / `isOpen()` / `setHeight()` service surface (§5) — a host
   * shows and hides the strip with `view/setBottomPaneHeight` and reads the state back from
   * `resourceView/toggled`.
   *
   * No `createStripHeightTracker` / `createStripToggle` beside it, deliberately: those two carry
   * "restore the reader's last height, else re-derive the token" semantics, and the only member
   * that could reach them — a plugin-owned show/hide — does not exist here. §5 records that the
   * command path "always carries an explicit height", so the `--sg-rv-height` re-derivation is
   * reachable only through `startOpen`, which the contribution's own `height` getter already
   * answers. A tracker nothing reads back would be write-only state, so this boolean is the whole
   * of the plugin's height bookkeeping and the applied height stays the layout's business.
   */
  let shown = startOpen;

  ctx.contribute("view/bottomPanes", {
    id: PANE_ID,
    order: PANE_ORDER,
    // A getter: the contribution is registered at setup() but read once the bottom region mounts,
    // which is the first moment the theme token behind `stripHeight` can be read at all.
    get height(): number {
      return shown ? metrics().stripHeight : 0;
    },
    resizable,
    // A focusable separator is never unnamed; the catalog guarantees a non-blank string.
    label: messages.resizeLabel,
    onResize: (height) => {
      const next = height > 0;
      if (next !== shown) {
        // Hiding empties the strip and forgets its lane geometry BEFORE the state flips, so a
        // `laneAt` racing the hide can never read positions the strip no longer shows.
        if (!next) panel.clear();
        shown = next;
        ctx.emit("resourceView/toggled", { open: next, cause: "api" });
      }
      scheduler.schedule();
    },
    mount: (elements) => {
      panel.mount(elements);
      // The strip's own box drives both culls and the gutter/in-body name-column choice, and it
      // changes without any event this plugin subscribes to (a divider drag on a side pane, a
      // window resize, a view-mode switch), so it is observed directly.
      if (typeof globalThis.ResizeObserver === "function") {
        const observer = new globalThis.ResizeObserver(() => scheduler.schedule());
        observer.observe(elements.body);
        observer.observe(elements.gutter);
        ctx.own({ dispose: () => observer.disconnect() });
      }
      scheduler.schedule();
    },
  });

  /* --- the lane seam and its write path (§4.2) ----------------------------------------------- */

  // A lane drop is ONE user-visible commit, so it is one transaction and one undo step: the head
  // is an ordinary public command stamped with a per-call origin, and the remaining patches are
  // appended to that same transaction. Keyed on the origin, never on a re-entrancy flag.
  const batch = createTransactionBatcher<Patch>(ctx, REASSIGN_ORIGIN);

  function reassign(taskId: TaskId, fromResourceId: string, toResourceId: string): void {
    // Ids are matched in string form throughout: a pool id typed as the number `1` and a store id
    // the loader typed as `"1"` name the same resource.
    const rows = universe();
    const from = rows.get(String(fromResourceId))?.id;
    const to = rows.get(String(toResourceId))?.id;
    if (from === undefined || to === undefined) return;
    const view = data.query();
    const plan = planReassign({
      taskId,
      from,
      to,
      assignments: view.assignmentsByTask.get(taskId) ?? NO_ASSIGNMENTS,
      storeResources: view.resources,
      poolEntry: (id: ResourceId) => pool.get(id),
    });
    switch (plan.kind) {
      case "none":
        // Same, unknown or unassigned: silently nothing.
        return;
      case "mirror":
        batch(
          (origin) => ctx.dispatch("resource/add", { resource: plan.resource, origin }),
          plan.tail,
        );
        return;
      case "removeSource":
        ctx.dispatch("assignment/remove", {
          taskId: plan.taskId,
          resourceId: plan.resourceId,
          origin: REASSIGN_ORIGIN,
        });
        return;
      case "set":
        batch(
          (origin) =>
            ctx.dispatch("assignment/set", {
              taskId: plan.taskId,
              resourceId: plan.resourceId,
              units: plan.units,
              origin,
            }),
          plan.tail,
        );
        return;
      default: {
        const never: never = plan;
        return never;
      }
    }
  }

  // The inverted structural seam: interaction does not reach for a `stargantt.resource-view`
  // service, this plugin hands it the four closures. A `first`-reduce
  // point — with no contribution at all, `dragEdit.resourceDrag` stays inert, which is exactly
  // what an omitted `view` nest must look like from interaction's side.
  ctx.contribute("drag/lanes", {
    laneAt: (y: number): LaneBox | undefined => panel.laneAt(y),
    laneOfTask: (taskId: TaskId): LaneBox | undefined => {
      // The panel sits below the chart, so a dragged bar's own position names no lane: the source
      // of a reassignment is the lane the task already sits on, and a task on two lanes has no
      // single source to name.
      const key = rowKeyOfTask(groups(), taskId);
      return key === undefined ? undefined : panel.laneOf(key);
    },
    highlightLane: (resourceId: string | null): void => {
      panel.highlight(resourceId === null ? null : String(resourceId));
    },
    // Independent of the panel's visibility: the write path reads the row model, not the DOM, so a
    // drop resolved while the strip is released still lands.
    reassign,
  });

  /* --- repaint triggers ---------------------------------------------------------------------- */

  // Store-shaped, per §5: there are no `data/*Changed` events. Tasks move segments, resources move
  // rows and capacities, assignments move both.
  ctx.own(data.tasks.subscribe(invalidate));
  ctx.own(data.resources.subscribe(invalidate));
  ctx.own(data.assignments.subscribe(invalidate));
  // Pool entries feed the names and capacities of resources the store does not hold.
  ctx.own(pool.resources.subscribe(invalidate));

  // The strip follows HORIZONTAL scroll only; its rows scroll vertically on their own, and a
  // vertical chart scroll must not move them.
  //
  // `ctx.on()` already auto-owns its own subscription (`packages/core/src/internal/context.ts`);
  // the `ctx.own()` wrap on both calls below is stylistic consistency with the other `ctx.on` call
  // sites across this plugin's five areas, not a functional requirement.
  let lastScrollLeft: number | null = null;
  ctx.own(
    ctx.on("view/scrolled", (e) => {
      if (e.scrollLeft === lastScrollLeft) return;
      lastScrollLeft = e.scrollLeft;
      scheduler.schedule();
    }),
  );

  ctx.own(
    ctx.on("lifecycle/ready", () => {
      // Zoom changes `tToX` for every segment; the store's own value is unchanged, so nothing else
      // would schedule the repaint. Resolved here rather than at setup(), per §9's timing rule.
      const timeline = ctx.useOptional("stargantt.timeline");
      if (timeline !== undefined) ctx.own(timeline.zoomLevel.subscribe(() => scheduler.schedule()));
      scheduler.schedule();
    }),
  );
}
