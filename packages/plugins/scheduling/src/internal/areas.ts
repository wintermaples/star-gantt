// docs/specs/plugins/scheduling.md §13 — the four internal areas.
/**
 * One bag every area's `wire*` entry point takes.
 *
 * The headless engine and the two `snap/*` contributions are built first; the four UI areas —
 * calendars, links, critical-path and diagnostics — build on top of them. Each area's entry
 * points exist as no-ops behind their configuration gates, so a later change fills a body in
 * `internal/<area>/wire.ts` and adds what it needs to `SchedulingAreaDeps` here, without touching
 * `index.ts`.
 *
 * The bag deliberately carries only what the engine and snap contributions can already resolve. A later area needing a service
 * this plugin does not consume yet (`stargantt.view`, `stargantt.task-bars`, the optional
 * `stargantt.rows` / `stargantt.selection` / `stargantt.focus` of §14) adds the member here and the
 * one `ctx.use` / `ctx.useOptional` line that fills it — plus the matching `dependsOn` entry, which
 * `expectDepsConsistency` pins.
 */
import type { PluginContext } from "@stargantt/core";
import type { DataService } from "@stargantt/plugin-data-store";
import type { ResolvedSchedulingConfig } from "../config";
import type { SchedulerService } from "../engine/service";
import type { CalendarRegistry } from "./calendars/registry";
import type { SchedulingMessages } from "./messages";

/** What every `wire*` entry point is handed. */
export interface SchedulingAreaDeps {
  /** This plugin's own context — claims, contributions, commands, ownership. */
  ctx: PluginContext;
  /** The whole resolved configuration; each area reads its own nest. */
  config: ResolvedSchedulingConfig;
  /** The resolved message catalog, shared by all four areas. */
  messages: SchedulingMessages;
  /** The data store (L1) — the one hard service dependency the engine needs. */
  data: DataService;
  /** The engine, as published under `stargantt.scheduler`. */
  scheduler: SchedulerService;
  /** The working-calendar registry (§1.2); empty until the calendars area wires its mutators. */
  calendars: CalendarRegistry;
  /** Reports a fault in host-supplied code through `core/pluginError`. */
  reportError(error: unknown): void;
}
