// A memoized accessor for an optional service that may resolve after setup (docs/specs/sdk.md,
// Module: sdk/frame).
import type { Services } from "@stargantt/core";

/** The one member of `PluginContext` this helper reads, kept narrow so it is unit-testable. */
export interface LateServiceContext {
  useOptional<K extends keyof Services>(key: K): Services[K] | undefined;
}

/**
 * A memoized accessor for an optional service that may be provided *after* this plugin's setup.
 *
 * Each call of the returned function retries `ctx.useOptional(id)` until the service resolves,
 * then caches the resolved instance and returns it for the rest of the plugin's life without
 * asking the registry again. Use it for a soft dependency read on a hot path (a paint, a pointer
 * handler): the lookup cost is paid until the provider appears and never after.
 *
 * @example
 * ```ts
 * const theme = lateService(ctx, "stargantt.theme");
 * const color = (token: string) => theme()?.get(token) ?? "";
 * ```
 */
export function lateService<K extends keyof Services>(
  ctx: LateServiceContext,
  id: K,
): () => Services[K] | undefined {
  let resolved: Services[K] | undefined;
  return () => {
    resolved ??= ctx.useOptional(id);
    return resolved;
  };
}
