/**
 * "Operable at 100k tasks": these assert the *shape* of the cost — O(log n) offset lookups and an
 * iterative flatten — rather than wall-clock, with generous time bounds only as a backstop against
 * an accidental O(n) query path.
 *
 * docs/specs/plugins/tree-grid.md § Internal modules (`RowModel`)
 */
import { describe, expect, it } from "vitest";
import { DEFAULT_ROW_HEIGHT, RowModel, defaultRowHeightResolver } from "../src/internal/row-model";
import type { Task } from "@stargantt/plugin-data-store";
import { fakeData, task } from "./_data";
import { boot, flatTasks } from "./_boot";

const N = 100_000;
const H = DEFAULT_ROW_HEIGHT;

function roots(n: number): Task[] {
  const out: Task[] = new Array<Task>(n);
  for (let i = 0; i < n; i += 1) out[i] = task(`t${i}`, null);
  return out;
}

describe("100k rows", () => {
  it("flattens and indexes the full set", () => {
    const m = new RowModel(fakeData(roots(N)), () => defaultRowHeightResolver);
    expect(m.rowCount()).toBe(N);
    expect(m.taskIdAt(0)).toBe("t0");
    expect(m.taskIdAt(N - 1)).toBe(`t${N - 1}`);
    expect(m.rowOf(`t${N - 1}`)).toBe(N - 1);
    expect(m.isUniform()).toBe(true);
    expect(m.totalHeight()).toBe(N * H);
  });

  it("answers 100k variable-height offset queries in O(log n) each", () => {
    // every 10th row is 60px tall, so the Fenwick path is in effect
    const m = new RowModel(fakeData(roots(N)), () => (t, d) => {
      const i = Number(String(t.id).slice(1));
      return i % 10 === 0 ? 60 : d;
    });
    expect(m.isUniform()).toBe(false);

    const tallCount = N / 10;
    const expectedTotal = tallCount * 60 + (N - tallCount) * H;
    expect(m.totalHeight()).toBe(expectedTotal);

    // spot-check the first block: 60, 28 × 9, 60, …
    expect(m.yOf(0)).toBe(0);
    expect(m.yOf(1)).toBe(60);
    expect(m.yOf(10)).toBe(60 + 9 * H);
    expect(m.rowAtY(0)).toBe(0);
    expect(m.rowAtY(59)).toBe(0);
    expect(m.rowAtY(60)).toBe(1);

    const started = Date.now();
    for (let row = 0; row < N; row += 1) {
      // round-trip: the row containing a row's own top offset is that row
      if (m.rowAtY(m.yOf(row)) !== row) throw new Error(`round trip failed at ${row}`);
    }
    // 200k O(log n) queries; an accidental O(n) scan would be ~10^10 steps and never finish.
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("flattens a 100k-deep chain without recursing", () => {
    const chain: Task[] = new Array<Task>(N);
    chain[0] = task("n0", null);
    for (let i = 1; i < N; i += 1) chain[i] = task(`n${i}`, `n${i - 1}`);
    const m = new RowModel(fakeData(chain), () => defaultRowHeightResolver);
    expect(m.rowCount()).toBe(N);
    expect(m.depthAt(N - 1)).toBe(N - 1);
  });

  it("keeps the pane virtualized at 100k rows through the real plugin", () => {
    const booted = boot();
    try {
      booted.data.load(flatTasks(N));
      booted.dom.flushFrames();
      expect(booted.rows.rowCount()).toBe(N);
      // 300px of viewport / 28px rows — the DOM never grows with the data set
      expect(booted.visibleRows().length).toBe(Math.ceil(300 / H));
    } finally {
      booted.gantt.dispose();
      booted.dom.restore();
    }
  });
});
