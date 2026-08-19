/**
 * Hostless doubles for the reader interfaces `src/internal/deps.ts` declares.
 *
 * The internal modules take the services they read as plain shapes, so the units below can be
 * exercised with object literals — no `Gantt.create()`, no plugins, no DOM.
 */
import type { Task, TaskId } from "@stargantt/plugin-data-store";
import type {
  RowHeightReader,
  RowReader,
  TaskStoreReader,
  ThemeReader,
  TimeMapper,
} from "../src/internal/deps";

/** A task with the fields the geometry rule reads, defaults filled in. */
export function task(over: Partial<Task> & { id: TaskId }): Task {
  return {
    parentId: null,
    name: String(over.id),
    start: 0,
    end: 1000,
    ...over,
  };
}

/** A store double over an ordered list of tasks. */
export function store(tasks: readonly Task[]): TaskStoreReader {
  const byId = new Map<TaskId, Task>(tasks.map((t) => [t.id, t]));
  return {
    getTask: (id) => byId.get(id),
    taskIds: () => tasks.map((t) => t.id),
  };
}

export interface FakeRowsOptions {
  /** Row order, top to bottom. An entry of `undefined` models a row carrying no task. */
  order: readonly (TaskId | undefined)[];
  /** Uniform row height; 20 unless given. */
  rowHeight?: number;
  /**
   * Ids the row model hides (a collapsed ancestor), so `rowOf` answers `undefined` for them even
   * though the store knows them.
   */
  hidden?: readonly TaskId[];
  /**
   * Ids a `rows/height` contribution reduced to height 0 — the shape a filtered-out row has. They
   * resolve to height 0 whether or not they hold a visible row, which is the case the hidden-row
   * rules are about.
   */
  zeroHeight?: readonly TaskId[];
}

/**
 * A row-model double with uniform row heights, mirroring `RowsService`'s clamping `rowAtY`.
 *
 * `resolvedHeightOf` answers for every id the options name — in `order`, in `hidden` or in
 * `zeroHeight` — and `undefined` for anything else, the real service's "the store does not know
 * this task" answer.
 */
export function rowsOf(options: FakeRowsOptions): RowReader & RowHeightReader {
  const height = options.rowHeight ?? 20;
  const order = options.order;
  const hidden = new Set(options.hidden ?? []);
  const zero = new Set(options.zeroHeight ?? []);
  const heightAt = (row: number): number => {
    const id = order[row];
    return id !== undefined && zero.has(id) ? 0 : height;
  };
  const topOf = (row: number): number => {
    let y = 0;
    for (let i = 0; i < row; i += 1) y += heightAt(i);
    return y;
  };
  return {
    rowCount: () => order.length,
    taskIdAt: (row) => order[row],
    rowOf: (id) => {
      if (hidden.has(id)) return undefined;
      const at = order.indexOf(id);
      return at < 0 ? undefined : at;
    },
    rowHeight: heightAt,
    resolvedHeightOf: (id) => {
      if (zero.has(id)) return 0;
      if (hidden.has(id) || order.includes(id)) return height;
      return undefined;
    },
    yOf: topOf,
    // `RowsService.rowAtY` clamps into the existing row range, which several units depend on.
    rowAtY: (y) => {
      if (order.length === 0) return 0;
      if (zero.size === 0) {
        const raw = Math.floor(y / height);
        return raw < 0 ? 0 : raw > order.length - 1 ? order.length - 1 : raw;
      }
      // With zero-height rows in play the division no longer holds, so walk. The real service
      // answers the first row whose band contains `y`, which for a run of zero-height rows is the
      // first row after them — they contain no point at all.
      if (y < 0) return 0;
      for (let row = 0; row < order.length; row += 1) {
        const h = heightAt(row);
        if (h > 0 && y < topOf(row) + h) return row;
      }
      return order.length - 1;
    },
  };
}

/** A time scale of `pxPerMs` pixels per millisecond, origin at 0. */
export function scaleOf(pxPerMs = 0.001): TimeMapper {
  return { tToX: (t) => t * pxPerMs };
}

/** A theme double over a token table; unknown tokens resolve to `""`, as the real service does. */
export function themeOf(tokens: Record<string, string> = {}): ThemeReader {
  return { get: (token) => tokens[token] ?? "" };
}
