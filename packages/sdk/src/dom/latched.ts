// Fault barriers for host-supplied render seams and message builders (docs/specs/sdk.md, Module:
// sdk/dom).

/**
 * A fault barrier for a host-supplied render seam: the first throw is reported once and every
 * later call — for the rest of the plugin instance's life — declines without calling through, so
 * a broken host function cannot emit a plugin error at frame rate.
 *
 * The returned function reports whether the seam ran: `true` when `fn` completed, `false` when it
 * threw now or on an earlier call, so the caller can paint its built-in fallback instead.
 */
export function latchedSeam<Ctx>(
  fn: (host: HTMLElement, ctx: Ctx) => void,
  onFault: (error: unknown) => void,
): (host: HTMLElement, ctx: Ctx) => boolean {
  let faulted = false;
  return (host, ctx): boolean => {
    if (faulted) return false;
    try {
      fn(host, ctx);
      return true;
    } catch (error) {
      faulted = true;
      onFault(error);
      return false;
    }
  };
}

/**
 * A fault barrier for a host-supplied message *builder* — a function expected to return a string
 * for `textContent` / `aria-label` on a per-frame path.
 *
 * A builder that throws or returns anything but a string is unusable: the built-in `fallback`
 * answers that call, `onFault` is invoked exactly once (the first fault), and the builder is never
 * called again for the life of the instance — a broken builder cannot report at frame rate.
 * A builder that keeps returning strings is passed through untouched, call by call.
 */
export function latchedBuilderBarrier<A extends unknown[]>(
  build: (...args: A) => string,
  fallback: (...args: A) => string,
  onFault: (error: unknown) => void,
): (...args: A) => string {
  let latched = false;
  return (...args: A): string => {
    if (latched) return fallback(...args);
    try {
      const out = build(...args);
      if (typeof out === "string") return out;
      latched = true;
      onFault(new TypeError(`message builder returned ${typeof out}, expected a string`));
    } catch (error) {
      latched = true;
      onFault(error);
    }
    return fallback(...args);
  };
}
