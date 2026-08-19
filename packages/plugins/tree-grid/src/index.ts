/**
 * `@stargantt/plugin-tree-grid` — plugin id `stargantt.tree-grid`.
 *
 * The left-pane tree grid: virtual scrolling, variable row heights, column management, cell
 * editing, sorting, WBS and outline editing — plus the standard field columns, their bar
 * decorations and side-panel section, and conditional formatting of bars with its legend.
 *
 * It provides `stargantt.rows` and `stargantt.grid`, defines `grid/columns` (collect) and
 * `rows/height` (reduce), and contributes the grid pane to `view/panes`. Only the public
 * `@stargantt/core` surface is used — no core internals, no back doors.
 */
import { collect, createStore, definePlugin, reduce } from "@stargantt/core";
import type { Plugin, PluginContext } from "@stargantt/core";
import type { Task, TaskId } from "@stargantt/plugin-data-store";
import type { RowGeometryProvider } from "@stargantt/plugin-view";
import { MS_DAY } from "@stargantt/sdk";
import { BUILT_IN_COLUMN_WEIGHT, hasWeight, weightSortedReader } from "./internal/column-order";
import { DEFAULT_FORMATTERS, defaultColumns } from "./internal/columns";
import type { CellFormatters } from "./internal/columns";
import { createColumnView, resolveCollation } from "./internal/column-view";
import type { CellRenderer, ColumnLayoutConfig } from "./internal/column-view";
import { setupConditionalFormat } from "./internal/conditional-format/index";
import type { ConditionalFormatConfig } from "./internal/conditional-format/types";
import { buildCustomFieldColumns } from "./internal/custom-fields-columns";
import {
  countDescendants,
  indentTarget,
  insertSlot,
  lastRootTaskId,
  noRefInsertDates,
  outdentTarget,
  planExpandToLevel,
} from "./internal/outline";
import { resolveMessages } from "./internal/messages";
import { GRID_PANE_WIDTH, INDENT_PX, mountGridPane } from "./internal/pane";
import { DEFAULT_ROW_HEIGHT, RowModel, defaultRowHeightResolver } from "./internal/row-model";
import { setupTaskFields } from "./internal/task-fields/index";
import type { TaskFieldsConfig } from "./internal/task-fields/types";
import { computeWbsCodes, wbsColumnDef } from "./internal/wbs";
import type {
  ColumnDef,
  GridService,
  GridSortState,
  InsertPosition,
  ResolvedRowHeight,
  RowHeightContribution,
  RowsService,
  RowsSnapshot,
  TreeGridMessages,
} from "./types";

export type {
  AllCondition,
  AnyCondition,
  ColumnDef,
  ColumnEditor,
  Condition,
  ConditionOperator,
  ConditionalFormatRule,
  ConditionalFormatStyle,
  DurationUnit,
  FieldCondition,
  GridService,
  GridSortState,
  InsertPosition,
  NotCondition,
  OverdueOptions,
  ProgressStatusColors,
  ResolvedRowHeight,
  RowHeightContribution,
  RowsService,
  RowsSnapshot,
  TaskFieldValues,
  TaskFieldsColumnId,
  TaskFieldsPatch,
  TaskPriority,
  TaskStatus,
  TaskTemplate,
  TreeGridMessages,
} from "./types";
export type { CellRenderer, ColumnLayoutConfig } from "./internal/column-view";
export { dateEditor, selectEditor } from "./internal/editors";
export type { SelectOption } from "./internal/editors";
export type { TaskFieldsConfig } from "./internal/task-fields/types";
export type { ConditionalFormatConfig } from "./internal/conditional-format/types";

/* ------------------------------------------------------------------ *
 * Plugin
 * ------------------------------------------------------------------ */

const PLUGIN_ID = "stargantt.tree-grid";


// docs/specs/plugins/tree-grid.md § Config
/**
 * Options for the tree-grid plugin.
 *
 * Every option reproduces the built-in behavior exactly when omitted — the same geometry, the same
 * columns, the same cell text — so a default chart is unaffected. None of them is re-read after
 * setup.
 */
export interface TreeGridConfig {
  /** Replacement text, per key. Keys left out keep their English defaults. */
  messages?: Partial<TreeGridMessages>;

  /**
   * The height of one chart row in CSS px, used for every row that no `rows/height` contribution
   * overrides — and therefore also the `defaultHeight` those contributions receive. Defaults to 28.
   *
   * Must be a finite number greater than zero; any other value is ignored and the default is used.
   */
  rowHeight?: number;

  /**
   * The initial width of the grid pane in CSS px. Defaults to 580. The user can still drag the
   * divider afterwards; this only sets where it starts.
   *
   * Must be a finite number greater than zero; any other value is ignored and the default is used.
   */
  paneWidth?: number;

  /**
   * How far each tree level indents the expand toggle and the tree column's content, in CSS px.
   *
   * The tree column is the first displayed column that is not the WBS numbering column `wbs` adds —
   * with `wbs` off it is simply the first column; with `wbs` on the numbering column keeps its full
   * width at every depth and the indentation applies to the column after it. No other column moves
   * with depth: the tree column's content box shrinks by exactly what the toggle gutter grows, so
   * every column stays aligned with its header at every depth. Depth 0 is never indented, and on
   * trees deep enough to exhaust the tree column's width the indent stops growing rather than
   * pushing the row wider than its header. Defaults to 16.
   *
   * Must be a finite number of at least zero — `0` legitimately means "do not indent at all". Any
   * other value is ignored and the default is used.
   */
  indent?: number;

  /**
   * Makes the whole grid read-only: every composed column behaves as if it declared
   * `editable: false`, whatever its `setValue`. Nothing else about the columns changes — headers,
   * widths, rendering and sorting are untouched. Defaults to false.
   */
  readOnly?: boolean;

  /**
   * Replaces the four built-in columns.
   *
   * Omit it and the grid contributes its built-in Name / Start / End / Progress columns, which is
   * the default. Supply an array and those four are not contributed at all: the grid contributes
   * these columns instead, in this order. Columns other plugins contribute are unaffected either
   * way. The empty array is a legitimate value and means "no built-in columns".
   */
  columns?: ColumnDef[];

  /**
   * Formats a task date for the built-in Start and End columns.
   *
   * Defaults to the ISO calendar date in UTC (`2026-08-07`). `t` is always a finite epoch-ms
   * instant — a task whose date is missing or not finite renders an empty cell without calling
   * this. Ignored when `columns` replaces the built-in columns.
   */
  formatDate?: (t: number) => string;

  /**
   * Formats a task's progress for the built-in Progress column.
   *
   * Defaults to the value rounded to a whole percentage (`45%`). `p` is always a finite number and
   * is the raw stored value, which is normally 0..1 but is not clamped — a task with no progress,
   * or a non-finite one, renders an empty cell without calling this. Ignored when `columns`
   * replaces the built-in columns.
   */
  formatProgress?: (p: number) => string;

  /**
   * Hides and/or reorders the displayed columns by id, without changing what any plugin
   * contributes to the column composition. Omitted, the composed columns display as contributed,
   * which is the default. A non-object value is ignored.
   */
  columnLayout?: ColumnLayoutConfig;

  /**
   * Replaces how named columns paint their cells: keys are column ids, values render into the
   * (already cleared) cell element. Columns not named keep their own rendering; everything else
   * about an overridden column — header, editing, sorting — is untouched. A renderer that throws
   * is reported once and then retired for the life of the instance, its column falling back to
   * its own rendering. Non-function values are ignored. Defaults to no overrides.
   */
  cellRenderers?: Record<string, CellRenderer>;

  /**
   * Adds extra CSS class tokens to a row's element, computed from its task each time the row
   * paints (space-separated for several at once; `undefined` for none). Purely presentational —
   * geometry and content are unaffected. A hook that throws is reported once and then not called
   * again for the life of the instance. Defaults to no extra classes.
   */
  rowClass?: (task: Readonly<Task>) => string | undefined;

  /**
   * Adds a read-only WBS column showing each task's work-breakdown code (`1`, `1.2`, `1.2.3` …),
   * computed from the tree in the store's sibling order, ahead of the other built-in columns. The
   * column sorts numerically per segment, never carries the tree indentation — that moves to the
   * column after it, so a code's room does not shrink as the code grows — and every cell carries
   * its full code as a `title`, so a code too long for the column is never lost. Defaults to false;
   * a non-boolean value is ignored.
   */
  wbs?: boolean;

  /**
   * Shows, on every collapsed row that has children, a small text badge after the tree column's
   * content with the number of hidden descendants in parentheses. With `wbs` on that is the column
   * after the numbering column, so a WBS code is never truncated by a badge. Defaults to false; a
   * non-boolean value is ignored.
   */
  collapsedBadge?: boolean;

  /**
   * Enables outline editing from the keyboard: with the grid pane (or one of its rows) focused,
   * `Tab` indents the active row's task under its preceding sibling and `Shift+Tab` outdents it —
   * the same undoable updates as the `view/rowIndent` / `view/rowOutdent` commands, which work
   * regardless of this flag. While enabled, `Tab` inside the grid pane no longer moves the
   * browser focus. Defaults to false; a non-boolean value is ignored.
   */
  outlineEditing?: boolean;

  /**
   * Sorts the built-in Name column with a locale-aware collator instead of leaving it unsortable:
   * `true` uses the environment's default locale, and an object may name `locales` (a BCP 47 tag
   * or list) and `Intl.Collator` `options`. Ignored when `columns` replaces the built-in columns,
   * and ignored entirely — as if absent — when the environment rejects the locale. Defaults to
   * off.
   */
  collation?: boolean | { locales?: string | string[]; options?: Intl.CollatorOptions };

  /**
   * Enables the standard field columns, their bar decorations and their side-panel section.
   *
   * Omitting the nest leaves the whole feature dormant — no columns, no overlays, no panel
   * section. Supplying it, even as `{}`, enables the feature with its per-field defaults.
   */
  taskFields?: TaskFieldsConfig;

  /**
   * Enables conditional formatting: rule-driven bar colors, the overdue warning, progress-status
   * coloring and the legend.
   *
   * Omitting the nest leaves the whole feature dormant — nothing is recolored and no legend is
   * mounted. Supplying it, even as `{}`, enables the feature with its per-field defaults.
   */
  conditionalFormat?: ConditionalFormatConfig;
}

/** The validation rule for `rowHeight` / `paneWidth`: finite and strictly positive. */
function positive(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

/** The validation rule for `indent`: finite and at least zero, so `0` is a legal value. */
function nonNegative(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback;
}

/** A non-boolean value is ignored and the default used. */
function booleanFlag(value: boolean | undefined, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

// docs/specs/plugins/tree-grid.md § Config
/**
 * The usability rule for one entry of `TreeGridConfig.columns`: a string `id`, a string `header`,
 * a callable `render` and a callable `getValue`. An entry that fails it is skipped; the remaining
 * entries are still contributed, and skipping every entry of a non-empty array does *not*
 * resurrect the built-ins.
 */
function usableColumn(value: unknown): value is ColumnDef {
  if (value === null || typeof value !== "object") return false;
  const column = value as Partial<ColumnDef>;
  return (
    typeof column.id === "string" &&
    typeof column.header === "string" &&
    typeof column.render === "function" &&
    typeof column.getValue === "function"
  );
}

/** Whether a config nest is present at all — the feature's activation switch. */
function nestPresent(value: unknown): boolean {
  return value !== null && typeof value === "object";
}

function setup(ctx: PluginContext, config: TreeGridConfig): void {
  // docs/specs/plugins/tree-grid.md § Config — a value outside the documented range is ignored and
  // the default used, rather than throwing or being propagated into geometry that prefix sums and
  // pane layout could not recover from.
  const rowHeight = positive(config.rowHeight, DEFAULT_ROW_HEIGHT);
  const paneWidth = positive(config.paneWidth, GRID_PANE_WIDTH);
  const indent = nonNegative(config.indent, INDENT_PX);
  const readOnly = booleanFlag(config.readOnly, false);
  // Resolved once, at setup(), and baked into the `ColumnDef`s contributed below; `config.messages`
  // is not re-read afterwards.
  const messages = resolveMessages(config.messages);

  const data = ctx.use("stargantt.data");
  const view = ctx.use("stargantt.view");
  const timeline = ctx.use("stargantt.timeline");
  const theme = ctx.use("stargantt.theme");
  const fields = ctx.useOptional("stargantt.fields");

  // docs/specs/plugins/tree-grid.md § Extension points — the claimed `task.meta` key the standard
  // field values are stored under.
  ctx.claimKey("task.meta", "taskFields");

  // Contributions that are functions (or carry them) are invoked by the point-owning plugin, which
  // must guard them and report through `core/pluginError`. The contributor's own plugin id is not
  // observable through the public API, so the invoking plugin is reported — but the payload must
  // not therefore claim that *this* plugin threw. The cause is wrapped with the point it came
  // through, so a diagnostic reads "a contribution to a tree-grid point faulted".
  const fault = (point: string, error: unknown): void => {
    ctx.emit("core/pluginError", { pluginId: PLUGIN_ID, error: { point, cause: error } });
  };

  /**
   * Wraps one configured format hook in a *latched* fault barrier.
   *
   * A non-function value is ignored and the built-in default is used. A hook that throws is
   * reported once, that cell falls back to the built-in default, and the hook is then not called
   * again for the life of the instance: row materialization runs at scroll frequency, so an
   * unlatched barrier would report per cell per frame.
   */
  function formatter(
    hook: ((value: number) => string) | undefined,
    fallback: (value: number) => string,
    option: "formatDate" | "formatProgress",
  ): (value: number) => string {
    if (typeof hook !== "function") return fallback;
    let faulted = false;
    return (value) => {
      if (faulted) return fallback(value);
      try {
        return hook(value);
      } catch (error) {
        faulted = true;
        ctx.emit("core/pluginError", { pluginId: PLUGIN_ID, error: { option, cause: error } });
        return fallback(value);
      }
    };
  }

  // Read once, at setup(), like every other option. Both are inert when `columns` replaces the
  // built-in columns: a replacement column formats its own cells inside its `render`.
  const formatters: CellFormatters = {
    date: formatter(config.formatDate, DEFAULT_FORMATTERS.date, "formatDate"),
    progress: formatter(config.formatProgress, DEFAULT_FORMATTERS.progress, "formatProgress"),
  };

  /* --- `grid/columns` (collect) --------------------------------------- */
  const columnsPoint = ctx.defineExtensionPoint("grid/columns", collect<ColumnDef>());

  /* --- `rows/height` (reduce: default → overridden by contributions) --- */
  const heightPoint = ctx.defineExtensionPoint(
    "rows/height",
    (inputs: RowHeightContribution[]): ResolvedRowHeight =>
      reduce<RowHeightContribution, ResolvedRowHeight>(
        // Each contribution sees the height resolved so far as its `defaultHeight` and may
        // override it; returning `undefined` declines. Later contributions therefore win, which is
        // what "default value → overridden by contributions" asks for.
        (acc, contribution) => {
          // The fault barrier, latched. `measure()` calls this composite once per row per rebuild,
          // so an unlatched report would emit `core/pluginError` O(rows) times per data change
          // (100k rows means 100k synchronous emits) — a de-facto denial of service of the barrier
          // itself. A contribution that throws is reported once and then skipped until the point is
          // reduced again (a new contribution invalidates the core's cached reduction).
          let faulted = false;
          return (task, defaultHeight) => {
            const base = acc(task, defaultHeight);
            if (faulted) return base;
            try {
              const override = contribution(task, base);
              return override === undefined ? base : override;
            } catch (error) {
              faulted = true;
              fault("rows/height", error);
              return base;
            }
          };
        },
        defaultRowHeightResolver,
      )(inputs),
  );

  const model = new RowModel(
    data,
    () => {
      // A faulting reducer yields `undefined` from the core; fall back to fixed height.
      const resolved = heightPoint.get();
      return typeof resolved === "function" ? resolved : defaultRowHeightResolver;
    },
    rowHeight,
  );

  /* --- the published stores -------------------------------------------- */
  const rowsStore = createStore<RowsSnapshot>(model.snapshot());
  const columnWidthsStore = createStore<ReadonlyMap<string, number>>(new Map());
  const sortStore = createStore<GridSortState | null>(null);

  // docs/specs/plugins/tree-grid.md § Services / § Extension points — one publication per row-set
  // change: the store snapshot, the background layer the view plugin paints row geometry onto, and
  // the grid pane's own repaint.
  function publishRows(): void {
    rowsStore.set(model.snapshot());
    view.invalidate("background");
    pane.schedule();
  }

  // Hierarchy-derived values (WBS codes, descendant counts) are cached per data generation and
  // dropped when the task set changes, so painting a row never re-walks the tree.
  const wbsEnabled = booleanFlag(config.wbs, false);
  const badgeEnabled = booleanFlag(config.collapsedBadge, false);
  const outlineEditing = booleanFlag(config.outlineEditing, false);
  let wbsCache: Map<TaskId, string> | null = null;
  let descendantCache: Map<TaskId, number> | null = null;
  const wbsOf = (id: TaskId): string => {
    if (wbsCache === null) wbsCache = computeWbsCodes(data.query());
    return wbsCache.get(id) ?? "";
  };
  const rowBadge = !badgeEnabled
    ? undefined
    : (row: number, id: TaskId): string | undefined => {
        if (!model.hasChildrenAt(row) || model.isExpanded(id)) return undefined;
        if (descendantCache === null) descendantCache = new Map();
        let n = descendantCache.get(id);
        if (n === undefined) {
          n = countDescendants(data.query(), id);
          descendantCache.set(id, n);
        }
        return `(${n})`;
      };

  // The latched barrier for `rowClass`: rows repaint at scroll frequency, so a throwing hook is
  // reported once and retired.
  const rowClassHook = config.rowClass;
  let rowClassFaulted = false;
  const rowClass =
    typeof rowClassHook !== "function"
      ? undefined
      : (task: Readonly<Task>): string | undefined => {
          if (rowClassFaulted) return undefined;
          try {
            return rowClassHook(task);
          } catch (error) {
            rowClassFaulted = true;
            ctx.emit("core/pluginError", {
              pluginId: PLUGIN_ID,
              error: { option: "rowClass", cause: error },
            });
            return undefined;
          }
        };

  const pane = mountGridPane(ctx, model, {
    // The configured view over the composed reduction; with neither option in use this is the raw
    // reduction read, unchanged. The collected list is weight-sorted before the header and cells
    // are built, so `columnLayout` and the pane both see the display order, not the raw
    // start-up-tier order.
    columns: createColumnView({
      read: weightSortedReader(() => columnsPoint.get() ?? []),
      layout:
        config.columnLayout !== null && typeof config.columnLayout === "object"
          ? config.columnLayout
          : undefined,
      renderers: config.cellRenderers,
      fault: (error) => fault("grid/columns", error),
    }),
    fault: (error) => fault("grid/columns", error),
    view,
    theme,
    onRowsChanged: () => publishRows(),
    onSortChanged: (sort) => sortStore.set(sort),
    onColumnWidths: (widths) => columnWidthsStore.set(widths),
    indent,
    readOnly,
    rowClass,
    rowBadge,
    // Tab/Shift+Tab route into the same commands the public API exposes, so one keypress is one
    // undoable step.
    outline: !outlineEditing
      ? undefined
      : (id, direction) =>
          ctx.dispatch(direction === "indent" ? "view/rowIndent" : "view/rowOutdent", { id }),
  });

  // docs/specs/plugins/tree-grid.md § Extension points — the grid pane. `initialWidth` is
  // `TreeGridConfig.paneWidth`; `minWidth: 120` is the floor the view plugin's shrink and
  // divider-clamp rules honor, and `label` names the divider through this plugin's own catalog.
  ctx.contribute("view/panes", {
    id: PLUGIN_ID,
    side: "left",
    order: 0,
    initialWidth: paneWidth,
    minWidth: 120,
    label: messages.paneResizeLabel,
    // A resize step changes the body's visible width outside every other repaint trigger, so the
    // horizontal-overflow cue is refreshed here too.
    onResize: () => pane.onPaneResize(),
    mount: (el: HTMLElement) => pane.mount(el),
  });

  // docs/specs/plugins/tree-grid.md § Extension points — the vertical content extent the view
  // plugin clamps scrolling to. Measured at call time so the resolved extent always reflects the
  // current expand/collapse state and row heights.
  ctx.contribute("renderer/contentExtent", {
    id: PLUGIN_ID,
    measure: () => ({ height: model.totalHeight() }),
  });

  // docs/specs/plugins/tree-grid.md § Extension points — the row geometry the view plugin's
  // grid-lines, row-stripes and row-hover passes paint from, answered live per call from the same
  // row model this plugin publishes. Repaint responsibility is this plugin's: `publishRows()`
  // invalidates the background layer whenever the geometry moves.
  const rowGeometry: RowGeometryProvider = {
    rowCount: () => model.rowCount(),
    rowAtY: (y) => model.rowAtY(y),
    yOf: (row) => model.yOf(row),
    rowHeight: (row) => model.rowHeight(row),
  };
  ctx.contribute("renderer/rowGeometry", rowGeometry);

  /* --- built-in column contributions ----------------------------------- */
  // `grid/columns` stays a purely additive collect point; `TreeGridConfig.columns` changes only
  // what *this* plugin contributes to it. With an array present the built-ins are never
  // constructed, rather than contributed and suppressed afterwards, so ordering against other
  // plugins is ordinary registration order. A `columns` that is not an array is ignored wholesale;
  // the empty array is a legitimate "no built-in columns". Replacement entries share the built-ins'
  // weight 0 unless the entry sets its own, so a bare replacement array keeps its own order and
  // still sits left of the columns other plugins contribute.
  let columnList = Array.isArray(config.columns)
    ? config.columns
        .filter(usableColumn)
        .map((c) => (hasWeight(c) ? c : { ...c, weight: BUILT_IN_COLUMN_WEIGHT }))
    : defaultColumns(messages, formatters);
  if (!Array.isArray(config.columns)) {
    // The built-in Name column gains a locale-aware comparator, making its header sortable; inert
    // under `columns`.
    const collate = resolveCollation(config.collation);
    if (collate !== undefined) {
      columnList = columnList.map((c) =>
        c.id === "name" ? { ...c, compare: (a, b) => collate(a.name, b.name) } : c,
      );
    }
  }
  // Prepended so the code leads the row, and contributed through the same public path as every
  // other column.
  if (wbsEnabled) columnList = [wbsColumnDef(messages.wbsColumn, wbsOf), ...columnList];
  for (const column of columnList) ctx.contribute("grid/columns", column);

  // docs/specs/plugins/tree-grid.md § Internal modules — the user-defined field columns, built here
  // from the optional fields service rather than contributed by its owner.
  if (fields !== undefined) {
    for (const column of buildCustomFieldColumns(fields, messages)) {
      ctx.contribute("grid/columns", column);
    }
  }

  /* --- the internalized features ---------------------------------------- */
  // docs/specs/plugins/tree-grid.md § Config — a nest omitted leaves its whole feature dormant; a
  // nest present, even `{}`, enables it with the per-field defaults.
  if (nestPresent(config.taskFields)) {
    setupTaskFields(ctx, {
      config: config.taskFields as TaskFieldsConfig,
      messages,
      data,
      theme,
      contributeColumn: (column) => ctx.contribute("grid/columns", column),
    });
  }
  if (nestPresent(config.conditionalFormat)) {
    setupConditionalFormat(ctx, {
      config: config.conditionalFormat as ConditionalFormatConfig,
      messages,
      data,
      theme,
      view,
    });
  }

  // docs/specs/plugins/tree-grid.md § Services — before the first header layout the width map
  // carries exactly the columns that declared a `width`, at their declared value; a width-less
  // column has no entry until the header has been laid out and can be measured.
  const declared = new Map<string, number>();
  for (const column of columnsPoint.get() ?? []) {
    const width = column.width;
    if (typeof width === "number" && Number.isFinite(width) && width > 0) {
      declared.set(column.id, width);
    }
  }
  columnWidthsStore.set(declared);

  /* --- the published services ------------------------------------------- */
  const rowsService: RowsService = {
    rowCount: () => model.rowCount(),
    taskIdAt: (row) => model.taskIdAt(row),
    rowOf: (id) => model.rowOf(id),
    rowHeight: (row) => model.rowHeight(row),
    resolvedHeightOf: (id) => model.resolvedHeightOf(id),
    yOf: (row) => model.yOf(row),
    rowAtY: (y) => model.rowAtY(y),
    totalHeight: () => model.totalHeight(),
    isExpanded: (id) => model.isExpanded(id),
    rows: rowsStore,
  };
  ctx.provide("stargantt.rows", rowsService);

  // The write side a selection-owning plugin uses to reflect its selection into the grid, the one
  // the focus owner uses to reflect the roving focus, and the two display-state stores the grid
  // itself publishes.
  const gridService: GridService = {
    setSelected: (ids) => pane.setSelected(ids),
    setFocused: (id) => pane.setFocused(id),
    columnWidths: columnWidthsStore,
    sort: sortStore,
  };
  ctx.provide("stargantt.grid", gridService);

  /**
   * Expand/collapse goes `view/rowToggle` → row-model update → one `rows` publication, the same
   * snapshot the chart side syncs on.
   */
  ctx.registerCommand("view/rowToggle", (payload) => {
    const changed =
      payload.expanded === undefined
        ? model.setExpanded(payload.id)
        : model.setExpanded(payload.id, payload.expanded);
    if (!changed) return;
    publishRows();
  });

  // docs/specs/plugins/tree-grid.md § Commands — the payload-less rebuild: it marks the flattening
  // and the height resolution stale and publishes once, exactly what a toggle does, without
  // touching any expand/collapse state.
  ctx.registerCommand("view/rowsInvalidate", () => {
    model.invalidate();
    publishRows();
  });

  // Display state only: no store write, no transaction, nothing published. The line is owned and
  // cleared by whichever plugin is dragging, which is why the grid keeps no state beyond the
  // element itself.
  ctx.registerCommand("view/dropIndicator", (payload) => {
    pane.showDropIndicator(payload);
  });

  // The public path into the same inline edit F2 / double-click start. Unknown/collapsed ids
  // resolve to no row; rows outside the viewport have no materialized cell; an omitted `columnId`
  // targets the first editable column and an unusable one declines — all silent no-ops.
  ctx.registerCommand("view/editStart", (payload) => {
    const row = model.rowOf(payload.id);
    if (row === undefined) return;
    pane.editStart(row, payload.columnId);
  });

  // Indent/outdent are ordinary `task/update` transactions (one undoable step each); an impossible
  // move is a silent no-op. The task keeps its `orderKey`; its place among its new siblings follows
  // that key.
  ctx.registerCommand("view/rowIndent", (payload) => {
    const parent = indentTarget(data.query(), payload.id);
    if (parent === undefined) return;
    ctx.dispatch("task/update", { id: payload.id, after: { parentId: parent } });
  });
  ctx.registerCommand("view/rowOutdent", (payload) => {
    const target = outdentTarget(data.query(), payload.id);
    if (target === undefined) return;
    ctx.dispatch("task/update", { id: payload.id, after: { parentId: target.parentId } });
  });

  // How long an inserted task is: one grid cell of the active zoom level.
  const insertDuration = (from: number): number => {
    const cell = timeline.gridCellAt(from);
    return cell === undefined ? MS_DAY : cell.end - cell.start;
  };

  // docs/specs/plugins/tree-grid.md § Commands — one `task/add` transaction; the store mints the
  // new task's id and order key from the sibling index.
  ctx.registerCommand("view/rowInsert", (payload) => {
    // An insert asked for from a row means "something under this task", so `"child"` is what an
    // omitted or unusable position means.
    const position: InsertPosition =
      payload.position === "above" || payload.position === "below" ? payload.position : "child";
    const slot = insertSlot(data.query(), payload.id, position);
    if (slot === undefined) return;
    const ref = payload.id === undefined ? undefined : data.getTask(payload.id);
    const name = typeof payload.name === "string" ? payload.name : messages.newTaskName;
    const task: Partial<Task> & { name: string } = { name, parentId: slot.parentId };
    if (ref !== undefined) {
      // The new task starts where the reference task does and lasts one grid cell of the current
      // zoom, rather than inheriting a span the user did not ask for.
      //
      // The exception, and the reason this is not simply "one cell": a `"child"` insert under a
      // task with no children *promotes* it to a summary, and a summary's dates roll up from its
      // children — so a one-cell child would redefine a month-long task as a one-day one. Copying
      // the reference's span makes the roll-up reproduce it exactly and the insert moves nothing.
      // A reference that is already a summary keeps the one-cell rule: the new child lands inside
      // a span it does not define on its own.
      const promotes =
        position === "child" && (data.query().children.get(ref.id) ?? []).length === 0;
      task.start = ref.start;
      task.end = promotes ? ref.end : ref.start + insertDuration(ref.start);
    } else if (payload.id === undefined) {
      // A no-id insert is dated exactly as a `"below"` insert on the current last root task, or —
      // empty store — the grid cell containing the current instant clamped to the axis origin
      // (`max(Date.now(), xToT(0))`, so a host-configured future origin dates the task at the
      // origin rather than before it). This path never produces an undated task.
      const lastRootId = lastRootTaskId(data.query());
      const lastRootStart = lastRootId === undefined ? undefined : data.getTask(lastRootId)?.start;
      const dates = noRefInsertDates(
        lastRootStart,
        Date.now(),
        (t) => timeline.gridCellAt(t),
        (x) => timeline.xToT(x),
      );
      task.start = dates.start;
      task.end = dates.end;
    }
    if (slot.index === undefined) ctx.dispatch("task/add", { task });
    else ctx.dispatch("task/add", { task, index: slot.index });
    // A child added under a collapsed row would be created where nobody can see it. Expansion is
    // display state, so revealing it adds no second undo step.
    const parentId = slot.parentId;
    if (parentId !== null && parentId !== undefined && !model.isExpanded(parentId)) {
      ctx.dispatch("view/rowToggle", { id: parentId, expanded: true });
    }
  });

  // Display state only, published through the same `rows` snapshot an individual toggle publishes.
  ctx.registerCommand("view/expandToLevel", (payload) => {
    const level = payload.level;
    if (typeof level !== "number" || !Number.isFinite(level) || level < 0) return;
    const plan = planExpandToLevel(data.query(), Math.floor(level));
    let changed = false;
    for (const step of plan) if (model.setExpanded(step.id, step.expanded)) changed = true;
    if (!changed) return;
    publishRows();
  });

  // docs/specs/plugins/tree-grid.md § Services — a data-driven reflow. Writing to this plugin's own
  // stores from inside another plugin's store notification is permitted; only re-entering the
  // notifying store would throw.
  ctx.own(
    data.tasks.subscribe(() => {
      model.invalidate();
      wbsCache = null;
      descendantCache = null;
      publishRows();
    }),
  );
}

/**
 * Creates the tree-grid plugin: it owns the row model — which tasks are visible, at what height and
 * at what vertical offset — and renders the grid pane beside the chart.
 *
 * Configurable plugins are exported as factories because the host passes no per-plugin config to
 * `setup()`: any configuration is closed over here and the produced plugin itself takes `void`.
 */
export function treeGrid(config?: TreeGridConfig): Plugin<void> {
  // The object is snapshotted so a later mutation by the caller cannot change the plugin's
  // behavior.
  const snapshot: TreeGridConfig = { ...config };
  return definePlugin({
    meta: {
      id: PLUGIN_ID,
      dependsOn: ["stargantt.data-store", "stargantt.view"],
    },
    setup: (ctx: PluginContext): void => setup(ctx, snapshot),
  });
}
