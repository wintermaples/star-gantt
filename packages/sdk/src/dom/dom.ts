// The listener idiom every `ctx.own()`-registered DOM listener uses (docs/specs/sdk.md, Module:
// sdk/dom). The `@stargantt/core` import is type-only and adds no runtime edge.
import type { PluginContext } from "@stargantt/core";

/**
 * Registers a DOM event listener whose removal the Gantt instance owns.
 *
 * The listener is attached immediately and torn down when the plugin that registered it is
 * disposed, because the removal is handed to `ctx.own()` — so a plugin never has to keep the
 * handler around to unsubscribe it. Pass the same `options` object you would pass to
 * `addEventListener`; it is used for the matching `removeEventListener` call too, which is what
 * makes a `capture: true` listener removable.
 *
 * @example
 * ```ts
 * listen(ctx, ctx.root, "pointerdown", (e) => select(e.clientX, e.clientY));
 * ```
 */
export function listen<K extends keyof HTMLElementEventMap>(
  ctx: PluginContext,
  target: HTMLElement,
  type: K,
  fn: (e: HTMLElementEventMap[K]) => void,
  options?: AddEventListenerOptions,
): void;
export function listen<K extends keyof DocumentEventMap>(
  ctx: PluginContext,
  target: Document,
  type: K,
  fn: (e: DocumentEventMap[K]) => void,
  options?: AddEventListenerOptions,
): void;
export function listen(
  ctx: PluginContext,
  target: EventTarget,
  type: string,
  fn: (e: never) => void,
  options?: AddEventListenerOptions,
): void;
export function listen(
  ctx: PluginContext,
  target: EventTarget,
  type: string,
  fn: (e: never) => void,
  options?: AddEventListenerOptions,
): void {
  // Every listener, including a document-level one, goes through `ctx.own()`.
  const handler = fn as unknown as EventListener;
  target.addEventListener(type, handler, options);
  ctx.own({ dispose: () => target.removeEventListener(type, handler, options) });
}
