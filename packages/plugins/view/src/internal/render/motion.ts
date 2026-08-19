// docs/specs/plugins/view.md — internal; not part of the published surface.
/**
 * Reduced-motion observation: one live subscription to `(prefers-reduced-motion: reduce)`.
 *
 * Hostless so the subscribe/legacy-listener/absent-`matchMedia` branches can be tested against a
 * plain double without booting a host.
 */

/** The slice of `MediaQueryList` this module reads — keeps the double in tests trivial. */
export interface MediaQueryLike {
  matches: boolean;
  addEventListener?(type: "change", handler: () => void): void;
  removeEventListener?(type: "change", handler: () => void): void;
  addListener?(handler: () => void): void;
  removeListener?(handler: () => void): void;
}

export interface MotionWatcher {
  /** `true` while the user agent reports `prefers-reduced-motion: reduce`. */
  reduced(): boolean;
  dispose(): void;
}

// docs/specs/plugins/view.md — one source of truth for reduced motion.
/**
 * Subscribes to the reduced-motion media query once and reports its live value.
 *
 * A host without `matchMedia` never reports reduced motion. The legacy
 * `addListener`/`removeListener` pair is honored for `MediaQueryList`s that predate `EventTarget`.
 */
export function createMotionWatcher(
  matchMedia?: (query: string) => MediaQueryLike,
): MotionWatcher {
  const mm: ((query: string) => MediaQueryLike) | undefined =
    matchMedia ?? (globalThis.matchMedia as unknown as ((query: string) => MediaQueryLike) | undefined);
  if (typeof mm !== "function") return { reduced: () => false, dispose: () => {} };

  let mql: MediaQueryLike;
  try {
    mql = mm("(prefers-reduced-motion: reduce)");
  } catch {
    return { reduced: () => false, dispose: () => {} };
  }
  if (mql === null || typeof mql !== "object") {
    return { reduced: () => false, dispose: () => {} };
  }

  let reduced = mql.matches === true;
  const handler = (): void => {
    reduced = mql.matches === true;
  };

  let unwatch: () => void = () => {};
  if (typeof mql.addEventListener === "function") {
    mql.addEventListener("change", handler);
    unwatch = () => mql.removeEventListener?.("change", handler);
  } else if (typeof mql.addListener === "function") {
    mql.addListener(handler);
    unwatch = () => mql.removeListener?.(handler);
  }

  return {
    reduced: () => reduced,
    dispose() {
      unwatch();
      unwatch = () => {};
    },
  };
}
