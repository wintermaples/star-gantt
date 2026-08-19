/**
 * `createTransactionBatcher` (docs/specs/sdk.md, Module: sdk/aggregate): the head-command
 * appendable-transaction machinery.
 */
import { describe, expect, it } from "vitest";
import { createTransactionBatcher } from "../src/index";
import type { AppendableTransaction, TransactionBatcherContext } from "../src/index";

type P = { op: string };

/** A stand-in for the data store's `data/willApplyTransaction` emission path. */
function host(): {
  ctx: TransactionBatcherContext<P>;
  emit(tx: AppendableTransaction<P>): void;
} {
  const handlers: ((e: { transaction: AppendableTransaction<P> }) => void)[] = [];
  return {
    ctx: { on: (_key, fn) => void handlers.push(fn) },
    emit: (transaction) => {
      for (const fn of handlers) fn({ transaction });
    },
  };
}

describe("createTransactionBatcher", () => {
  it("appends the tail to the head command's transaction, matched by origin", () => {
    const { ctx, emit } = host();
    const batch = createTransactionBatcher(ctx, "test.plugin/batch");
    let tx: AppendableTransaction<P> | undefined;
    batch((origin) => {
      tx = { origin, patches: [{ op: "head" }] };
      emit(tx);
    }, [{ op: "tail-1" }, { op: "tail-2" }]);
    expect(tx?.patches.map((p) => p.op)).toEqual(["head", "tail-1", "tail-2"]);
  });

  it("never lets a foreign transaction absorb the pending tail", () => {
    const { ctx, emit } = host();
    const batch = createTransactionBatcher(ctx, "test.plugin/batch");
    const foreign: AppendableTransaction<P> = { origin: "user", patches: [{ op: "foreign" }] };
    let own: AppendableTransaction<P> | undefined;
    batch((origin) => {
      emit(foreign); // something else lands a transaction in between
      own = { origin, patches: [{ op: "head" }] };
      emit(own);
    }, [{ op: "tail" }]);
    expect(foreign.patches.map((p) => p.op)).toEqual(["foreign"]);
    expect(own?.patches.map((p) => p.op)).toEqual(["head", "tail"]);
  });

  it("uses a fresh origin per call, so a replayed old origin appends nothing", () => {
    const { ctx, emit } = host();
    const batch = createTransactionBatcher(ctx, "test.plugin/batch");
    const origins: string[] = [];
    batch((origin) => void origins.push(origin), []);
    let replay: AppendableTransaction<P> | undefined;
    batch((origin) => {
      origins.push(origin);
      replay = { origin: origins[0] as string, patches: [{ op: "head" }] };
      emit(replay); // a foreign dispatch reusing the previous batch's origin string
    }, [{ op: "tail" }]);
    expect(new Set(origins).size).toBe(2);
    expect(replay?.patches.map((p) => p.op)).toEqual(["head"]);
  });

  it("disarms the tail when the head raises no transaction, and after a throwing head", () => {
    const { ctx, emit } = host();
    const batch = createTransactionBatcher(ctx, "test.plugin/batch");
    let armedOrigin = "";
    batch((origin) => {
      armedOrigin = origin; // a head that changes nothing: no transaction is emitted
    }, [{ op: "dropped" }]);
    const late: AppendableTransaction<P> = { origin: armedOrigin, patches: [{ op: "head" }] };
    emit(late);
    expect(late.patches.map((p) => p.op)).toEqual(["head"]);

    expect(() =>
      batch(() => {
        throw new Error("dispatch failed");
      }, [{ op: "dropped" }]),
    ).toThrow("dispatch failed");
    emit(late);
    expect(late.patches.map((p) => p.op)).toEqual(["head"]);
  });
});
