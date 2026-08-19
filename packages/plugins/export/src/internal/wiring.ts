// docs/specs/plugins/export.md §9 — the seam the six former-plugin areas are wired through.
/**
 * One bag every `wire*` entry point takes.
 *
 * `src/index.ts` builds this once and hands it to each area's `wire.ts`, which
 * returns the slice of `ExportService` that area owns. The areas are directory-exclusive, so
 * each of the four groups (`formats`, `msproject`, `excel`, `embed`) can be filled in without
 * touching this file, `../types.ts`, `../config.ts`, `./messages.ts`, or `../index.ts`.
 */
import type { PluginContext } from "@stargantt/core";
import type { DataService } from "@stargantt/plugin-data-store";
// Type-only (devDependency): brings view's `declare module` augmentation and its service types
// into the program without a runtime edge.
import type { ThemeService, TimelineService, ViewService } from "@stargantt/plugin-view";
import type { ResolvedConfig } from "../config";
import type { ExportMessages } from "./messages";

/** The plugin id, as stamped on `core/pluginError` and every disposed-instance error. */
export const PLUGIN_ID = "stargantt.export";

// Review m6 — the one message every facade member's disposed-instance check throws (`index.ts`'s
// image path, and all twelve `wire.ts` members across the four areas), so no call site hand-
// copies the literal.
export const DISPOSED_MESSAGE = `stargantt: "${PLUGIN_ID}" has been disposed`;

/** What every `wire*` entry point is handed. */
export interface ExportWiring {
  ctx: PluginContext;
  /** The normalized factory config; each area reads its own nest. */
  config: ResolvedConfig;
  /** The resolved 26-key catalog, shared by every area. */
  messages: ExportMessages;
  /** Hard dependency: the store behind every serializer, every extent, and the import applies. */
  data: DataService;
  /** Hard dependency: `renderTo`, `chartPaneElement()`, the layer canvases. */
  view: ViewService;
  /** Hard dependency (co-provided by view): t↔x, `unitBoundaries`, locale date formatting. */
  timeline: TimelineService;
  /** Hard dependency (co-provided by view): the print light-scheme pin. */
  theme: ThemeService;
  /** Reports a fault in host-supplied code through `core/pluginError`. */
  reportError(where: string, error: unknown): void;
  /** `true` once the plugin has been disposed; every area checks it before doing work. */
  disposed(): boolean;
}
