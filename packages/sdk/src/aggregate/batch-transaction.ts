// Transaction batching (docs/specs/sdk.md, Module: sdk/aggregate): commits a head command plus
// tail patches as one user-undoable transaction via the retained `data/willApplyTransaction` hook.

/** The transaction slice the batcher appends to (data-store's `data/willApplyTransaction`). */
export interface AppendableTransaction<P> {
  /** The provenance label the head command was stamped with. */
  origin?: string;
  /** Mutable while `data/willApplyTransaction` handlers run; the batcher pushes the tail here. */
  patches: P[];
}

/** The two members of `PluginContext` the batcher needs, kept narrow so it is unit-testable. */
export interface TransactionBatcherContext<P> {
  on(
    key: "data/willApplyTransaction",
    fn: (e: { transaction: AppendableTransaction<P> }) => void,
  ): unknown;
}

/**
 * Commits one multi-patch change as a single user-undoable transaction.
 *
 * `dispatchHead` must dispatch exactly one ordinary data command stamped with the `origin` it is
 * given — a command that certainly produces a patch, because a head that changes nothing raises no
 * transaction and the tail would be dropped silently. The batcher appends `tailPatches` to that
 * transaction while `data/willApplyTransaction` runs, so the whole batch lands atomically, under
 * the head command's own label, as **one undo step**.
 */
export type TransactionBatch<P> = (
  dispatchHead: (origin: string) => void,
  tailPatches: readonly P[],
) => void;

/**
 * Creates the per-plugin batching machinery: one `data/willApplyTransaction` subscription whose
 * appends are keyed on a per-call unique origin (`<originPrefix>#<n>`), never on a re-entrancy
 * flag — so a transaction raised by anything else in between, or a foreign dispatch reusing the
 * documented origin string, can never absorb another batch's pending patches.
 *
 * Call it once at setup and keep the returned {@link TransactionBatch}. This is the path for a
 * **user-undoable** batch: the head is a validated public command and undo-redo records the
 * transaction as one entry. It is *not* the data store's `history/apply` command, which applies
 * pre-recorded patches verbatim with no validation, defaults to the `"history"` origin that
 * undo-redo deliberately ignores, and labels the transaction as a history replay — use that for
 * replaying, this for originating.
 *
 * The `data/willApplyTransaction` subscription this creates is never released by this function
 * itself — it lives for as long as the `ctx.on()` call underneath keeps it alive. Pass a real
 * `PluginContext`'s `on()` (as every call site does) and that subscription is caller-owned: the
 * context registers it through its own `ctx.own()` ledger entry, so the core releases it on
 * dispose without this module doing anything extra.
 */
export function createTransactionBatcher<P>(
  ctx: TransactionBatcherContext<P>,
  originPrefix: string,
): TransactionBatch<P> {
  let seq = 0;
  let pending: { origin: string; patches: readonly P[] } | undefined;
  ctx.on("data/willApplyTransaction", (e) => {
    if (pending === undefined || e.transaction.origin !== pending.origin) return;
    const patches = pending.patches;
    pending = undefined;
    for (const patch of patches) e.transaction.patches.push(patch);
  });
  return (dispatchHead, tailPatches) => {
    seq += 1;
    const origin = `${originPrefix}#${seq}`;
    pending = { origin, patches: tailPatches };
    try {
      dispatchHead(origin);
    } finally {
      // A head that raised no transaction (or a throwing dispatch) must not leave the tail armed.
      pending = undefined;
    }
  };
}
