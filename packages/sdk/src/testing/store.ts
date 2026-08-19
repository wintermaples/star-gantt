/**
 * `mockStore` — a standalone store double for unit-testing a service's subscribers without a host.
 *
 * `@stargantt/core`'s own `createStore` already satisfies the full contract (synchronous
 * notification, no coalescing, re-entrant `set()` throws) and needs no host or plugin to exist —
 * see `architecture.md` chapter 1.1. `mockStore` is a thin, semantically-named re-export of it: a
 * plugin's test file constructs its dependencies' stores with `mockStore(initial)` rather than
 * reaching past the SDK into `@stargantt/core` for `createStore` directly, and the name makes a
 * test's intent ("this is a double standing in for a real service's store") explicit at the call
 * site.
 */
import { createStore } from "@stargantt/core";
import type { WritableStore } from "@stargantt/core";

/** A `WritableStore<T>` seeded with `initial` — the same store the core's own services use. */
export function mockStore<T>(initial: T): WritableStore<T> {
  return createStore(initial);
}
