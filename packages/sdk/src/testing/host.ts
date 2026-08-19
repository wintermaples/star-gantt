/**
 * `createTestHost` — boots a real `@stargantt/core` instance around a chosen plugin set, in a test
 * DOM or headless, and hands back a handle for driving and inspecting it.
 *
 * Only public core surface is used (`Gantt.create`, `PluginContext`, `AnyPlugin`) — nothing here
 * reaches into `@stargantt/core/internal`. Two facilities the public API does not offer directly
 * are synthesized on top of it, both through plain plugin wrapping (no back-door API, per
 * `architecture.md` chapter 8):
 *
 * - `ctxOf(pluginId)` — every registered plugin's `setup()` is wrapped so its real `PluginContext`
 *   is captured into a map before delegating to the plugin's own `setup()`.
 * - `services` mock injection — when supplied, one synthetic provider plugin is registered
 *   alongside the real ones (`ctx.provide()` for each mock entry), and every other registered
 *   plugin is transparently given a hard dependency on it, so `ctx.use()` of a mocked key resolves
 *   without the caller having to know about the synthetic id. The mock provider has no
 *   dependencies of its own, so it always resolves in the earliest topological tier: mocks are
 *   guaranteed to be visible to every consumer, and they fill gaps unconditionally. Because every
 *   other registered plugin depends on it, the mock provider necessarily runs *before* them — so
 *   when a real plugin registered in the same host also provides the same key, the real plugin's
 *   later `ctx.provide()` call overwrites the mock for that key (last write to the registry wins).
 *   This is a deliberate, documented choice: unconditional override of an already-registered real
 *   provider is not achievable from a single dependency graph without risking a cycle whenever one
 *   plugin is simultaneously a real provider and a mock consumer.
 */
import { Gantt } from "@stargantt/core";
import type { AnyPlugin, GanttInstance, PluginContext, PluginMeta, Services } from "@stargantt/core";
import { headlessElement } from "./element";

/** Options for {@link createTestHost}. */
export interface CreateTestHostOptions {
  /** The plugin set to boot, in registration order. */
  plugins: readonly AnyPlugin[];
  /**
   * The chart root element. Omit it to boot headless — no view plugin can paint into anything a
   * layout query would see. When a DOM is available (`document` is defined, e.g. under a
   * `happy-dom`/`jsdom` vitest environment) a detached `<div>` is used so basic DOM operations still
   * work; otherwise a plain object stands in, exactly as `@stargantt/core`'s own tests do — the core
   * only ever references `HTMLElement` as a type.
   */
  element?: HTMLElement;
  /**
   * Mock service implementations, keyed by service id, made available to every plugin in
   * `plugins` regardless of its own `dependsOn` declaration.
   */
  services?: Record<string, unknown>;
}

/** The handle {@link createTestHost} returns. */
export interface TestHost {
  /** The real `GanttInstance` this test host booted — `dispatch`/`on`/`service`/`orders`. */
  host: GanttInstance;
  /** The real `PluginContext` handed to the named plugin's `setup()`. Throws if it never ran. */
  ctxOf(pluginId: string): PluginContext;
  /** Tears the host down (`host.dispose()`). Idempotent, as `GanttInstance.dispose()` is. */
  dispose(): void;
}

const MOCK_PROVIDER_ID = "@stargantt/sdk/testing:mock-services";

/** Boots a real core with `opts.plugins` and returns the driving/inspection handle. */
export function createTestHost(opts: CreateTestHostOptions): TestHost {
  const contexts = new Map<string, PluginContext>();
  const hasMocks = opts.services !== undefined && Object.keys(opts.services).length > 0;

  const plugins: AnyPlugin[] = opts.plugins.map((plugin) =>
    captureContext(plugin, contexts, hasMocks ? MOCK_PROVIDER_ID : undefined),
  );
  if (hasMocks) plugins.push(mockProviderPlugin(opts.services!));

  const element = opts.element ?? headlessElement();
  const host = Gantt.create({ element, plugins });

  return {
    host,
    ctxOf(pluginId: string): PluginContext {
      const ctx = contexts.get(pluginId);
      if (ctx === undefined) {
        throw new Error(`createTestHost: no plugin "${pluginId}" was registered (or it never ran)`);
      }
      return ctx;
    },
    dispose(): void {
      host.dispose();
    },
  };
}

/** Wraps `plugin` so its real `setup()` context is captured, and optionally hard-depends on `mockProviderId`. */
function captureContext(
  plugin: AnyPlugin,
  contexts: Map<string, PluginContext>,
  mockProviderId: string | undefined,
): AnyPlugin {
  const meta: PluginMeta =
    mockProviderId === undefined
      ? plugin.meta
      : { ...plugin.meta, dependsOn: [...(plugin.meta.dependsOn ?? []), mockProviderId] };
  return {
    meta,
    setup(ctx, config) {
      contexts.set(plugin.meta.id, ctx);
      return plugin.setup(ctx, config);
    },
  };
}

/**
 * A synthetic provider plugin that publishes every mock service entry under its own plugin id.
 *
 * No `order` is set: it has no `dependsOn` of its own, and every other registered plugin is given
 * a hard dependency on it (see `captureContext`), so it is always alone in the earliest
 * topological tier regardless of `pre`/`normal`/`post` — there is nothing in that tier to order it
 * against.
 */
function mockProviderPlugin(services: Record<string, unknown>): AnyPlugin {
  return {
    meta: { id: MOCK_PROVIDER_ID },
    setup(ctx): void {
      for (const [key, impl] of Object.entries(services)) {
        ctx.provide(key as keyof Services, impl as never);
      }
    },
  };
}
