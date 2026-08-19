/**
 * docs/specs/architecture.md ch. 7's mechanical consistency check compares `dependsOn` against the
 * providers implied by *`ctx.use()`* calls only. `undoRedo()` calls `ctx.use()` for nothing:
 * recording consumes `data/didApplyTransaction` directly (an event, not a service
 * lookup), `undo()`/`redo()` dispatch `history/apply` (a command) and import `invertPatch` (a
 * static value export) — none of those three channels goes through `ctx.use()`. Its declared
 * `dependsOn: ["stargantt.data-store"]` (docs/specs/plugins/undo-redo.md "Dependencies": "hard:
 * `data`") is therefore real but *not* expressible as a `ctx.use()` footprint, so a literal
 * `expectDepsConsistency` call reports it as "declared but not used" — a known, intentional
 * mismatch this test documents rather than papers over (adding a dummy `ctx.use()` call just to
 * satisfy the checker would be worse: real code doing nothing, for a mechanical rule's sake).
 */
import { expectDepsConsistency } from "@stargantt/sdk";
import { describe, expect, it } from "vitest";
import { undoRedo } from "../src/index";

describe("expectDepsConsistency", () => {
  it("undoRedo()'s ctx.use() footprint is empty — no service lookups at setup()", () => {
    // Passing no `dependsOn` at all would pass trivially; the point here is the *documented*
    // mismatch against the plugin's real (non-empty) `dependsOn`, asserted below.
    expect(() => expectDepsConsistency(undoRedo())).toThrow(
      /declared but not used: stargantt\.data-store/,
    );
  });

  it("holds for a non-default config too (limit, messages, keys configured)", () => {
    expect(() =>
      expectDepsConsistency(undoRedo({ limit: 5, messages: { undone: "X" }, keys: { undo: ["U"] } })),
    ).toThrow(/declared but not used: stargantt\.data-store/);
  });
});
