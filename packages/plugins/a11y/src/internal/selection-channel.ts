// docs/specs/plugins/a11y.md § Dependencies — the optional, late-resolved selection edge.
/**
 * `stargantt.selection` is provided by the interaction plugin, which sits on the **same** layer as
 * this one (architecture.md ch. 5: same-layer references are optional-only). It is therefore never
 * looked up at `setup()` — the interaction plugin may start after this one — but at *use* time,
 * through the channel below: every call retries the lookup until it resolves once, and the first
 * resolution is what installs the state subscription that drives `aria-selected`,
 * `aria-multiselectable` and the keyboard anchor reset.
 *
 * A composition without any provider keeps answering `undefined`, which is exactly the degradation
 * state the spec describes: the multi-selection chords report inactive, `syncSelection` has nothing
 * to sync, and no selection attribute is ever written.
 */
import type { Disposable, PluginContext } from "@stargantt/core";
import type { TaskId } from "@stargantt/plugin-data-store";
import type { SelectionService } from "@stargantt/plugin-interaction";

export interface SelectionChannelDeps {
  /** Called once, the first time a usable service resolves, with the selection it already holds. */
  onResolved(service: SelectionService, selected: ReadonlySet<TaskId> | undefined): void;
  /** Called on every state change the resolved service publishes. */
  onChanged(selected: ReadonlySet<TaskId> | undefined): void;
  /** Reads the ids out of a state snapshot, hardened against a foreign provider's payload shape. */
  readIds(taskIds: unknown): ReadonlySet<TaskId> | undefined;
  /** Registers the state subscription for disposal. */
  own(d: Disposable): void;
}

/**
 * Whether a value offers the three members this plugin actually calls. A provider missing any of
 * them is treated as absent rather than crashing a chord mid-keystroke.
 */
function isUsable(service: unknown): service is SelectionService {
  if (typeof service !== "object" || service === null) return false;
  const candidate = service as { state?: unknown; select?: unknown; mode?: unknown };
  if (typeof candidate.select !== "function" || typeof candidate.mode !== "function") return false;
  const state = candidate.state as { get?: unknown; subscribe?: unknown } | undefined;
  return (
    typeof state === "object" &&
    state !== null &&
    typeof state.get === "function" &&
    typeof state.subscribe === "function"
  );
}

/**
 * The late, optional selection lookup: call the returned function wherever the service is needed.
 * It answers `undefined` until a usable provider exists, and never more than once performs the
 * resolution side effects.
 */
export function selectionChannel(
  ctx: PluginContext,
  deps: SelectionChannelDeps,
): () => SelectionService | undefined {
  let resolved: SelectionService | undefined;
  return () => {
    if (resolved !== undefined) return resolved;
    const service: unknown = ctx.useOptional("stargantt.selection");
    if (!isUsable(service)) return undefined;
    resolved = service;
    // The subscription is both the `aria-selected` channel and the "a selection this plugin did
    // not make" signal the keyboard anchor watches.
    deps.own(resolved.state.subscribe((next) => deps.onChanged(deps.readIds(next.taskIds))));
    deps.onResolved(resolved, deps.readIds(resolved.state.get().taskIds));
    return resolved;
  };
}
