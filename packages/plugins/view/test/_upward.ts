/**
 * A probe for the points this package contributes *upward* to — currently just
 * `export/auxiliarySurfaces`, owned by `@stargantt/plugin-export` (Layer 8), which these suites
 * deliberately do not compose (`src/internal/upward.ts`'s structural-declaration note explains why
 * this package never depends on it, even as a devDependency).
 *
 * `export/auxiliarySurfaces` is not a key of this package's own `ExtensionPoints` type — only
 * `@stargantt/plugin-export`'s `declare module` merge adds it — so the point is defined through the
 * same narrow cast the contributing side (`src/internal/upward.ts`'s `contributeUpward`) uses,
 * mirroring the tree-grid `test/_upward.ts` precedent for `sidepanel/fields`.
 */
import { collect } from "@stargantt/core";
import type { PluginContext } from "@stargantt/core";
import type { AuxiliarySurfaceContribution } from "../src/internal/upward";

/**
 * Defines `export/auxiliarySurfaces` on `ctx` with its real `collect` merge strategy, and returns a
 * handle to the composed list.
 *
 * Call once per composition, from a probe plugin — defining the same point twice is a `core`-level
 * conflict like any other extension point.
 */
export function defineAuxiliarySurfacePoint(
  ctx: PluginContext,
): { get(): AuxiliarySurfaceContribution[] } {
  return (
    ctx.defineExtensionPoint as unknown as (
      key: string,
      reduce: (inputs: AuxiliarySurfaceContribution[]) => AuxiliarySurfaceContribution[],
    ) => { get(): AuxiliarySurfaceContribution[] }
  ).call(ctx, "export/auxiliarySurfaces", collect<AuxiliarySurfaceContribution>());
}
