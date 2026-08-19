/**
 * `src/internal/extent.ts` — the cached maximum task instant behind the horizontal
 * `renderer/contentExtent` contribution, without a host.
 */
import { describe, expect, it } from "vitest";
import type { Task, TaskId } from "@stargantt/plugin-data-store";
import { createMaxTaskEnd } from "../src/internal/extent";
import { task } from "./_fakes";

/** A store double that counts how often it is walked. */
function countingStore(tasks: Task[]) {
  const state = { walks: 0, tasks };
  const reader = {
    getTask: (id: TaskId): Task | undefined => state.tasks.find((t) => t.id === id),
    taskIds: (): Iterable<TaskId> => {
      state.walks += 1;
      return state.tasks.map((t) => t.id);
    },
  };
  return { state, reader };
}

describe("createMaxTaskEnd", () => {
  it("returns the latest instant any task reaches", () => {
    const { reader } = countingStore([
      task({ id: "a", start: 0, end: 10 }),
      task({ id: "b", start: 30, end: 20 }), // reversed dates: the start is the later instant
      task({ id: "c", start: 5, end: 25 }),
    ]);
    expect(createMaxTaskEnd(reader).get()).toBe(30);
  });

  it("returns null for an empty store", () => {
    const { reader } = countingStore([]);
    expect(createMaxTaskEnd(reader).get()).toBeNull();
  });

  it("ignores an id the store no longer resolves", () => {
    const tasks = [task({ id: "a", start: 0, end: 10 })];
    const reader = {
      getTask: (id: TaskId): Task | undefined => tasks.find((t) => t.id === id),
      taskIds: (): Iterable<TaskId> => ["a", "ghost"],
    };
    expect(createMaxTaskEnd(reader).get()).toBe(10);
  });

  it("walks the store once and caches the answer", () => {
    const { state, reader } = countingStore([task({ id: "a", start: 0, end: 10 })]);
    const max = createMaxTaskEnd(reader);
    max.get();
    max.get();
    max.get();
    expect(state.walks).toBe(1);
  });

  it("re-walks after invalidate(), which is the only thing that drops the cache", () => {
    const { state, reader } = countingStore([task({ id: "a", start: 0, end: 10 })]);
    const max = createMaxTaskEnd(reader);
    expect(max.get()).toBe(10);
    state.tasks = [task({ id: "a", start: 0, end: 99 })];
    expect(max.get()).toBe(10);
    max.invalidate();
    expect(max.get()).toBe(99);
    expect(state.walks).toBe(2);
  });

  it("caches the empty-store answer too, and refreshes it once tasks arrive", () => {
    const { state, reader } = countingStore([]);
    const max = createMaxTaskEnd(reader);
    expect(max.get()).toBeNull();
    expect(max.get()).toBeNull();
    expect(state.walks).toBe(1);
    state.tasks = [task({ id: "a", start: 0, end: 7 })];
    max.invalidate();
    expect(max.get()).toBe(7);
  });
});
