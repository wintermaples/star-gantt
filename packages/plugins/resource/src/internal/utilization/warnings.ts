// docs/specs/plugins/resource.md §3.5 — the overload warning glyph + the shared warned-task index.
/**
 * The cached warned-task index this area's `state` recompute derives (§1.2): per task, the names
 * of the resources assigned to it that carry an over-allocated bucket overlapping the task's own
 * span. Consumed by both the `taskbars/overlays` glyph here and the `resource.overallocation` grid
 * column (`./column.ts`), so the two surfaces can never disagree and neither runs a second
 * aggregation per bar / per cell — both read this one cached set.
 */
import type { Store } from "@stargantt/core";
import type { TaskId } from "@stargantt/plugin-data-store";
import type { BarBox, BarOverlayRenderer } from "@stargantt/plugin-task-bars";
// Type-only import: loads `@stargantt/plugin-view`'s `declare module "@stargantt/core"`
// augmentation (`stargantt.theme`) so `ctx.useOptional("stargantt.theme")` checks against the real
// declaration below. Erased at emit.
import type { ThemeService } from "@stargantt/plugin-view";
import { overlaps } from "../engine/rollups";
import type { ResourceAreaDeps } from "../areas";
import type { UtilizationState } from "./service";

/** Reads the names of the over-allocated resources assigned to a task; `[]` when it is clean. */
export interface WarningIndex {
  overResourceNamesFor(taskId: TaskId): readonly string[];
  /** Whether at least one assigned resource is over — the glyph's own gate, cheaper than a name read. */
  isWarned(taskId: TaskId): boolean;
}

const EMPTY: readonly string[] = [];

function buildIndex(deps: ResourceAreaDeps, snapshot: UtilizationState): ReadonlyMap<TaskId, readonly string[]> {
  const overByResource = new Map<string, { name: string; buckets: { start: number; end: number }[] }>();
  for (const row of snapshot.rows) {
    const over = row.buckets.filter((b) => b.overallocated);
    if (over.length > 0) overByResource.set(String(row.resourceId), { name: row.name, buckets: over });
  }
  const out = new Map<TaskId, string[]>();
  if (overByResource.size === 0) return out;
  const view = deps.data.query();
  for (const [taskId, assignments] of view.assignmentsByTask) {
    const task = view.byId.get(taskId);
    if (task === undefined) continue;
    // §3.5 — names in RESOURCE (roster) order, not assignment order: collect WHICH resources warn
    // for this task first, then walk `overByResource` (whose insertion order mirrors
    // `snapshot.rows`, i.e. the union roster's own order, §2.3) rather than the task's own
    // assignment order. The `Set` below is unreachable in practice: a task can carry at most one
    // assignment per resource (the data store's own `assignmentsByTask` invariant), so no id here
    // is ever added twice.
    const warnedKeys = new Set<string>();
    for (const a of assignments) {
      const key = String(a.resourceId);
      const over = overByResource.get(key);
      if (over !== undefined && overlaps(over.buckets, task.start, task.end)) warnedKeys.add(key);
    }
    if (warnedKeys.size === 0) continue;
    const names: string[] = [];
    for (const [key, over] of overByResource) {
      if (warnedKeys.has(key)) names.push(over.name);
    }
    out.set(taskId, names);
  }
  return out;
}

/** Builds the shared warned-task index, kept in sync with `state`'s own recomputes. */
export function createWarningIndex(deps: ResourceAreaDeps, state: Store<UtilizationState>): WarningIndex {
  let index: ReadonlyMap<TaskId, readonly string[]> = buildIndex(deps, state.get());
  deps.ctx.own(
    state.subscribe((next) => {
      index = buildIndex(deps, next);
    }),
  );
  return {
    overResourceNamesFor: (taskId) => index.get(taskId) ?? EMPTY,
    isWarned: (taskId) => (index.get(taskId)?.length ?? 0) > 0,
  };
}

const WARNING_COLOR_FALLBACK = "#c62828";
/** Triangle side length, CSS px (§3.5, "≈11 px"). */
const TRIANGLE_SIZE = 11;
/** Distance from `bar.x + bar.width + bar.gutterEnd` to the glyph's own left edge (§3.5). */
const GLYPH_GAP = 8;
/** Bars shorter than this never carry the glyph (§3.5). */
const MIN_BAR_HEIGHT = 12;

/**
 * §3.5 — the triangle is centered `GLYPH_GAP` (8px) right of the bar's resolved end gutter — the
 * glyph's OWN half-width is not added on top of that gap (a prior draft did, shifting the glyph by
 * another `TRIANGLE_SIZE / 2` and drifting the "!" glyph's baseline off `cy + 2`).
 */
/** Exported for direct geometry testing (M2 review item) — the exact formula matters. */
export function paintWarningTriangle(g: CanvasRenderingContext2D, bar: Readonly<BarBox>, color: string): void {
  const cx = bar.x + bar.width + bar.gutterEnd + GLYPH_GAP;
  const cy = bar.y + bar.height / 2;
  const half = TRIANGLE_SIZE / 2;
  g.beginPath();
  g.moveTo(cx, cy - half);
  g.lineTo(cx + half, cy + half);
  g.lineTo(cx - half, cy + half);
  g.closePath();
  g.fillStyle = color;
  g.fill();
  g.fillStyle = "#ffffff";
  g.font = "bold 8px system-ui, sans-serif";
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.fillText("!", cx, cy + 2);
}

/** Wires the `taskbars/overlays` warning-triangle contribution (§3.5); a no-op while `warnings` is off. */
export function wireWarningGlyph(deps: ResourceAreaDeps, index: WarningIndex): void {
  if (deps.config.utilization?.warnings !== true) return;
  const renderer: BarOverlayRenderer = (g, bar) => {
    if (bar.height < MIN_BAR_HEIGHT) return;
    if (!index.isWarned(bar.id)) return;
    const theme: ThemeService | undefined = deps.ctx.useOptional("stargantt.theme");
    const color = theme?.get("--sg-ru-warning") || WARNING_COLOR_FALLBACK;
    paintWarningTriangle(g, bar, color);
  };
  deps.ctx.contribute("taskbars/overlays", renderer);
}
