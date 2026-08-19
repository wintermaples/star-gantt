# Plugin: data-store (`stargantt.data-store`)

Package: `@stargantt/plugin-data-store` — Layer 1.
Status: normative.

## Purpose

The single source of truth for the 5 entities (task / link / resource / assignment / calendar); command → reversible-patch transactions; user-defined fields (values, definitions, formula evaluation). Entity changes are observed through per-entity store subscriptions.

## Data model

Public types: `TaskId` / `LinkId` / `CalendarId` / `ResourceId` (`string | number`), `ConstraintType` (`"ASAP" | "ALAP" | "SNET" | "FNLT" | (string & {})`), `LinkType` (`"FS" | "SS" | "FF" | "SF"`), `Task`, `Link`, `Resource`, `Assignment` (identity = composite `(taskId, resourceId)` key), `CalendarDef` (window values are milliseconds from UTC midnight), `Patch` (12 variants, inverse-paired; `task/update` carries `clears`), `Transaction`, `FieldMapping<TRaw>`, `LoadInput<TRaw>` (incl. `deferredTasks`), `ReadonlyDataView`. All task dates are epoch milliseconds interpreted as UTC-fixed instants.

Non-type exports: `REQUIRED_TASK_FIELDS`, `mergeTaskUpdate(task, patch)`, `midKey(prev, next)`, `invertPatch(patch)`, `invertPatches(patches)` — the single shared implementations of merge semantics, order-key arithmetic, and patch inversion that replaying plugins (undo-redo, scheduling) must use instead of copies.

## Services

### `stargantt.data` → `DataService`

```ts
import type { Store } from "@stargantt/core";

export interface DataService {
  // --- methods ---
  getTask(id: TaskId): Task | undefined;
  taskIds(): Iterable<TaskId>;
  query(): ReadonlyDataView;
  load<TRaw = unknown>(raw: TRaw[] | LoadInput<TRaw>, mapping?: FieldMapping<TRaw>): void;
  hasDeferredChildren(id: TaskId): boolean;
  materializeChildren(id: TaskId): void;
  toJSON(): {
    tasks: Task[];
    links: Link[];
    calendars: CalendarDef[];
    resources: Resource[];
    assignments: Assignment[];
  };

  // --- per-entity stores ---
  readonly tasks: Store<ReadonlyMap<TaskId, Readonly<Task>>>;
  readonly links: Store<ReadonlyMap<LinkId, Readonly<Link>>>;
  readonly resources: Store<ReadonlyMap<ResourceId, Readonly<Resource>>>;
  /** Grouped by task, task-insertion order. Assignments have no id of their
   *  own, so the map is task-keyed. */
  readonly assignments: Store<ReadonlyMap<TaskId, readonly Assignment[]>>;
}
```

Member count: 11 (7 methods + 4 stores).

**Design note.** There are deliberately no iterable convenience methods `links()`, `resources()`, `assignments()`: the same-named store properties subsume them — `service.links.get().values()` is the iteration, and the assignments store's values, flattened per task in the grouped order, enumerate every assignment.

**Store snapshot semantics.** Every store value is an immutable snapshot (architecture ch. 1.1). A new snapshot map is published per change; entries are the same `Readonly<Task>` (etc.) objects `query()` exposes. `tasks.get()` and `query().byId` observe the same committed state at all times.

**Notification order per apply (normative).** One transaction apply produces one synchronous burst of store sets, on the dispatching stack, in this order:

1. `links`, `resources`, `assignments` — in that order, and **only** when the transaction's final patch list touched that domain.
2. `tasks` — **always, and always last**, even when no task entry changed (a resource-only transaction publishes an identical map — stores perform no equality gating, so subscribers are still notified). A subscriber that repaints from `tasks` therefore observes every domain in its final state.

`load()` and `materializeChildren()` follow the bulk-path variant, with no transaction anywhere in flight: `load()` sets each entity store whose contents changed (same order) and sets `tasks` always and always last; `materializeChildren()` that materializes nothing sets no store at all.

**Change classification.** The stores carry no `added` / `removed` / `updated` change sets; a subscriber that needs them diffs `(next, prev)` — both maps are snapshots and diffing is key-wise. Subscribers that need the applied `Transaction` consume `data/didApplyTransaction`, which fires once per applied transaction immediately after its store burst (see "Apply flow" below) — never for a cancelled transaction, a failed apply, or the bulk paths.

**Re-entrancy consequence (normative).** Dispatching a mutating command synchronously from inside a data-store subscription would re-enter `set()` on the store currently dispatching and **throws** (architecture ch. 1.1 rule 2). Mutations triggered by data changes must be deferred (sdk/frame scheduler or a microtask). Reading any store or `query()` from inside a subscriber is always safe and observes the committed state.

### `stargantt.fields` → `FieldsService`

Custom field definitions and values. Public types: `CustomFieldType` (`"text" | "number" | "date" | "select" | "formula"`), `CustomFieldValue` (`string | number`), `CustomFieldDef` (`key?`, `type?` default `"text"`, `label?` default = key, `width?` default 110, `options?`, `formula?`, `column?` default `true`), `ResolvedCustomField`, `CustomFieldValueEntry`.

```ts
export interface FieldsService {
  /** The resolved field definitions, in configuration order. */
  definitions(): readonly Readonly<ResolvedCustomField>[];
  /** Stored value or computed formula result; `undefined` on absence, type mismatch,
   *  evaluation failure, unknown task, or unknown key. */
  valueOf(id: TaskId, key: string): CustomFieldValue | undefined;
  /** One `task/update` transaction (undoable); `undefined` removes the value.
   *  Unusable value / formula field / unknown key / unknown task = silent no-op. */
  setValue(id: TaskId, key: string, value: CustomFieldValue | undefined): void;
  /** Batch form: many writes, ONE transaction (one undo step). Entries validated
   *  individually as `setValue` would; invalid entries drop, the rest write; an
   *  all-dropped or empty list writes nothing and adds no undo entry. */
  setValues(entries: readonly CustomFieldValueEntry[]): void;
  /** The value formatted exactly as its grid cell shows it; `""` when there is none. */
  displayValue(id: TaskId, key: string): string;
}
```

Member count: 5. Behavior: storage under `task.meta.customFields` (defensive reads, sibling-key-preserving writes, `clears: ["meta"]` cleanup), definition resolution/drop rules, the formula language (grammar, operators, `IF`/`ROUND`/`ABS`/`MIN`/`MAX`/`LEN`/`CONCAT`, per-task-per-read failure, cycle failure), and the `setValues` merge rules. Formula results are never stored. The plugin claims `ctx.claimKey("task.meta", "customFields")` at setup.

Column supply is **inverted**: this plugin contributes no grid columns; tree-grid consumes `stargantt.fields` (optional) and builds the custom-field columns itself (see tree-grid.md). The select editor's `noneOption` message key accordingly lives in tree-grid's catalog (see tree-grid.md Messages).

## Extension points

None defined, none consumed (custom-field columns reach the grid through the service inversion above, not through `grid/columns`).

## Commands

**14 commands:**

| # | Command | Payload | Notes |
|---|---|---|---|
| 1 | `task/move` | `{ id, start, end, coalesceKey? }` | `coalesceKey` copied verbatim onto the transaction |
| 2 | `task/setProgress` | `{ id, progress, coalesceKey? }` | |
| 3 | `task/add` | `{ task: Partial<Task> & { name }, index?, origin? }` | explicit taken id = silent no-op |
| 4 | `task/remove` | `{ ids, origin? }` | cascade-removes the tasks' links and assignments in the same transaction |
| 5 | `task/update` | `{ id, after, clears?, origin? }` | `clears` = explicit field deletion; required fields never deletable |
| 6 | `link/add` | `{ sourceId, targetId, type, lag?, id?, origin? }` | at most one link per ordered pair; duplicates = no-op; `lag: 0` normalized absent |
| 7 | `link/update` | `{ id, type?, lag?, origin? }` | retype/re-lag, one transaction; endpoints/id not editable |
| 8 | `link/remove` | `{ ids, origin? }` | |
| 9 | `resource/add` | `{ resource: Partial<Resource> & { name }, origin? }` | |
| 10 | `resource/update` | `{ id, after, origin? }` | |
| 11 | `resource/remove` | `{ ids, origin? }` | cascade-removes the resources' assignments |
| 12 | `assignment/set` | `{ taskId, resourceId, units, origin? }` | upsert over the composite key; unusable `units` = no-op |
| 13 | `assignment/remove` | `{ taskId, resourceId, origin? }` | |
| 14 | `history/apply` | `{ patches, origin? }` | batch replay, one transaction; `origin` defaults `"history"` (all others default `"user"`) |

Third parties mutate data exclusively through them (command → reversible patch), gaining undo integration for free.

## Apply flow (normative)

Runner builds patches (unapplied) → emit `data/willApplyTransaction` (cancelable; handlers may append to `transaction.patches`) → summary-promotion patches appended (unconditional invariant: a task with children has `type: "summary"`; will-handlers see the pre-promotion list) → atomic apply + incremental index update → the store burst of the section above, same stack, same synchronous dispatch → emit `data/didApplyTransaction: { transaction }` carrying the applied transaction with its **final** patch list (will-phase appends and summary promotion included). A transaction cancelled in the will phase, or whose atomic apply fails, produces **no** store notification and **no** `data/didApplyTransaction`. A command whose runner builds an **empty patch list** (the uniform unusable-argument no-op: unknown ids, duplicate links, ineffective updates) creates no transaction in the first place — nothing is applied, no event fires, and no store is set. `data/didApplyTransaction` is the settle signal for transaction consumers (undo-redo records from it; see undo-redo.md §Recording): it fires exactly once per applied transaction, in apply order — a nested dispatch from a will-handler settles (burst + did-event) before the outer transaction does. Coalescing (`coalesceKey`) remains undo-redo's contract; the store itself never merges anything.

Bulk paths (`load()`, `materializeChildren()`) carry no transaction and are not undoable (deferred-children rules and summary promotion by direct write included). A `materializeChildren(id)` call that materializes nothing — no bucket pending for `id`, `id` names no stored task, or every parked row is skipped — sets no store and notifies nothing.

## Events

- Emits `data/willApplyTransaction: Cancelable & { transaction: Transaction }` — the pre-transaction hook (official catalog, architecture ch. 3.2).
- Emits `data/didApplyTransaction: { transaction: Transaction }` — the post-apply settle signal (official catalog): fires after the store burst, once per applied transaction, never for cancelled/failed/bulk paths. Design rationale: transaction consumers need an authoritative applied edge — a will-hook + store-burst pairing would be unsound under cancellation, apply failure, and nested dispatch.
- There are no per-entity change events (`data/tasksChanged` and kin are excluded names — architecture.md ch. 3.3); the four entity stores are the change channel.

## Config

Factory: `dataStore(config?: DataStoreConfig)`.

```ts
export interface DataStoreConfig {
  /** Replacement transaction labels, per key. Keys left out keep their English defaults. */
  messages?: Partial<DataStoreMessages>;
  /** Custom-fields config, nested. */
  customFields?: {
    /** Field definitions, in column order. Default `[]` — the fields feature does nothing. */
    fields?: readonly CustomFieldDef[];
  };
}
```

| Field | Default | Semantics |
|---|---|---|
| `messages` | English defaults (table below) | per-key shallow override, resolved once at `setup()` |
| `customFields.fields` | `[]` | field definitions, in column order; entry drop rules: missing/duplicate key, unknown type, optionless select, unparsable formula → dropped silently |

All fields optional; invalid values fall back to defaults; config is read once at `setup()`.

The `customFields` nest omitted means the fields feature is dormant (service reports zero definitions) — the feature is opt-in.

## Messages

`DataStoreMessages` — the consolidated catalog. Exactly 14 keys (transaction labels, shown verbatim as `Transaction.label` in undo UI; plain strings, no builders; `""` is a legal value):

| Key | Default | Command |
|---|---|---|
| `taskMove` | `"Move task"` | `task/move` |
| `taskSetProgress` | `"Set progress"` | `task/setProgress` |
| `taskAdd` | `"Add task"` | `task/add` |
| `taskRemove` | `"Remove task"` | `task/remove` |
| `taskUpdate` | `"Update task"` | `task/update` |
| `linkAdd` | `"Add link"` | `link/add` |
| `linkUpdate` | `"Update link"` | `link/update` |
| `linkRemove` | `"Remove link"` | `link/remove` |
| `resourceAdd` | `"Add resource"` | `resource/add` |
| `resourceUpdate` | `"Update resource"` | `resource/update` |
| `resourceRemove` | `"Remove resource"` | `resource/remove` |
| `assignmentSet` | `"Assign resource"` | `assignment/set` |
| `assignmentRemove` | `"Remove assignment"` | `assignment/remove` |
| `historyApply` | `"Replay history"` | `history/apply` |

Key count: 14. `noneOption` (the select editor's empty choice) is deliberately **not** in this catalog: its single consumer is the select-column cell editor, which lives in tree-grid with the rest of the column machinery — `noneOption` is a `TreeGridMessages` key (see tree-grid.md). Error messages are hardcoded English (developer-facing, out of catalog scope).

## Internal modules

| Module | Content |
|---|---|
| `index.ts` | factory, service wiring, declaration merging (single `types.ts`-companion per plugin rule) |
| `types.ts` | public types |
| `store.ts` | entity store + indexes; publishes the 4 entity stores |
| `commands.ts` | the 14 command runners |
| `changes.ts` | change classification / burst assembly (drives the store sets) |
| `ops.ts` | patch apply/invert op table |
| `mapping.ts` | `FieldMapping` normalization for `load()` |
| `auto-summary.ts` | summary promotion (the Apply-flow invariant) |
| `order-key.ts` | `midKey` fractional indexing |
| `deferred.ts` | deferred-children buckets |
| `patch.ts` | `Patch` builders, `invertPatch(es)` |
| `fields.ts`, `ids.ts` | field-merge helpers (`mergeTaskUpdate`, `REQUIRED_TASK_FIELDS`), id minting |
| `internal/load.ts` | bulk-load steps, extracted so `index.ts` stays under the 800-line cap |
| `internal/custom-fields/definitions.ts` | definition resolution |
| `internal/custom-fields/values.ts` | storage model, `setValue(s)`, `displayValue` |
| `internal/custom-fields/formula.ts` | formula parser + evaluator (no `eval`, no `Function`) |

## Dependencies

None (bottom layer). Custom-field column supply is inverted: tree-grid consumes the `fields` service.

## Third-party surface

- **Consumable services:** `stargantt.data` (`DataService`) and `stargantt.fields` (`FieldsService`) — entity queries, load/serialize, the four per-entity store subscriptions, custom field definitions/values/formulas.
- **Commands:** all 14 data commands are public; third parties mutate data exclusively through them (command → reversible patch), gaining undo integration for free.
- **Contributable extension points:** none (this plugin defines none).
- **Subscribable events:** `data/willApplyTransaction` (pre-transaction hook; cancelable, appendable); `data/didApplyTransaction` (post-apply settle signal; final patch list).
- **Reserved namespaces (documentation convention only):** the `data/` event namespace; the `task/`, `link/`, `resource/`, `assignment/`, `history/` command namespaces; the `stargantt.data` / `stargantt.fields` service IDs. Not enforced in core.
- **`task.meta` bag:** third parties may write unclaimed `task.meta` keys freely and may reserve their own via `ctx.claimKey("task.meta", key)`; official claims of this plugin: `customFields`. (tree-grid claims `taskFields`, task-bars claims `color` — see their specs.)
