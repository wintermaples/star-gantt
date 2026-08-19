// docs/specs/plugins/data-sync.md §5
/**
 * The realtime area: named `RealtimeTransport`s behind one registry, the message pipeline with
 * converge-exactly application + echo suppression (§5.1), the `realtime.status` store replacing
 * the abolished `realtime/statusChanged` event (§5.2), capped reconnection (§5.3), and resync
 * delegation into the source area (§5.4). Every area enters through this `wire.ts`.
 */
import { createStore } from "@stargantt/core";
import type { PluginContext } from "@stargantt/core";
import type { DataService } from "@stargantt/plugin-data-store";
import type {
  AppliedCounts,
  DataSyncConfig,
  RealtimeApplyResult,
  RealtimeArea,
  RealtimeChange,
  RealtimeConnection,
  RealtimeMessage,
  TransportRegistry,
} from "../../types";
import { makeFault, ORIGIN_REALTIME } from "../transactions";
import { planDelta } from "../tracker/delta";
import { ConnectionManager } from "./connection";
import type { ManagerOptions } from "./connection";

/** A narrow view of the source area (§5.4's internal delegation — never a `ctx.use()` between areas). */
export interface SourceSyncDelegate {
  active(): string | undefined;
  sync(): Promise<{ ok: boolean }>;
}

export interface RealtimeAreaDeps {
  ctx: PluginContext;
  data: DataService;
  config: DataSyncConfig["realtime"];
  source: SourceSyncDelegate;
}

function resolveNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback;
}

function parseMessage(value: unknown): RealtimeMessage | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const message = value as { type?: unknown; changes?: unknown };
  if (message.type === "resync") return { type: "resync" };
  if (message.type === "changes" && Array.isArray(message.changes)) {
    return { type: "changes", changes: message.changes as RealtimeChange[] };
  }
  return undefined;
}

export function wireRealtime(deps: RealtimeAreaDeps): RealtimeArea {
  const { ctx, data } = deps;
  const nest = deps.config;
  const fault = makeFault(ctx);
  const resyncViaDataSource = nest?.resyncViaDataSource !== false;

  // Checked in code paths that can run past teardown (a transport callback or a settling
  // resync): a disposed plugin must not dispatch store commands.
  let disposed = false;

  // §5.2 — replaces the abolished `realtime/statusChanged` event and the `status()`/
  // `connectedTransport()` readers one-for-one.
  const status = createStore<Readonly<RealtimeConnection>>({ status: "disconnected" });

  // §5.4 — resync coalescing: while a resync this plugin triggered is in flight, further resync
  // requests do not start a second concurrent sync(); at most one trailing rerun is queued, so a
  // burst of N requests yields the in-flight sync plus exactly one more, never N more.
  let resyncInFlight = false;
  let resyncTrailingRequested = false;

  function requestResync(): void {
    if (disposed) return;
    if (deps.source.active() === undefined) return;
    if (resyncInFlight) {
      resyncTrailingRequested = true;
      return;
    }
    resyncInFlight = true;
    // The outcome surfaces through the source area's own events/errors.
    void deps.source.sync().finally(() => {
      resyncInFlight = false;
      if (resyncTrailingRequested) {
        resyncTrailingRequested = false;
        requestResync();
      }
    });
  }

  function applyMessage(raw: unknown): RealtimeApplyResult {
    const none: AppliedCounts = { added: 0, updated: 0, removed: 0 };
    if (disposed) return { applied: none, resync: false };
    const message = parseMessage(raw);
    if (message === undefined) return { applied: none, resync: false };
    if (message.type === "resync") {
      if (resyncViaDataSource) requestResync();
      return { applied: none, resync: true };
    }
    // §5.1 — converge-exactly, with the `orderKey` exception and value-level echo suppression.
    const plan = planDelta(message.changes, data.query(), { preserveKey: "orderKey", suppressEcho: true });
    for (const task of plan.adds) ctx.dispatch("task/add", { task, origin: ORIGIN_REALTIME });
    for (const update of plan.updates) {
      ctx.dispatch("task/update", { id: update.id, after: update.after, clears: update.clears, origin: ORIGIN_REALTIME });
    }
    if (plan.removes.length > 0) ctx.dispatch("task/remove", { ids: plan.removes, origin: ORIGIN_REALTIME });
    const applied: AppliedCounts = {
      added: plan.adds.length,
      updated: plan.updates.length,
      removed: plan.removes.length,
    };
    const transport = manager.connectedTransport();
    ctx.emit("sync/realtimeApplied", { applied, ...(transport === undefined ? {} : { transport }) });
    return { applied, resync: false };
  }

  const managerOptions: ManagerOptions = {
    autoReconnect: nest?.autoReconnect !== false,
    reconnectDelayMs: resolveNumber(nest?.reconnectDelayMs, 1000),
    maxReconnectAttempts: resolveNumber(nest?.maxReconnectAttempts, 5),
  };

  const manager = new ConnectionManager(managerOptions, {
    onMessage: (message) => {
      // Application is our code but runs on a foreign-driven path; contain a throw so one bad
      // message never tears the connection down.
      try {
        applyMessage(message);
      } catch (error) {
        fault("apply", error);
      }
    },
    onStatus: (statusValue, cause, transport) => {
      status.set({ status: statusValue, cause, ...(transport === undefined ? {} : { transport }) });
    },
    onError: (where, error) => fault(where, error),
  });
  // The manager holds the single retry timer, the stability timer and the live transport session;
  // one owned disposable frees all three (re-arming swaps the manager's internal timer variables).
  ctx.own({
    dispose: () => {
      disposed = true;
      manager.dispose();
    },
  });

  const transports: TransportRegistry = {
    register: (name, transport) => manager.registerTransport(name, transport),
    names: () => manager.transports(),
  };

  const area: RealtimeArea = {
    transports,
    connect: (name) => manager.connect(name),
    disconnect: () => manager.disconnect(),
    status,
    applyMessage,
  };

  /* --- config: seed transports (unusable values silently ignored) ------------------------------ */
  const configuredTransports = nest?.transports;
  if (configuredTransports !== null && typeof configuredTransports === "object" && configuredTransports !== undefined) {
    for (const [name, transport] of Object.entries(configuredTransports)) manager.registerTransport(name, transport);
  }

  /* --- startup connect (deferred to lifecycle/ready — Config table recorded resolution) -------- */
  if (typeof nest?.connect === "string") {
    const name = nest.connect;
    ctx.on("lifecycle/ready", () => {
      manager.connect(name);
    });
  }

  return area;
}
