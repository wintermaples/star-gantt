// The uniform message-catalog merge (docs/specs/sdk.md, Module: sdk/dom).
import { latchedBuilderBarrier } from "./latched";

/**
 * Merges usable host-supplied catalog overrides over the built-in defaults, one key at a time.
 *
 * A key of `overrides` is **usable** when its value has the same `typeof` as the default it would
 * replace — a string where a string is expected, a function where a builder is expected — and is
 * not `undefined`; an unusable member silently keeps its default. The empty string is usable and
 * taken verbatim (it suppresses the text).
 *
 * A supplied builder is foreign code, so it is wrapped in the latched fault barrier: the first
 * throw or non-string return is reported once through `onFault` (with the key it happened under),
 * and the built-in default answers that call and every later one for the life of the catalog.
 * Built-in defaults are the plugin's own code and run unguarded. `overrides` that is not an
 * object (`undefined`, `null`, a primitive) yields the defaults unchanged.
 */
export function resolveCatalog<M extends object>(
  defaults: Readonly<M>,
  overrides: Partial<NoInfer<M>> | undefined,
  onFault: (key: keyof M & string, error: unknown) => void,
): M {
  const out: M = { ...defaults };
  if (overrides === null || typeof overrides !== "object") return out;
  for (const key of Object.keys(defaults) as (keyof M & string)[]) {
    const fallback = defaults[key];
    const supplied = (overrides as Record<string, unknown>)[key];
    if (supplied === undefined || typeof supplied !== typeof fallback) continue;
    if (typeof fallback === "function") {
      out[key] = latchedBuilderBarrier(
        supplied as (...args: unknown[]) => string,
        fallback as unknown as (...args: unknown[]) => string,
        (error) => onFault(key, error),
      ) as M[typeof key];
    } else {
      out[key] = supplied as M[typeof key];
    }
  }
  return out;
}
