/**
 * Shared headless-element rule for `sdk/testing`: used by `createTestHost` (the real chart root)
 * and by `expectDepsConsistency`'s mock `PluginContext` (`ctx.root`), so both give a plugin's
 * `setup()` the same kind of element when no real one was supplied.
 */

/** A detached element when a DOM is available; otherwise a type-only stand-in (core never touches it beyond storing/typing it). */
export function headlessElement(): HTMLElement {
  if (typeof document !== "undefined") return document.createElement("div");
  return {} as unknown as HTMLElement;
}
