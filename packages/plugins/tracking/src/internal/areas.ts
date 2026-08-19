// docs/specs/plugins/tracking.md §7 — one bag every area's `wire*` entry point takes, mirroring
// `@stargantt/plugin-scheduling`'s `internal/areas.ts` convention.
//
// §7 puts all five `claimKey` calls and all three `claimOrder` calls at the ROOT (`index.ts`), not
// distributed into each area the way scheduling's critical-path/links areas claim their own layer
// orders. So an area's `wire*` function never calls `ctx.claimOrder` itself — it receives the
// already-claimed layer id/order (see `./shared/layer-ids.ts`) and only `ctx.contribute`s under it.
import type { PluginContext } from "@stargantt/core";
import type { DataService } from "@stargantt/plugin-data-store";
import type { ResolvedTrackingConfig } from "../config";
import type { TrackingMessages } from "./messages";

/** What every `wire*` entry point is handed. */
export interface TrackingAreaDeps {
  /** This plugin's own context — contributions, commands, ownership. Claims are root-only (§7). */
  ctx: PluginContext;
  /** The whole resolved configuration; each area reads its own nest (possibly `undefined` — the
   *  nest's SERVICE is still built unconditionally; only its visuals/panels are nest-gated). */
  config: ResolvedTrackingConfig;
  /** The resolved message catalog, shared by all four areas. */
  messages: TrackingMessages;
  /** The data store (L1) — the one hard service dependency (§8). */
  data: DataService;
  /** The current instant, epoch ms. Indirected for tests (`internal/shared/status-date.ts`'s
   *  "current UTC day" fallbacks all thread through this rather than calling `Date.now()` themselves). */
  now(): number;
  /** Reports a fault in host-supplied code through `core/pluginError`, tagged with `where`
   *  (`"formulas.<id>"`, `"renderPanel"`, `"method"`, `"eacMethod"`, per §2.12/§2.13/§2.15). */
  reportError(where: string, error: unknown): void;
}
