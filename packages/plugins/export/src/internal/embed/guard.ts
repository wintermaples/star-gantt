// docs/specs/plugins/export.md §2.1, §1.5, §11 — the plugin's one standing footprint: a single
// `data/willApplyTransaction` subscription serving both the read-only veto and the CSV/JSON import
// batch's harvest-and-cancel mechanism.
/**
 * The shared transaction guard.
 *
 * Per §11 the whole plugin installs exactly one `data/willApplyTransaction` subscription. This
 * module owns it: `guardFor(w)` lazily creates and memoizes one guard per `ExportWiring` instance
 * (a fresh `wireX(wiring)` call — from any of the four areas — that names a wiring already seen
 * returns the same guard, so it does not matter which area's `wire.ts` asks for it first, or
 * whether more than one does). `internal/formats/apply-plan.ts` uses the harvest primitives for the
 * §1.5 batch; `internal/msproject/wire.ts` and this area's own `wire.ts` use `isReadOnly()` /
 * `setReadOnly()` directly.
 *
 * Ordering inside the one handler matters: the read-only veto is checked *first*, and returns
 * before the harvest capture runs. That is what makes §1.5's "read-only interplay" fall out for
 * free — while read-only, every canceled harvest dispatch of an `"import"`-origin call is also
 * vetoed before its patches are captured, so every call's harvest comes back empty, no driver is
 * ever selected, and the import applies nothing (§1.5, "Read-only interplay").
 */
import type { PluginContext } from "@stargantt/core";
import type { Patch } from "@stargantt/plugin-data-store";
import type { ExportWiring } from "../wiring";

/** The origin every §1.5 batch call is stamped with; the harvest handler acts only on it. */
export const IMPORT_ORIGIN = "import" as const;

/** §2.1 — the always-exempt data-layer origins; config only ever adds to this set. */
const BUILTIN_EXEMPT_ORIGINS: readonly string[] = ["data-source", "realtime-sync", "lazy-load"];

/** §2.1 — the styling hook the chart root carries while read-only is active. */
export const READONLY_CLASS = "sg-readonly";

export interface DataGuard {
  isReadOnly(): boolean;
  /** Non-boolean ignored; a no-change call emits nothing (§2.1). */
  setReadOnly(on: boolean): void;
  /**
   * Runs `dispatchOne()` as one canceled `"import"`-origin harvest dispatch and returns the patches
   * its runner built (empty when the transaction was vetoed or produced nothing).
   */
  harvestOne(dispatchOne: () => void): Patch[];
  /**
   * Re-dispatches `dispatchOne()` for real (the batch's driver call), with `rest` appended to its
   * transaction by the same handler that harvested it.
   */
  dispatchDriverWith(dispatchOne: () => void, rest: readonly Patch[]): void;
}

const guards = new WeakMap<ExportWiring, DataGuard>();

/** Returns the one guard for this `ExportWiring`, creating and installing it on first use. */
export function guardFor(w: ExportWiring): DataGuard {
  const existing = guards.get(w);
  if (existing !== undefined) return existing;

  const ctx: PluginContext = w.ctx;
  const exemptOrigins = new Set<string>(BUILTIN_EXEMPT_ORIGINS);
  for (const origin of w.config.viewerEmbed.readOnlyExemptOrigins) exemptOrigins.add(origin);

  let readOnly = w.config.viewerEmbed.readOnly;
  if (readOnly) ctx.root.classList.add(READONLY_CLASS);
  // Owned once: disposal clears whichever read-only marker is current.
  ctx.own({ dispose: () => ctx.root.classList.remove(READONLY_CLASS) });

  // Harvest state, both `null` outside of exactly one `harvestOne`/`dispatchDriverWith` call: the
  // whole harvest-then-drive sequence is synchronous, so there is never more than one live at once.
  let harvestInto: Patch[] | null = null;
  let toAppend: readonly Patch[] | null = null;

  ctx.own(
    ctx.on("data/willApplyTransaction", (e) => {
      const { transaction } = e;
      // §2.1 — checked first, for every transaction regardless of origin. A vetoed transaction
      // returns here without reaching the harvest capture below, which is what makes an import (or
      // MS Project) apply attempted while read-only come back empty-handed (§1.5, §1.7).
      if (readOnly && !exemptOrigins.has(transaction.origin)) {
        e.preventDefault();
        return;
      }
      if (transaction.origin !== IMPORT_ORIGIN) return;
      if (harvestInto !== null) {
        // Loop, not `push(...spread)`: a large batch's patch list can exceed the engine's
        // argument-count limit, and a spread would throw mid-transaction.
        for (const patch of transaction.patches) harvestInto.push(patch);
        e.preventDefault();
        return;
      }
      if (toAppend !== null) {
        for (const patch of toAppend) transaction.patches.push(patch);
        toAppend = null;
      }
    }),
  );

  const guard: DataGuard = {
    isReadOnly: () => readOnly,
    setReadOnly(on: boolean): void {
      if (typeof on !== "boolean" || on === readOnly) return;
      readOnly = on;
      ctx.root.classList.toggle(READONLY_CLASS, on);
      ctx.emit("viewerembed/readOnlyChanged", { readOnly: on, cause: "api" });
    },
    harvestOne(dispatchOne: () => void): Patch[] {
      const into: Patch[] = [];
      harvestInto = into;
      try {
        dispatchOne();
      } finally {
        harvestInto = null;
      }
      return into;
    },
    dispatchDriverWith(dispatchOne: () => void, rest: readonly Patch[]): void {
      toAppend = rest;
      try {
        dispatchOne();
      } finally {
        toAppend = null;
      }
    },
  };
  guards.set(w, guard);
  return guard;
}
