// docs/specs/plugins/data-sync.md §4
/**
 * The offline area: IndexedDB snapshots (§4.1), `restore()`/auto-save/auto-restore (§4.2), the
 * `storage/snapshot` extension point's wiring (§4.3, the walk itself lives in `document.ts`), and
 * the nest-gated read-only source adapter (§4.4). Every area enters through this `wire.ts`.
 *
 * The service is built unconditionally (defaults apply with no `offline` config nest at all —
 * an explicit `offline.save()` call still works against the global IndexedDB); only the §4.4
 * source-adapter auto-registration is gated on the nest's PRESENCE, not merely on its
 * `registerSource` field (which defaults `true` and would otherwise register the adapter even
 * with no nest supplied at all).
 */
import { collect } from "@stargantt/core";
import type { PluginContext } from "@stargantt/core";
import type { DataService } from "@stargantt/plugin-data-store";
import type { DataSyncConfig, OfflineArea, OfflineStorageResult, PersistedDocument, SnapshotContribution, SourceRegistry } from "../../types";
import { createPendingCounter, makeFault } from "../transactions";
import { offlineAdapter } from "./adapter";
import { applyContributions, asDocument, captureContributions, toDocument } from "./document";
import { idbDocumentStore } from "./idb";
import type { DocumentStore } from "./idb";

const DEFAULT_DATABASE = "stargantt-offline";
const DEFAULT_KEY = "default";
const DEFAULT_SOURCE = "offline";
const DEFAULT_DEBOUNCE_MS = 500;

export interface OfflineAreaDeps {
  ctx: PluginContext;
  data: DataService;
  config: DataSyncConfig["offline"];
  /** The source area's registry, for the §4.4 read-only adapter registration. */
  sources: SourceRegistry;
}

export function wireOffline(deps: OfflineAreaDeps): OfflineArea {
  const { ctx, data } = deps;
  const nest = deps.config;
  const nestSupplied = nest !== undefined && nest !== null && typeof nest === "object";
  const fault = makeFault(ctx);

  const databaseName = typeof nest?.databaseName === "string" && nest.databaseName !== "" ? nest.databaseName : DEFAULT_DATABASE;
  const documentKey = typeof nest?.documentKey === "string" && nest.documentKey !== "" ? nest.documentKey : DEFAULT_KEY;
  const configuredFactory = nest?.indexedDB;
  const factory: IDBFactory | undefined =
    configuredFactory !== undefined && typeof configuredFactory.open === "function"
      ? configuredFactory
      : (globalThis.indexedDB as IDBFactory | undefined);

  // §1 / §4.1 — without an IndexedDB implementation every operation quietly resolves `ok: false`
  // (no `core/pluginError`: an absent capability is degradation, not a fault).
  const store: DocumentStore | undefined = factory === undefined ? undefined : idbDocumentStore(factory, databaseName);
  // Checked in code paths that can run past teardown (`restoreInternal` in particular): a
  // disposed plugin must not go on to mutate the store from a still-settling read.
  let disposed = false;
  if (store !== undefined) {
    ctx.own({
      dispose: () => {
        disposed = true;
        store.close();
      },
    });
  }

  // §4.3 — the `storage/snapshot` extension point (collect).
  const snapshotPoint = ctx.defineExtensionPoint("storage/snapshot", collect<SnapshotContribution>());
  const contributions = (): readonly SnapshotContribution[] => snapshotPoint.get() ?? [];

  // §6.2 — the offline-area slice of the merged `sync/activity` counter.
  const counter = createPendingCounter<"save" | "restore" | "clear">();
  function activity(op: "save" | "restore" | "clear", delta: 1 | -1, cause: "manual" | "auto"): void {
    const pending = delta === 1 ? counter.inc(op) : counter.dec(op);
    ctx.emit("sync/activity", { area: "offline", op, cause, pending });
  }

  async function readDocument(): Promise<PersistedDocument | undefined> {
    if (store === undefined) return undefined;
    return asDocument(await store.read(documentKey));
  }

  async function saveInternal(cause: "manual" | "auto"): Promise<OfflineStorageResult> {
    if (store === undefined) return { ok: false };
    activity("save", 1, cause);
    try {
      // The whole path is guarded, `toJSON()` serialization included: the service promises to
      // resolve and never reject.
      let doc: PersistedDocument;
      try {
        doc = toDocument(data.toJSON(), Date.now(), captureContributions(contributions(), fault));
        await store.write(documentKey, doc);
      } catch (error) {
        fault("write", error);
        return { ok: false, error };
      }
      ctx.emit("sync/offlineSaved", { key: documentKey, tasks: doc.tasks.length });
      return { ok: true, tasks: doc.tasks.length };
    } finally {
      activity("save", -1, cause);
    }
  }

  const save = (): Promise<OfflineStorageResult> => saveInternal("manual");

  async function restoreInternal(cause: "manual" | "auto"): Promise<OfflineStorageResult> {
    if (store === undefined) return { ok: false };
    activity("restore", 1, cause);
    try {
      let doc: PersistedDocument | undefined;
      try {
        doc = asDocument(await store.read(documentKey));
      } catch (error) {
        fault("read", error);
        return { ok: false, error };
      }
      if (disposed) return { ok: false };
      if (doc === undefined) return { ok: false };
      // `asDocument` checks only the five-array shape; the rows themselves may still make the
      // store's `load()` throw — that failure must also resolve `ok: false`, not reject.
      try {
        data.load({
          tasks: doc.tasks,
          links: doc.links,
          resources: doc.resources,
          assignments: doc.assignments,
          calendars: doc.calendars,
        });
      } catch (error) {
        fault("restore", error);
        return { ok: false, error };
      }
      const restored = applyContributions(contributions(), doc.plugins, fault);
      ctx.emit("sync/offlineRestored", { key: documentKey, tasks: doc.tasks.length });
      return restored.length > 0
        ? { ok: true, tasks: doc.tasks.length, restored }
        : { ok: true, tasks: doc.tasks.length };
    } finally {
      activity("restore", -1, cause);
    }
  }

  const restore = (): Promise<OfflineStorageResult> => restoreInternal("manual");

  async function clear(): Promise<OfflineStorageResult> {
    if (store === undefined) return { ok: false };
    activity("clear", 1, "manual");
    try {
      try {
        await store.remove(documentKey);
      } catch (error) {
        fault("remove", error);
        return { ok: false, error };
      }
      ctx.emit("sync/offlineCleared", { key: documentKey });
      return { ok: true };
    } finally {
      activity("clear", -1, "manual");
    }
  }

  async function persisted(): Promise<boolean> {
    try {
      return (await readDocument()) !== undefined;
    } catch {
      return false;
    }
  }

  function available(): boolean {
    return store !== undefined;
  }

  const area: OfflineArea = { save, restore, clear, persisted, available };

  /* --- §4.4 the read-only source adapter, gated on the NEST'S PRESENCE ------------------------ */
  if (nestSupplied && nest.registerSource !== false) {
    const sourceName = typeof nest.sourceName === "string" && nest.sourceName !== "" ? nest.sourceName : DEFAULT_SOURCE;
    const readSafely = (): Promise<PersistedDocument | undefined> =>
      readDocument().catch((error: unknown) => {
        fault("read", error);
        return undefined;
      });
    deps.sources.register(sourceName, offlineAdapter(readSafely));
  }

  /* --- §4.2 debounced auto-save (opt-in; the hard `data` dependency needs no lifecycle/ready) -- */
  if (nest?.autoSave === true && store !== undefined) {
    const debounceMs =
      typeof nest.autoSaveDebounceMs === "number" && Number.isFinite(nest.autoSaveDebounceMs) && nest.autoSaveDebounceMs >= 0
        ? nest.autoSaveDebounceMs
        : DEFAULT_DEBOUNCE_MS;
    let timer: ReturnType<typeof setTimeout> | undefined;
    ctx.own({
      dispose: () => {
        if (timer !== undefined) clearTimeout(timer);
      },
    });
    const persist = (): void => {
      timer = undefined;
      void saveInternal("auto");
    };
    // Every `data.tasks` notification, unconditionally — the always-fired, always-last member of
    // the store burst AND the bulk-path signal too, so coverage equals the origin-blind
    // `data/tasksChanged` subscription (§4.2). No bulk detector needed here.
    ctx.own(
      data.tasks.subscribe(() => {
        if (timer !== undefined) clearTimeout(timer);
        // `0` starts the save immediately, on the SAME stack (recorded in §4.2):
        // `save()` only reads and dispatches nothing, so the store re-entrancy rule is untouched.
        if (debounceMs === 0) persist();
        else timer = setTimeout(persist, debounceMs);
      }),
    );
  }

  /* --- §4.2 autoRestore (deferred to lifecycle/ready) ------------------------------------------ */
  if (nest?.autoRestore === true && store !== undefined) {
    ctx.on("lifecycle/ready", () => {
      void restoreInternal("auto");
    });
  }

  return area;
}
