import { useEffect, useState } from "react";

/** What an in-flight load looks like to a caller: pending, or a settled value. */
export type Async<T> = { status: "loading" } | { status: "ready"; value: T } | { status: "failed"; error: string };

/**
 * Runs `load` when `key` changes and reports the outcome.
 *
 * `key` rather than `load` is the dependency on purpose: a loader is usually written inline, so a
 * new function identity every render would re-fetch on every render. The key is the route, which is
 * what actually decides what to fetch.
 *
 * A load that finishes after the key has moved on is discarded — a reader who clicks through three
 * pages faster than the first one loads must land on the third, not on whichever chunk arrived last.
 */
export function useAsync<T>(key: string, load: () => Promise<T>): Async<T> {
  const [state, setState] = useState<Async<T>>({ status: "loading" });
  useEffect(() => {
    let current = true;
    setState({ status: "loading" });
    load().then(
      (value) => {
        if (current) setState({ status: "ready", value });
      },
      (cause: unknown) => {
        if (current) {
          setState({
            status: "failed",
            error: cause instanceof Error ? cause.message : String(cause),
          });
        }
      },
    );
    return () => {
      current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- see the note above: the key is the input.
  }, [key]);
  return state;
}
