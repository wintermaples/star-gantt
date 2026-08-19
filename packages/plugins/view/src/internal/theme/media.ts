/**
 * A tiny `MediaQueryList` change-watcher tolerating the legacy pre-`EventTarget` surface of older
 * Safari (`addListener` / `removeListener`). Hostless: the caller owns the returned unwatcher.
 */

/** The slice of `MediaQueryList` the watcher needs; both listener surfaces are optional. */
export interface MediaQueryLike {
  matches: boolean;
  addEventListener?(type: string, fn: () => void): void;
  removeEventListener?(type: string, fn: () => void): void;
  addListener?(fn: () => void): void;
  removeListener?(fn: () => void): void;
}

/**
 * Subscribes `fn` to the query's `change` using whichever listener surface exists, preferring the
 * modern one. Returns the unsubscriber — a no-op when the query supports neither surface. The
 * unsubscriber is idempotent.
 */
export function watchMedia(mql: MediaQueryLike, fn: () => void): () => void {
  let unwatch: (() => void) | null = null;
  if (typeof mql.addEventListener === "function") {
    mql.addEventListener("change", fn);
    unwatch = () => mql.removeEventListener?.("change", fn);
  } else if (typeof mql.addListener === "function") {
    mql.addListener(fn);
    unwatch = () => mql.removeListener?.(fn);
  }
  return () => {
    unwatch?.();
    unwatch = null;
  };
}
