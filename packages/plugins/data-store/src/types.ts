/**
 * `@stargantt/plugin-data-store` — public types.
 *
 * The whole data model — tasks, links, calendars, patches and transactions — belongs to this
 * plugin. The core knows none of these types.
 */
import type { Store } from "@stargantt/core";

/** Identifier of a task. Unique within a store. */
export type TaskId = string | number;
/** Identifier of a dependency link. Unique within a store. */
export type LinkId = string | number;
/** Identifier of a working calendar. Unique within a store. */
export type CalendarId = string | number;

/**
 * Scheduling constraint on a task: as soon as possible, as late as possible, start no earlier
 * than, or finish no later than. The four built-in values are not exhaustive — a plugin may
 * supply its own constraint type string, which auto-scheduling resolves through an extension
 * point rather than this type.
 */
export type ConstraintType = "ASAP" | "ALAP" | "SNET" | "FNLT" | (string & {});

/**
 * Dependency kind: finish-to-start, start-to-start, finish-to-finish or start-to-finish.
 */
export type LinkType = "FS" | "SS" | "FF" | "SF";

/**
 * One row of the chart.
 *
 * `start` and `end` (and every other date carried by this plugin — link lag aside, which is a
 * duration, not an instant) are epoch milliseconds interpreted as UTC-fixed instants: the same
 * millisecond value always names the same point in time, with no time-zone or locale adjustment
 * applied anywhere in this library. A host that wants dates displayed and edited in a local time
 * zone applies the offset itself — pre-offsetting each value before loading it, and re-subtracting
 * the same offset when reading values back out through `toJSON()` or the service — so this
 * library's UTC arithmetic ends up rendering the intended local wall-clock dates.
 */
export interface Task {
  id: TaskId;
  parentId: TaskId | null;
  name: string;
  /** Epoch milliseconds, UTC-fixed (see the interface doc above). */
  start: number;
  /** Epoch milliseconds, UTC-fixed (see the interface doc above); exclusive — duration is derived. */
  end: number;
  /** fractional index giving this task its position among its siblings */
  orderKey?: string;
  /** 0..1 */
  progress?: number;
  type?: "task" | "summary" | "milestone";
  constraint?: { type: ConstraintType; date?: number };
  calendarId?: CalendarId;
  meta?: Record<string, unknown>;
}

/** A dependency between two tasks. */
export interface Link {
  id: LinkId;
  sourceId: TaskId;
  targetId: TaskId;
  type: LinkType;
  /** ms; negative = lead */
  lag?: number;
}

/** Identifier of a resource. Unique within a store. */
export type ResourceId = string | number;

/** A person, machine or other capacity holder that tasks can be assigned to. */
export interface Resource {
  id: ResourceId;
  name: string;
  /**
   * Availability as a dimensionless full-time-equivalent rate, in the same unit as
   * `Assignment.units`: 1 = one full-time resource, 0.5 = half-time, 2 = a two-person crew. Not a
   * per-day quantity — it is a multiplier applied to whatever working time a consumer measures.
   * Omitted = 1.
   */
  capacity?: number;
}

/**
 * Assignment of a resource to a task, kept as an independent list symmetric to `Link`. Its
 * identity is the composite key (taskId, resourceId): the store normalizes to at most one entry
 * per task×resource pair, so there is no separate assignment id.
 */
export interface Assignment {
  taskId: TaskId;
  resourceId: ResourceId;
  /** Allocation rate; 1 = full-time. Always finite and greater than zero. */
  units: number;
}

/**
 * A named working calendar: which weekdays and which windows within a day count as working time,
 * plus per-date exceptions.
 *
 * All window values — `workingHours` and an exception's `hours` — are **milliseconds from UTC
 * midnight**, so a 09:00–17:00 working day is `[32400000, 61200000]`.
 */
export interface CalendarDef {
  id: CalendarId;
  /** Weekly working days, 0 = Sunday … 6 = Saturday (UTC). */
  workingDays: number[];
  /**
   * Intra-day working windows, each half-open `[startMs, endMs)` in milliseconds from UTC midnight
   * (domain 0…86,400,000). Omitted — or holding no usable window — means the whole working day is
   * working time.
   */
  workingHours?: [startMs: number, endMs: number][];
  /**
   * Per-date overrides, `date` being `"YYYY-MM-DD"` in UTC. `working` overrides the weekday rule,
   * and `hours`, when given, replaces the calendar's `workingHours` for that date — same unit,
   * milliseconds from UTC midnight.
   */
  exceptions?: { date: string; working: boolean; hours?: [number, number][] }[];
}

/**
 * The reversible minimal unit of change. Every patch has an inverse: `add` and `remove` are
 * duals, and `update` is inverted by swapping `before` and `after`.
 */
export type Patch =
  | { op: "task/add"; task: Task }
  | { op: "task/remove"; task: Task }
  | {
      op: "task/update";
      id: TaskId;
      before: Partial<Task>;
      after: Partial<Task>;
      /**
       * Task fields to delete outright, applied *after* `after` is assigned. This is the only way
       * to restore an optional field to fully absent: an omitted key in `after` means "leave this
       * field's current value alone", which cannot express "unset it". Unknown keys and keys the
       * task does not currently carry are no-ops; `id` can never be cleared.
       */
      clears?: readonly (keyof Task)[];
    }
  | { op: "link/add"; link: Link }
  | { op: "link/remove"; link: Link }
  /**
   * Replaces a stored link with another carrying the same id — the reversible form of retyping or
   * re-lagging a dependency. `before` is the link as stored, `after` the link that replaces it;
   * inverting swaps the two. The endpoints are not editable through this patch's command, so both
   * sides normally name the same `sourceId`/`targetId`.
   */
  | { op: "link/update"; before: Link; after: Link }
  | { op: "resource/add"; resource: Resource }
  | { op: "resource/remove"; resource: Resource }
  | { op: "resource/update"; id: ResourceId; before: Partial<Resource>; after: Partial<Resource> }
  | { op: "assignment/add"; assignment: Assignment }
  | { op: "assignment/remove"; assignment: Assignment }
  | {
      op: "assignment/update";
      taskId: TaskId;
      resourceId: ResourceId;
      before: { units: number };
      after: { units: number };
    };

/**
 * A labelled group of patches applied atomically — either all of them land or none do. One
 * transaction is one entry of the undo history.
 */
export interface Transaction {
  id: string;
  /** shown in undo UI */
  label: string;
  /** mutable: handlers of `data/willApplyTransaction` may append to this list */
  patches: Patch[];
  origin: "user" | "schedule" | "api" | (string & {});
  /** merges consecutive updates into one history entry */
  coalesceKey?: string;
}

/**
 * Describes how to read tasks and links out of arbitrary raw objects passed to
 * `DataService.load()`. Each entry is either the name of the source property or a function
 * computing the value; fields with no entry fall back to the same-named property.
 *
 * `TRaw` is the type of one raw row, so a mapping function receives that type rather than an
 * untyped value. It is inferred from the data handed to `load()`; write it out only when calling
 * with a value whose element type is wider than the rows really are.
 */
export interface FieldMapping<TRaw = unknown> {
  task?: Partial<Record<keyof Task, string | ((raw: TRaw) => unknown)>>;
  link?: Partial<Record<keyof Link, string | ((raw: TRaw) => unknown)>>;
  resource?: Partial<Record<keyof Resource, string | ((raw: TRaw) => unknown)>>;
  assignment?: Partial<Record<keyof Assignment, string | ((raw: TRaw) => unknown)>>;
}

/**
 * Object form of `DataService.load()`'s first argument. The bare-array form stays "tasks only";
 * this form additionally carries links, resources, assignments and calendars.
 *
 * `TRaw` is the type of one raw task row — the type a mapping function is handed. It defaults to
 * `unknown`, which accepts any data at all. The other lists stay untyped: one mapping describes
 * every list, so there is a single row type to infer, and tasks are the list every caller passes.
 */
export interface LoadInput<TRaw = unknown> {
  tasks: TRaw[];
  links?: unknown[];
  resources?: unknown[];
  assignments?: unknown[];
  calendars?: unknown[];
  /**
   * Subtrees to build lazily. Each entry parks its raw `rows` under `parentId` without normalizing
   * or indexing them: the tasks they describe do not exist yet — not in `getTask()`, not in
   * `query()`, not in `toJSON()` — until `materializeChildren(parentId)` is called, which is what
   * keeps the initial load of a chart with large collapsed branches cheap.
   *
   * Each row becomes a direct child of `parentId` when materialized (any parent id the row itself
   * carries is overridden). Two entries naming the same parent concatenate in order; an entry
   * whose `parentId` is not a string or number, or whose `rows` is not an array, is ignored. The
   * parent may itself be described by another deferred entry — its bucket then simply stays
   * pending until the parent has been materialized. Pending buckets are discarded by the next
   * `load()`.
   */
  deferredTasks?: { parentId: TaskId; rows: TRaw[] }[];
}

/**
 * Read-only view of the store's indexes. The list of currently visible rows is deliberately not
 * part of it: that belongs to the row-model service published by the tree-grid plugin.
 */
export interface ReadonlyDataView {
  readonly byId: ReadonlyMap<TaskId, Readonly<Task>>;
  readonly children: ReadonlyMap<TaskId | null, readonly TaskId[]>;
  readonly linksByTask: ReadonlyMap<
    TaskId,
    { readonly in: readonly Link[]; readonly out: readonly Link[] }
  >;
  readonly calendars: ReadonlyMap<CalendarId, Readonly<CalendarDef>>;
  /** Every resource by id, in insertion order. */
  readonly resources: ReadonlyMap<ResourceId, Readonly<Resource>>;
  /** Assignments grouped by task. Tasks with no assignment have no entry. */
  readonly assignmentsByTask: ReadonlyMap<TaskId, readonly Assignment[]>;
}

/**
 * The service this plugin publishes as `stargantt.data`.
 *
 * `links`, `resources` and `assignments` are stores rather than same-named iterable methods:
 * iterate a store's current value with `.get().values()`. `tasks` has no separate iterable-method
 * form; its repaint signal is the `tasks` store itself.
 */
export interface DataService {
  getTask(id: TaskId): Task | undefined;
  taskIds(): Iterable<TaskId>;
  query(): ReadonlyDataView;
  /**
   * Replaces the store contents with the given rows, reading each field through `mapping`.
   *
   * `TRaw` — the type of one raw row — is inferred from the data, so a mapping function is handed
   * that type instead of an untyped value.
   */
  load<TRaw = unknown>(raw: TRaw[] | LoadInput<TRaw>, mapping?: FieldMapping<TRaw>): void;
  /**
   * Whether a deferred-children bucket (see `LoadInput.deferredTasks`) is still pending for this
   * task id — i.e. the task has children that were handed to `load()` but not built yet. A tree UI
   * can use this to show an expander on a row whose children do not exist in the store yet.
   */
  hasDeferredChildren(id: TaskId): boolean;
  /**
   * Builds the deferred children of `id` now: normalizes the rows parked for it by `load()`, adds
   * them to the store as direct children of `id` (after its current children, in row order) and
   * publishes the resulting `tasks` snapshot — like `load()` itself, this is a bootstrap path and
   * is not undoable. Does nothing when no bucket is pending for `id` or when `id` names no stored
   * task; each bucket materializes at most once.
   */
  materializeChildren(id: TaskId): void;
  toJSON(): {
    tasks: Task[];
    links: Link[];
    calendars: CalendarDef[];
    resources: Resource[];
    assignments: Assignment[];
  };

  /** Every task, by id — the same objects `query().byId` exposes. */
  readonly tasks: Store<ReadonlyMap<TaskId, Readonly<Task>>>;
  /** Every dependency link, by id. */
  readonly links: Store<ReadonlyMap<LinkId, Readonly<Link>>>;
  /** Every resource, by id, in insertion order. */
  readonly resources: Store<ReadonlyMap<ResourceId, Readonly<Resource>>>;
  /**
   * Every assignment, grouped by task in task-insertion order — an `assignmentsByTask` index.
   * Assignments have no id of their own, so the map is task-keyed.
   */
  readonly assignments: Store<ReadonlyMap<TaskId, readonly Assignment[]>>;
}

/* ==================================================================== *
 * Custom fields (formerly `@stargantt/plugin-custom-fields`, merged in)
 * ==================================================================== */

/** The five field kinds a custom-field definition can declare. */
export type CustomFieldType = "text" | "number" | "date" | "select" | "formula";

/**
 * A stored custom-field value. `text` and `select` fields hold strings; `number` fields hold
 * finite numbers; `date` fields hold epoch-ms UTC numbers. Formula fields compute a value of
 * this type on read and never store one.
 */
export type CustomFieldValue = string | number;

/**
 * One user-declared field. `key` is required in practice — a definition without a usable key is
 * silently dropped — and every other member is optional.
 */
export interface CustomFieldDef {
  /**
   * The unique storage key of this field under each task's `meta.customFields` bag. Must be a
   * non-empty string; a duplicate of an earlier key drops this definition.
   */
  key?: string;
  /** The field kind. Default `"text"`. */
  type?: CustomFieldType;
  /** Column header and display name of the field. Default: the `key` itself. */
  label?: string;
  /** Grid-column width in px. Default 110. */
  width?: number;
  /**
   * `select` fields only: the allowed choice strings, in order. Unusable entries are removed and
   * duplicates collapsed; a select field left without options is dropped.
   */
  options?: readonly string[];
  /**
   * `formula` fields only: the expression computing the field's value from other fields and the
   * task's built-in attributes. A formula field whose text does not parse is dropped.
   */
  formula?: string;
  /** Contribute a tree-grid column for this field. Default `true`. */
  column?: boolean;
}

/** A resolved field definition as reported by the service: every member is present. */
export interface ResolvedCustomField {
  readonly key: string;
  readonly type: CustomFieldType;
  readonly label: string;
  readonly width: number;
  readonly options: readonly string[];
  /** The raw formula text (formula fields only; `""` for the other kinds). */
  readonly formula: string;
  readonly column: boolean;
}

/** One value write for {@link FieldsService.setValues} — the batch form of `setValue`. */
export interface CustomFieldValueEntry {
  /** The task the value belongs to. */
  id: TaskId;
  /** The stored field's key. */
  key: string;
  /** `undefined` removes the stored value, exactly as `setValue` does. */
  value: CustomFieldValue | undefined;
}

/**
 * The service this plugin publishes as `stargantt.fields`.
 *
 * Every write dispatches an ordinary `task/update` command inside one transaction, so each call
 * is one undoable step and sails through the same pipeline as any other edit.
 */
export interface FieldsService {
  /** The resolved field definitions, in configuration order. */
  definitions(): readonly Readonly<ResolvedCustomField>[];
  /**
   * The field's value for a task. Stored fields return the stored value (`undefined` when it is
   * absent, or unusable for the declared type); formula fields return the computed result
   * (`undefined` when the evaluation fails). An unknown task or key yields `undefined`.
   */
  valueOf(id: TaskId, key: string): CustomFieldValue | undefined;
  /**
   * Writes a stored field's value in one transaction (one undo step). Passing `undefined`
   * removes the value. A value unusable for the field's declared type, a formula field, an
   * unknown key or an unknown task is a silent no-op.
   */
  setValue(id: TaskId, key: string, value: CustomFieldValue | undefined): void;
  /**
   * Writes several stored field values as **one** undoable transaction — the batch form of
   * `setValue`, for seeding or bulk-editing many tasks without piling up one undo step per
   * value. Two entries naming the same task merge into that task's single patch, applied in
   * list order, so a later entry for a field wins over an earlier one for the same field. Each
   * entry is otherwise validated exactly as `setValue` validates its arguments — an unknown
   * task, an unknown field, a formula field, or a value unusable for the field's declared type
   * drops that entry silently, and the rest still write. An empty list, or a list whose every
   * entry drops, writes nothing at all and adds no undo entry.
   */
  setValues(entries: readonly CustomFieldValueEntry[]): void;
  /** The field's value formatted exactly as its grid cell shows it; `""` when there is none. */
  displayValue(id: TaskId, key: string): string;
}
