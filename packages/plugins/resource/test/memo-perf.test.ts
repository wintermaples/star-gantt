/**
 * The one-entry memo helper's performance contract (docs/specs/plugins/resource.md §2.5, the M1
 * ruling): a same-input recompute is a CACHE HIT — the build runs once and the hooks observe at
 * most one call per (resource, bucket) per frame — while a different key, a
 * different memo instance and an invalidation all build afresh.
 *
 * `engine/memo.ts` is a HELPER, not a shared cache: instances are per consumer, so two instances
 * never serve each other's matrices (which is what keeps a consumer from being handed a matrix
 * built under another's roster, hooks, threshold or edges).
 */
import { describe, expect, it } from "vitest";
import { computeUtilization } from "../src/internal/engine/compute";
import type { BucketInput, UtilizationMatrix } from "../src/internal/engine/compute";
import type { UtilizationBucketUnit } from "../src/internal/engine/buckets";
import { createMatrixMemo } from "../src/internal/engine/memo";
import { MONDAY, MS_DAY, engineResource } from "./_engine";

/** A roster wide enough that a second build would be plainly visible in the hook-call count. */
function roster(count: number) {
  return Array.from({ length: count }, (_, i) => engineResource({ id: `r${String(i)}`, name: `r${String(i)}` }));
}

function demandsFor(count: number): Map<string, { start: number; end: number; units: number }[]> {
  const out = new Map<string, { start: number; end: number; units: number }[]>();
  for (let i = 0; i < count; i += 1) {
    out.set(`r${String(i)}`, [{ start: MONDAY, end: MONDAY + 30 * MS_DAY, units: 1 }]);
  }
  return out;
}

describe("the one-entry memo (§2.5)", () => {
  const ROWS = 20;
  const resources = roster(ROWS);
  const demands = demandsFor(ROWS);

  function instrumented(): {
    memo: ReturnType<typeof createMatrixMemo<unknown>>;
    builds: () => number;
    hookCalls: () => number;
  } {
    let builds = 0;
    let hookCalls = 0;
    const build = (
      bucket: UtilizationBucketUnit,
      start: number,
      end: number,
      weekStartDay: number,
    ): UtilizationMatrix<unknown> => {
      builds += 1;
      const input: BucketInput<unknown> = {
        resources,
        demands,
        start,
        end,
        bucket,
        edges: "aligned",
        weekStartDay,
        hooks: {
          resourceLoad: (cell) => {
            hookCalls += 1;
            return cell.allocated;
          },
        },
      };
      return computeUtilization(input);
    };
    return {
      memo: createMatrixMemo(build),
      builds: () => builds,
      hookCalls: () => hookCalls,
    };
  }

  it("serves a same-input recompute from the entry — one build, one hook call per cell", () => {
    const probe = instrumented();
    const first = probe.memo.get("day", MONDAY, MONDAY + 30 * MS_DAY, 1);
    const second = probe.memo.get("day", MONDAY, MONDAY + 30 * MS_DAY, 1);
    expect(second).toBe(first);
    expect(probe.builds()).toBe(1);
    // 20 rows × 30 day buckets, visited exactly once — a second build would double this.
    expect(probe.hookCalls()).toBe(ROWS * 30);
  });

  it("keeps every consumer of one frame on that single build", () => {
    const probe = instrumented();
    // The Σ-mode band and the lanes ask at the identical key in the same frame.
    for (let i = 0; i < 5; i += 1) probe.memo.get("day", MONDAY, MONDAY + 30 * MS_DAY, 1);
    expect(probe.builds()).toBe(1);
    expect(probe.hookCalls()).toBe(ROWS * 30);
  });

  it("builds afresh after an invalidation, so no result outlives its frame", () => {
    const probe = instrumented();
    probe.memo.get("day", MONDAY, MONDAY + 30 * MS_DAY, 1);
    probe.memo.invalidate();
    probe.memo.get("day", MONDAY, MONDAY + 30 * MS_DAY, 1);
    expect(probe.builds()).toBe(2);
    expect(probe.hookCalls()).toBe(2 * ROWS * 30);
  });

  it("misses on any different key, without evicting nothing else", () => {
    const probe = instrumented();
    probe.memo.get("day", MONDAY, MONDAY + 30 * MS_DAY, 1);
    // A heatmap/report call at another range simply misses and builds its own matrix.
    probe.memo.get("day", MONDAY, MONDAY + 60 * MS_DAY, 1);
    expect(probe.builds()).toBe(2);
    // …and the frame's own key is then no longer held, since the memo holds ONE entry.
    probe.memo.get("day", MONDAY, MONDAY + 30 * MS_DAY, 1);
    expect(probe.builds()).toBe(3);
  });

  it("gives each instance its own entry — two consumers never share a matrix", () => {
    const a = instrumented();
    const b = instrumented();
    const fromA = a.memo.get("day", MONDAY, MONDAY + MS_DAY, 1);
    const fromB = b.memo.get("day", MONDAY, MONDAY + MS_DAY, 1);
    expect(fromB).not.toBe(fromA);
    expect(a.builds()).toBe(1);
    expect(b.builds()).toBe(1);
  });
});
