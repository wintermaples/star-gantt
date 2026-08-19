/**
 * `@stargantt/plugin-data-store` — id `stargantt.data-store`.
 *
 * `dependsOn: []`. Provides `stargantt.data` and `stargantt.fields`; owns the `task/*`, `link/*`,
 * `resource/*`, `assignment/*` and `history/*` commands. Defines and consumes no extension points.
 *
 * Pure logic: no DOM, no timers, no rendering.
 */
import { definePlugin } from "@stargantt/core";
import type { Cancelable, Plugin, PluginContext } from "@stargantt/core";
import {
  buildAssignmentRemove,
  buildAssignmentSet,
  buildLinkAdd,
  buildLinkRemove,
  buildLinkUpdate,
  buildResourceAdd,
  buildResourceRemove,
  buildResourceUpdate,
  buildTaskAdd,
  buildTaskMove,
  buildTaskRemove,
  buildTaskSetProgress,
  buildTaskUpdate,
} from "./commands";
import {
  Changes,
  classifyPatches,
  diffAgainstSnapshot,
  publishChanges,
  snapshotStore,
} from "./changes";
// The two non-type exports besides the factory: sibling plugins that replay or project this
// store's patches share its required-field set and its merge semantics instead of copying them.
export { REQUIRED_TASK_FIELDS, mergeTaskUpdate } from "./fields";
// The order-key arithmetic is published rather than re-implemented by every plugin that inserts a
// row between two others.
export { midKey } from "./order-key";
// The patch-inversion logic is published so sibling plugins that replay history (undo/redo above
// all) share this exact inverse instead of keeping a duplicate table that can drift from the
// store's own apply/invert pairing.
export { invertPatch, invertPatches } from "./patch";
import { deriveSummaryPromotions, normalizeSummaryTypes } from "./auto-summary";
import { DeferredChildren } from "./deferred";
import { IdGen } from "./ids";
import { resolveFields } from "./internal/custom-fields/definitions";
import {
  displayValueOf,
  isUsableValue,
  metaAfterEntries,
  metaWithValue,
  valueOfField,
} from "./internal/custom-fields/values";
import {
  loadAssignments,
  loadCalendars,
  loadLinks,
  loadResources,
  loadTasks,
  parkDeferred,
} from "./internal/load";
import { asRawMapping } from "./mapping";
import { Store, createDataStores } from "./store";
import type {
  CustomFieldDef,
  CustomFieldValue,
  CustomFieldValueEntry,
  DataService,
  FieldMapping,
  FieldsService,
  Link,
  LinkId,
  LinkType,
  LoadInput,
  Patch,
  Resource,
  ResourceId,
  Task,
  TaskId,
  Transaction,
} from "./types";

export type {
  Assignment,
  CalendarDef,
  CalendarId,
  ConstraintType,
  CustomFieldDef,
  CustomFieldType,
  CustomFieldValue,
  CustomFieldValueEntry,
  DataService,
  FieldMapping,
  FieldsService,
  Link,
  LinkId,
  LinkType,
  LoadInput,
  Patch,
  ReadonlyDataView,
  Resource,
  ResourceId,
  ResolvedCustomField,
  Task,
  TaskId,
  Transaction,
} from "./types";

declare module "@stargantt/core" {
  interface Services {
    "stargantt.data": DataService;
    "stargantt.fields": FieldsService;
  }
  interface Events {
    // docs/specs/plugins/data-store.md — Apply flow (normative).
    /**
     * Emitted before a transaction is applied. Cancelable via `preventDefault()`; handlers may
     * also append their own patches to `transaction.patches`, which are applied in the same
     * atomic step and undone as part of the same history entry.
     */
    "data/willApplyTransaction": Cancelable & { transaction: Transaction };
    // docs/specs/plugins/data-store.md — Apply flow (normative) / Events.
    /**
     * Emitted once per applied transaction, immediately after its store burst, carrying the
     * transaction with its **final** patch list (will-phase appends and summary promotion
     * included). Never fires for a transaction cancelled in the will phase, one whose atomic
     * apply throws, an empty-patch no-op, or a bulk path (`load()` / `materializeChildren()`).
     * The authoritative settle signal for transaction consumers (undo-redo records from this,
     * not from `data/willApplyTransaction` — see undo-redo.md §Recording).
     */
    "data/didApplyTransaction": { transaction: Transaction };
  }
  interface Commands {
    "task/move": {
      id: TaskId;
      start: number;
      end: number;
      /**
       * Groups this command with other commands sharing the same key into one undo-history entry.
       * Consecutive commands whose payload carries the same `coalesceKey` are merged into the
       * immediately preceding history entry instead of creating a new one — a drag gesture mints
       * one key per gesture so a whole drag undoes in a single step. Omitted means the resulting
       * change never merges with anything.
       */
      coalesceKey?: string;
    };
    "task/setProgress": {
      id: TaskId;
      progress: number;
      /**
       * Groups this command with other commands sharing the same key into one undo-history entry.
       * Consecutive commands whose payload carries the same `coalesceKey` are merged into the
       * immediately preceding history entry instead of creating a new one — a drag gesture mints
       * one key per gesture so a whole drag undoes in a single step. Omitted means the resulting
       * change never merges with anything.
       */
      coalesceKey?: string;
    };
    "task/add": {
      task: Partial<Task> & { name: string };
      index?: number;
      /** Provenance stamped on the resulting transaction. Defaults to `"user"`. */
      origin?: string;
    };
    "task/remove": {
      ids: TaskId[];
      /** Provenance stamped on the resulting transaction. Defaults to `"user"`. */
      origin?: string;
    };
    "task/update": {
      id: TaskId;
      after: Partial<Task>;
      /**
       * Task fields to delete outright, applied after `after` is assigned. Use this to restore a
       * previously-set optional field (`progress`, `constraint`, `meta`, …) to fully absent —
       * simply leaving a key out of `after` only means "leave its current value unchanged", which
       * cannot express "unset it". A key named here that is also present in `after` is treated as
       * an `after` assignment; unknown keys, and keys the task does not currently carry, are
       * ignored; `id` can never be cleared.
       */
      clears?: readonly (keyof Task)[];
      /** Provenance stamped on the resulting transaction. Defaults to `"user"`. */
      origin?: string;
    };
    "link/add": {
      sourceId: TaskId;
      targetId: TaskId;
      type: LinkType;
      /**
       * Lag in milliseconds; negative is a lead. `0` is equivalent to omitting it — the stored
       * link carries no lag field, since a zero lag and an absent one describe the same
       * dependency. A non-finite value (`NaN`, `Infinity`) is likewise dropped: the link is
       * created without a lag.
       */
      lag?: number;
      /**
       * Identity to create the link under. Normally omitted, in which case one is generated;
       * supplying it re-creates a link under an identity it already had, which is what restoring
       * a previously removed link needs. An id that is already in use creates nothing.
       */
      id?: LinkId;
      /** Provenance stamped on the resulting transaction. Defaults to `"user"`. */
      origin?: string;
    };
    /**
     * Retypes and/or re-lags one existing link, keeping its id and its endpoints — the whole edit
     * is one transaction, so it takes exactly one undo step.
     *
     * Each of `type` and `lag` is optional and, when omitted, leaves that side of the link alone.
     * `lag: 0` removes the lag (a zero lag and no lag describe the same dependency). An `id` that
     * names no link, a non-finite `lag`, and a payload that would change nothing all leave the
     * store untouched and produce no history entry.
     */
    "link/update": {
      id: LinkId;
      type?: LinkType;
      /** Lag in milliseconds; negative is a lead, `0` removes the lag. */
      lag?: number;
      /** Provenance stamped on the resulting transaction. Defaults to `"user"`. */
      origin?: string;
    };
    /** Deletes dependency links by id. An id that names no link is ignored. */
    "link/remove": {
      ids: LinkId[];
      /** Provenance stamped on the resulting transaction. Defaults to `"user"`. */
      origin?: string;
    };
    "resource/add": {
      /**
       * The resource to create. `id` is normally omitted, in which case one is generated;
       * supplying it re-creates a resource under an identity it already had, which is what
       * restoring a previously removed resource needs. An id that is already in use creates
       * nothing.
       */
      resource: Partial<Resource> & { name: string };
      /** Provenance stamped on the resulting transaction. Defaults to `"user"`. */
      origin?: string;
    };
    "resource/update": {
      id: ResourceId;
      after: Partial<Resource>;
      /** Provenance stamped on the resulting transaction. Defaults to `"user"`. */
      origin?: string;
    };
    /**
     * Deletes resources by id, together with every assignment of the removed resources. An id
     * that names no resource is ignored.
     */
    "resource/remove": {
      ids: ResourceId[];
      /** Provenance stamped on the resulting transaction. Defaults to `"user"`. */
      origin?: string;
    };
    /**
     * Upsert: creates the (taskId, resourceId) assignment or updates its `units`. A `units` that
     * is not a finite number greater than zero, or an endpoint that does not exist, changes
     * nothing.
     */
    "assignment/set": {
      taskId: TaskId;
      resourceId: ResourceId;
      units: number;
      /** Provenance stamped on the resulting transaction. Defaults to `"user"`. */
      origin?: string;
    };
    /** Deletes one assignment by its composite key. A pair that names no assignment is ignored. */
    "assignment/remove": {
      taskId: TaskId;
      resourceId: ResourceId;
      /** Provenance stamped on the resulting transaction. Defaults to `"user"`. */
      origin?: string;
    };
    /**
     * Applies an ordered list of patches as a single transaction, exactly as given: no patch is
     * rebuilt from a command payload, and no builder re-validates it against the current store
     * state. Intended for replaying a previously recorded patch list (an undo/redo history entry
     * above all) in one atomic step rather than one command dispatch per patch.
     */
    "history/apply": {
      patches: readonly Patch[];
      /** Provenance stamped on the resulting transaction. Defaults to `"history"`, unlike every
       * other command here (which defaults to `"user"`) — this command exists to replay, not to
       * originate, a change. */
      origin?: string;
    };
  }
}

/**
 * The label each command stamps on the transaction it produces.
 *
 * Labels are user-visible: an undo UI shows them to name the step it would take back. One member
 * per command the store owns; each is used verbatim as `Transaction.label`.
 */
export interface DataStoreMessages {
  /** `task/move`. Default `"Move task"`. */
  taskMove: string;
  /** `task/setProgress`. Default `"Set progress"`. */
  taskSetProgress: string;
  /** `task/add`. Default `"Add task"`. */
  taskAdd: string;
  /** `task/remove`. Default `"Remove task"`. */
  taskRemove: string;
  /** `task/update`. Default `"Update task"`. */
  taskUpdate: string;
  /** `link/add`. Default `"Add link"`. */
  linkAdd: string;
  /** `link/update`. Default `"Update link"`. */
  linkUpdate: string;
  /** `link/remove`. Default `"Remove link"`. */
  linkRemove: string;
  /** `resource/add`. Default `"Add resource"`. */
  resourceAdd: string;
  /** `resource/update`. Default `"Update resource"`. */
  resourceUpdate: string;
  /** `resource/remove`. Default `"Remove resource"`. */
  resourceRemove: string;
  /** `assignment/set`. Default `"Assign resource"`. */
  assignmentSet: string;
  /** `assignment/remove`. Default `"Remove assignment"`. */
  assignmentRemove: string;
  /** `history/apply`. Default `"Replay history"`. */
  historyApply: string;
}

// docs/specs/plugins/data-store.md — Messages: the normative default table.
const DEFAULT_MESSAGES: DataStoreMessages = {
  taskMove: "Move task",
  taskSetProgress: "Set progress",
  taskAdd: "Add task",
  taskRemove: "Remove task",
  taskUpdate: "Update task",
  linkAdd: "Add link",
  linkUpdate: "Update link",
  linkRemove: "Remove link",
  resourceAdd: "Add resource",
  resourceUpdate: "Update resource",
  resourceRemove: "Remove resource",
  assignmentSet: "Assign resource",
  assignmentRemove: "Remove assignment",
  historyApply: "Replay history",
};

/** Per-key shallow override; a member that is not a string (including `undefined`) is ignored. */
function resolveMessages(overrides: Partial<DataStoreMessages> | undefined): DataStoreMessages {
  const resolved = { ...DEFAULT_MESSAGES };
  if (overrides === null || typeof overrides !== "object") return resolved;
  for (const key of Object.keys(DEFAULT_MESSAGES) as (keyof DataStoreMessages)[]) {
    const value = overrides[key];
    if (typeof value === "string") resolved[key] = value;
  }
  return resolved;
}

// docs/specs/plugins/data-store.md — Config.
/**
 * Options for the data-store plugin.
 *
 * Initial data is loaded through the `stargantt.data` service, not through this object.
 */
export interface DataStoreConfig {
  /**
   * Replacement transaction labels, per key. Keys left out keep their English defaults.
   */
  messages?: Partial<DataStoreMessages>;
  /** Former custom-fields config, nested. */
  customFields?: {
    /** Field definitions, in column order. Default `[]` — the fields feature does nothing. */
    fields?: readonly CustomFieldDef[];
  };
}

const FIELDS_META_KEY = "customFields";
// The batch's first task's patch lands as an ordinary task/update stamped with this origin, and
// the `data/willApplyTransaction` handler recognizes it and appends the remaining tasks' patches
// to the same transaction (the appendable-transaction mechanism `run()`'s will-event supports).
const SET_VALUES_ORIGIN = "stargantt.data-store/setValues";

/**
 * Creates the data-store plugin: it holds the tasks, links, resources and assignments, applies
 * every change as one reversible transaction, and provides the user-defined custom-fields
 * service alongside it.
 *
 * Configurable plugins are exported as factories because the host passes no per-plugin config to
 * `setup()`: any configuration is closed over here and the produced plugin itself takes `void`.
 */
export function dataStore(config?: DataStoreConfig): Plugin<void> {
  // Every official plugin is a factory taking a typed, optional config object. The object is
  // snapshotted so a later mutation by the caller cannot change the plugin's behavior.
  const snapshot: DataStoreConfig = { ...config };
  return definePlugin<void>({
    meta: { id: "stargantt.data-store", dependsOn: [] },
    setup: (ctx: PluginContext): void => setup(ctx, snapshot),
  });
}

function setup(ctx: PluginContext, config: DataStoreConfig): void {
  // Resolved once, at setup(); `config.messages` is not re-read afterwards.
  const messages = resolveMessages(config.messages);

  const store = new Store();
  const ids = new IdGen();
  // Deferred-children buckets, parked at load() and materialized on demand through the service.
  const deferred = new DeferredChildren();
  // docs/specs/plugins/data-store.md — Services (Store snapshot semantics): the four per-entity
  // stores this plugin publishes.
  const stores = createDataStores(store);

  /**
   * Apply flow: build the transaction, run the will-event, apply it atomically, then publish the
   * store burst. Building the patch list is the caller's job.
   */
  const run = (label: string, patches: Patch[], origin?: string, coalesceKey?: string): void => {
    if (patches.length === 0) return;

    const transaction: Transaction = {
      id: ids.nextTransactionId(),
      label,
      patches,
      // A command may name the provenance of the change it makes. Anything dispatched without one
      // is a direct user edit, which is what `origin` meant before commands could carry it and
      // what plugins reacting to user edits still key off.
      origin: origin ?? "user",
    };
    // Stamped verbatim onto the transaction when the payload carries one; the store never merges
    // anything itself — merging a new history entry into the immediately preceding one iff both
    // carry the same key is undo-redo's contract.
    // `exactOptionalPropertyTypes` — omit the key rather than assign `undefined`.
    if (coalesceKey !== undefined) transaction.coalesceKey = coalesceKey;

    let canceled = false;
    const event: Cancelable & { transaction: Transaction } = {
      transaction,
      preventDefault(): void {
        canceled = true;
      },
    };
    ctx.emit("data/willApplyTransaction", event);
    if (canceled) return;
    // will-handlers may have appended patches (auto-schedule, custom-fields' setValues) — re-read
    // the final list.
    if (transaction.patches.length === 0) return;

    // The summary invariant. Derived from the *final* patch list (so a child appended by a
    // will-handler also promotes its parent) and appended to the same transaction, so one undo
    // takes the promotion back too.
    transaction.patches.push(...deriveSummaryPromotions(store, transaction.patches));

    store.applyTransaction(transaction);
    // docs/specs/plugins/data-store.md — Notification order per apply: classified after the
    // apply, so a patch carrying only its changed fields can read the whole entity back out of the
    // store; the burst publishes the domains that changed before `tasks`, always last.
    publishChanges(stores, classifyPatches(transaction.patches, store), store);
    // The settle signal: only reached when `applyTransaction` above did not throw, so it never
    // fires for a failed apply either. Same stack, same synchronous dispatch as the burst — a
    // nested dispatch from a will-handler (above) has already settled (its own burst + this event)
    // by the time control returns here, so nested transactions settle inner-first.
    ctx.emit("data/didApplyTransaction", { transaction });
  };

  const data: DataService = {
    getTask(id) {
      return store.byId.get(id);
    },
    taskIds() {
      return store.byId.keys();
    },
    query() {
      return store.query();
    },
    /**
     * The bootstrap path — replaces the store contents and then publishes every store whose
     * contents changed, `tasks` always last and always, whether or not any task entry itself
     * changed. Not a command, so it produces no transaction and is not undoable.
     */
    load<TRaw = unknown>(raw: TRaw[] | LoadInput<TRaw>, mapping?: FieldMapping<TRaw>) {
      // The classification of a bulk path is a diff, there being no patches to read it from;
      // taken before `clear()`, entities included, since a dropped row is unreachable after.
      const before = snapshotStore(store);
      store.clear();

      // The bare-array form stays "tasks (and inline links)"; the object form additionally
      // carries links / resources / assignments / calendars.
      const input: LoadInput<TRaw> = Array.isArray(raw) ? { tasks: raw } : raw;
      const m = asRawMapping(mapping);

      const inlineLinks = loadTasks(store, ids, input.tasks, m);
      loadLinks(store, ids, input.links ?? [], m, inlineLinks);
      loadResources(store, ids, input.resources ?? [], m);
      loadAssignments(store, input.assignments ?? [], m);
      loadCalendars(store, input.calendars ?? []);
      // The load is a bootstrap path with no transaction, so the summary invariant is restored by
      // writing the types directly. Scanning the whole store once is cheaper at bootstrap than
      // threading a parent set through every loader step.
      normalizeSummaryTypes(store, [...store.byId.keys()]);
      // Every pending bucket of the previous load is dropped, then this load's are parked.
      deferred.reset(m);
      parkDeferred(deferred, input.deferredTasks ?? []);

      publishChanges(stores, diffAgainstSnapshot(before, store), store);
    },
    hasDeferredChildren(id) {
      return deferred.has(id);
    },
    materializeChildren(id) {
      const changed = deferred.materialize(store, ids, id);
      // Like `load()`, this is a bootstrap path: no transaction, so no undo entry.
      if (changed !== undefined && changed.size > 0) {
        // The parent has children now, so its row's paint changes with its type; promoting it is
        // what makes that repaint happen through the `tasks` store.
        normalizeSummaryTypes(store, [id]);
        // Only the `tasks` domain changed here — no link, resource or assignment was touched — so
        // the burst is exactly one `set()`.
        const changes = new Changes();
        for (const created of changed) changes.task("added", created);
        changes.task("updated", id);
        publishChanges(stores, changes, store);
      }
    },
    toJSON() {
      return {
        tasks: [...store.byId.values()],
        links: [...store.links()],
        calendars: [...store.calendars.values()],
        resources: [...store.resources.values()],
        assignments: [...store.assignments()],
      };
    },
    tasks: stores.tasks,
    links: stores.links,
    resources: stores.resources,
    assignments: stores.assignments,
  };

  ctx.provide("stargantt.data", data);

  ctx.registerCommand("task/move", (p) =>
    run(messages.taskMove, buildTaskMove(store, p), undefined, p.coalesceKey),
  );
  ctx.registerCommand("task/setProgress", (p) =>
    run(messages.taskSetProgress, buildTaskSetProgress(store, p), undefined, p.coalesceKey),
  );
  ctx.registerCommand("task/add", (p) =>
    run(messages.taskAdd, buildTaskAdd(store, p, ids), p.origin),
  );
  ctx.registerCommand("task/remove", (p) =>
    run(messages.taskRemove, buildTaskRemove(store, p), p.origin),
  );
  ctx.registerCommand("task/update", (p) =>
    run(messages.taskUpdate, buildTaskUpdate(store, p), p.origin),
  );
  ctx.registerCommand("link/add", (p) =>
    run(messages.linkAdd, buildLinkAdd(store, p, ids), p.origin),
  );
  ctx.registerCommand("link/update", (p) =>
    run(messages.linkUpdate, buildLinkUpdate(store, p), p.origin),
  );
  ctx.registerCommand("link/remove", (p) =>
    run(messages.linkRemove, buildLinkRemove(store, p), p.origin),
  );
  ctx.registerCommand("resource/add", (p) =>
    run(messages.resourceAdd, buildResourceAdd(store, p, ids), p.origin),
  );
  ctx.registerCommand("resource/update", (p) =>
    run(messages.resourceUpdate, buildResourceUpdate(store, p), p.origin),
  );
  ctx.registerCommand("resource/remove", (p) =>
    run(messages.resourceRemove, buildResourceRemove(store, p), p.origin),
  );
  ctx.registerCommand("assignment/set", (p) =>
    run(messages.assignmentSet, buildAssignmentSet(store, p), p.origin),
  );
  ctx.registerCommand("assignment/remove", (p) =>
    run(messages.assignmentRemove, buildAssignmentRemove(store, p), p.origin),
  );
  // The patch list rides straight into `run()`, no builder in between: this command is the
  // batch-replay channel, not an ordinary edit.
  ctx.registerCommand("history/apply", (p) =>
    run(messages.historyApply, [...p.patches], p.origin ?? "history"),
  );

  /* -------------------------------------------------------------- *
   * `stargantt.fields` — former `@stargantt/plugin-custom-fields`,
   * merged in (docs/specs/plugins/data-store.md — Services).
   * -------------------------------------------------------------- */

  // docs/specs/plugins/data-store.md — `task.meta` bag: this plugin's one reserved key.
  ctx.claimKey("task.meta", FIELDS_META_KEY);

  const fields = resolveFields(config.customFields?.fields);
  const fieldsByKey = new Map(fields.map((f) => [f.key, f]));

  /* --- setValues: one transaction for many writes --- */

  // The batch's first task's patch lands as an ordinary task/update stamped with
  // SET_VALUES_ORIGIN, and this handler appends the remaining tasks' patches to the same
  // transaction (the appendable-handler path `run()` supports). No re-entrancy flag needed: the
  // handler keys on the transaction's origin, a `cause` carried by the data itself.
  let pendingSetValuesPatches: Patch[] | undefined;
  ctx.on("data/willApplyTransaction", (e) => {
    if (e.transaction.origin !== SET_VALUES_ORIGIN || pendingSetValuesPatches === undefined) {
      return;
    }
    const patches = pendingSetValuesPatches;
    pendingSetValuesPatches = undefined;
    for (const patch of patches) e.transaction.patches.push(patch);
  });

  interface PendingWrite {
    readonly key: string;
    readonly value: CustomFieldValue | undefined;
  }

  /** Groups the usable entries by task, in first-appearance order, each task's writes in order. */
  function groupEntries(
    entries: readonly CustomFieldValueEntry[],
  ): Map<TaskId, { task: Task; writes: PendingWrite[] }> {
    const groups = new Map<TaskId, { task: Task; writes: PendingWrite[] }>();
    for (const entry of entries) {
      if (entry === null || typeof entry !== "object") continue;
      const { id, key, value } = entry;
      const field = fieldsByKey.get(key);
      if (field === undefined || field.type === "formula") continue;
      if (value !== undefined && !isUsableValue(field, value)) continue;
      let group = groups.get(id);
      if (group === undefined) {
        const task = data.getTask(id);
        if (task === undefined) continue;
        group = { task, writes: [] };
        groups.set(id, group);
      }
      group.writes.push({ key, value });
    }
    return groups;
  }

  interface Piece {
    readonly id: TaskId;
    readonly before: Partial<Task>;
    readonly after: Partial<Task>;
    readonly clears?: readonly (keyof Task)[];
  }

  /** One task's merged patch pieces, built the same way `setValue`'s single-entry patch is. */
  function pieceFor(id: TaskId, group: { task: Task; writes: PendingWrite[] }): Piece {
    const meta = metaAfterEntries(group.task, group.writes);
    const before: Partial<Task> = {};
    if (group.task.meta !== undefined) before.meta = group.task.meta;
    // An empty `meta` is removed via `clears`, exactly as the single-entry `setValue` path does.
    if (meta === undefined) return { id, before, after: {}, clears: ["meta"] };
    return { id, before, after: { meta } };
  }

  function setValues(entries: readonly CustomFieldValueEntry[]): void {
    if (!Array.isArray(entries) || entries.length === 0) return;
    const groups = groupEntries(entries);
    if (groups.size === 0) return;

    const pieces = [...groups].map(([id, group]) => pieceFor(id, group));
    const [head, ...rest] = pieces;
    if (head === undefined) return;

    pendingSetValuesPatches = rest.map((p) => ({
      op: "task/update",
      id: p.id,
      before: p.before,
      after: p.after,
      ...(p.clears !== undefined ? { clears: p.clears } : {}),
    }));
    try {
      ctx.dispatch("task/update", {
        id: head.id,
        after: head.after,
        ...(head.clears !== undefined ? { clears: head.clears } : {}),
        origin: SET_VALUES_ORIGIN,
      });
    } finally {
      pendingSetValuesPatches = undefined;
    }
  }

  /* --- the service ----------------------------------------------------- */

  const fieldsService: FieldsService = {
    definitions: () => fields,
    valueOf(id, key) {
      const field = fieldsByKey.get(key);
      return field === undefined ? undefined : valueOfField(field, data.getTask(id), fieldsByKey);
    },
    setValue(id, key, value) {
      const field = fieldsByKey.get(key);
      if (field === undefined || field.type === "formula") return;
      const task = data.getTask(id);
      if (task === undefined) return;
      if (value !== undefined && !isUsableValue(field, value)) return;
      const meta = metaWithValue(task, field.key, value);
      // An empty `meta` is removed via `clears`.
      if (meta === undefined) ctx.dispatch("task/update", { id, after: {}, clears: ["meta"] });
      else ctx.dispatch("task/update", { id, after: { meta } });
    },
    setValues,
    displayValue(id, key) {
      const field = fieldsByKey.get(key);
      return field === undefined ? "" : displayValueOf(field, data.getTask(id), fieldsByKey);
    },
  };
  ctx.provide("stargantt.fields", fieldsService);

  // Every resource the plugin holds is registered with the core, which owns disposal.
  ctx.own({
    dispose(): void {
      store.clear();
      deferred.reset();
    },
  });
}
