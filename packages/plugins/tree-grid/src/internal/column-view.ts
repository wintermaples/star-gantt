/**
 * The configured view over the composed `grid/columns` reduction: hidden columns removed, a
 * declared display order applied, and per-column cell-renderer overrides wrapped in. Pure logic
 * with memoization on the input array's identity, so the column track's "new array identity =
 * the columns changed" signal stays meaningful.
 */
// docs/specs/plugins/tree-grid.md § Config — `columnLayout` / `cellRenderers`.
import type { Task } from "@stargantt/plugin-data-store";
import type { ColumnDef } from "../types";

/**
 * Which columns the grid displays and in what order, applied over the composed `grid/columns`
 * reduction without changing what any plugin contributed.
 */
export interface ColumnLayoutConfig {
  /**
   * Ids of columns not to display. A listed id that matches no composed column is ignored. The
   * hidden columns stay in the `grid/columns` reduction — other consumers still see them.
   */
  hidden?: string[];
  /**
   * Display order by column id: the listed columns come first, in this order; composed columns
   * not listed follow in their contribution order. Ids matching no composed column are ignored.
   */
  order?: string[];
}

/** Replaces how one column paints its cells; the cell element is cleared before each call. */
export type CellRenderer = (el: HTMLElement, task: Readonly<Task>) => void;

/** Keeps only the string entries of a configured array; anything else is silently ignored. */
function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

function usableRenderers(value: unknown): Map<string, CellRenderer> {
  const out = new Map<string, CellRenderer>();
  if (value === null || typeof value !== "object") return out;
  for (const [id, fn] of Object.entries(value)) {
    if (typeof fn === "function") out.set(id, fn as CellRenderer);
  }
  return out;
}

export interface ColumnViewOptions {
  /** Reads the composed `grid/columns` reduction. */
  read(): ColumnDef[];
  layout?: ColumnLayoutConfig | undefined;
  renderers?: Record<string, CellRenderer> | undefined;
  /** Reports a fault raised by a configured cell renderer. */
  fault(error: unknown): void;
}

/**
 * Builds the column-reading closure the pane consumes. With neither a usable layout nor a usable
 * renderer override configured it returns `read` itself — zero overhead, byte-identical default
 * behavior. Otherwise the derived array is memoized on the input array's identity, so the pane's
 * change detection ("same identity = unchanged") keeps working.
 *
 * A configured cell renderer that throws is reported once and then retired for the life of the
 * instance (a latched barrier: cells repaint at scroll frequency); its column falls back to the
 * contributed `render`.
 */
export function createColumnView(options: ColumnViewOptions): () => ColumnDef[] {
  const layout = options.layout;
  const hidden = new Set(stringList(layout?.hidden));
  const order = stringList(layout?.order);
  const renderers = usableRenderers(options.renderers);
  if (hidden.size === 0 && order.length === 0 && renderers.size === 0) return options.read;

  /** Renderer ids retired after a throw (latched, per column id). */
  const faulted = new Set<string>();
  let lastInput: ColumnDef[] | null = null;
  let lastOutput: ColumnDef[] = [];

  function wrap(column: ColumnDef): ColumnDef {
    const custom = renderers.get(column.id);
    if (custom === undefined) return column;
    return {
      ...column,
      render(el, task): void {
        if (!faulted.has(column.id)) {
          try {
            custom(el, task);
            return;
          } catch (error) {
            faulted.add(column.id);
            options.fault(error);
          }
        }
        column.render(el, task);
      },
    };
  }

  return () => {
    const input = options.read();
    if (input === lastInput) return lastOutput;
    lastInput = input;
    const visible = input.filter((c) => !hidden.has(c.id));
    const ordered: ColumnDef[] = [];
    for (const id of order) {
      const found = visible.find((c) => c.id === id);
      if (found !== undefined && !ordered.includes(found)) ordered.push(found);
    }
    for (const column of visible) if (!ordered.includes(column)) ordered.push(column);
    lastOutput = ordered.map(wrap);
    return lastOutput;
  };
}

/**
 * Resolves `TreeGridConfig.collation` to a string comparator, or `undefined` when the option is
 * absent or unusable. `true` means the environment's default locale; an object may name locales
 * and `Intl.Collator` options. A locale the environment rejects is silently ignored (the option
 * behaves as absent), per the config convention.
 */
export function resolveCollation(
  value: unknown,
): ((a: string, b: string) => number) | undefined {
  if (value !== true && (value === null || typeof value !== "object")) return undefined;
  const cfg = value === true ? {} : (value as { locales?: unknown; options?: unknown });
  const locales =
    typeof cfg.locales === "string" || Array.isArray(cfg.locales)
      ? (cfg.locales as string | string[])
      : undefined;
  const opts =
    cfg.options !== null && typeof cfg.options === "object"
      ? (cfg.options as Intl.CollatorOptions)
      : undefined;
  try {
    const collator = new Intl.Collator(locales, opts);
    return (a, b) => collator.compare(a, b);
  } catch {
    return undefined;
  }
}
