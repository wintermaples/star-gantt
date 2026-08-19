/**
 * `internal/baselines/set.ts` — the hostless `snapshotProject`, plus `createBaselinesState`'s public
 * API surface (save/get/remove/setActive/snapshotOf/actualOf/setActual and the observable `state`
 * store), exercised through a real `DataService` via the shared `_baselines-boot` harness so
 * `setActual`'s `task/update` dispatch and `save()`'s `data.query()` read are verified end to end
 * rather than mocked.
 *
 * Covers registration order/ids/naming/active-pointer/dense ordinals, and actual-dates handling.
 */
import { describe, expect, it } from "vitest";
import { createBaselinesState, snapshotProject } from "../src/internal/baselines/set";
import type { BaselineId, BaselineInit } from "../src/types";
import { DAY, bootWithData, messages, task } from "./_baselines-boot";

describe("snapshotProject", () => {
  it("captures ids, dates, types and links, dropping the rest of each task", () => {
    const { tasks, links } = snapshotProject(
      [
        { id: "a", parentId: null, name: "a", start: 0, end: 10, progress: 0.5 },
        { id: "m", parentId: null, name: "m", start: 5, end: 5, type: "milestone" },
      ],
      [{ sourceId: "a", targetId: "m", type: "FS", lag: 3 }],
    );
    expect(tasks).toEqual([
      { id: "a", start: 0, end: 10 },
      { id: "m", start: 5, end: 5, type: "milestone" },
    ]);
    expect(links).toEqual([{ sourceId: "a", targetId: "m", type: "FS", lag: 3 }]);
  });

  it("drops a link naming an unusable type", () => {
    const { links } = snapshotProject([], [{ sourceId: "a", targetId: "b", type: "XX" }]);
    expect(links).toHaveLength(0);
  });
});

interface BootOpts {
  seed?: readonly BaselineInit[];
  active?: BaselineId;
  now?: () => number;
}

function bootState(opts: BootOpts = {}) {
  let repaints = 0;
  const { data, result: state } = bootWithData((ctx, data) =>
    createBaselinesState({
      ctx,
      data,
      messages: messages(),
      now: opts.now ?? (() => 0),
      seed: opts.seed ?? [],
      active: opts.active,
      repaint: () => {
        repaints += 1;
      },
    }),
  );
  return { data, state, repaints: () => repaints };
}

describe("registration order, ids and naming", () => {
  it("save() registers baselines in order with generated ids, dense default names, and activates each", () => {
    const { data, state } = bootState();
    data.load([task("a", 0, 5 * DAY), task("m", 5 * DAY, 5 * DAY, { type: "milestone" })]);
    const first = state.save();
    const second = state.save("Approved");
    expect(state.state.get().baselines.map((b) => b.id)).toEqual([first, second]);
    expect(state.state.get().baselines[0]?.name).toBe("Baseline 1");
    expect(state.state.get().baselines[1]?.name).toBe("Approved");
    expect(state.state.get().activeId).toBe(second);
    expect(state.get(first)?.taskCount).toBe(2);
    expect(state.snapshotOf("a", first)).toEqual({ id: "a", start: 0, end: 5 * DAY });
  });

  it("mints dense default-name ordinals across explicitly named saves", () => {
    const { data, state } = bootState();
    data.load([task("a", 0, DAY)]);
    const a = state.get(state.save())?.name;
    const b = state.get(state.save("Approved"))?.name;
    const c = state.get(state.save())?.name;
    expect(a).toBe("Baseline 1");
    expect(b).toBe("Approved");
    // The named save consumed no ordinal: the next generated name stays dense.
    expect(c).toBe("Baseline 2");
  });

  it("seeds config baselines in order, dropping unusable task/link snapshots", () => {
    const { state } = bootState({
      seed: [
        {
          id: "plan",
          tasks: [
            { id: "ok", start: 0, end: 10 },
            { id: "bad", start: Number.NaN, end: 10 },
            { start: 0, end: 10 } as never,
          ],
          links: [
            { sourceId: "ok", targetId: "ok2", type: "FS" },
            { sourceId: "ok", targetId: "ok2", type: "XX" as never },
          ],
        },
      ],
    });
    const baseline = state.get("plan");
    expect([...(baseline?.tasks.keys() ?? [])]).toEqual(["ok"]);
    expect(baseline?.links).toHaveLength(1);
  });

  it("replaces a colliding config-seed id in place, keeping one entry at the end of registration order", () => {
    const { state } = bootState({
      seed: [
        { id: "b", name: "v1", tasks: [{ id: "a", start: 0, end: 1 }] },
        { id: "b", name: "v2", tasks: [{ id: "a", start: 0, end: 2 }] },
      ],
    });
    expect(state.state.get().baselines).toHaveLength(1);
    expect(state.get("b")?.name).toBe("v2");
  });

  it("honors the configured active id and ignores an unknown one", () => {
    const { state } = bootState({
      seed: [{ id: "plan", tasks: [{ id: "a", start: 0, end: DAY }] }],
      active: "plan",
    });
    expect(state.state.get().activeId).toBe("plan");
  });
});

describe("active pointer and removal", () => {
  it("switches and removes generations; removing the active one deactivates", () => {
    const { data, state, repaints } = bootState();
    data.load([task("a", 0, DAY)]);
    const first = state.save();
    const second = state.save();
    const afterSaves = repaints();

    state.setActive(first);
    expect(state.state.get().activeId).toBe(first);
    const afterFirstActivate = repaints();

    state.setActive(first); // unchanged — no repaint, no new state
    expect(repaints()).toBe(afterFirstActivate);

    state.setActive("unknown"); // no-op
    expect(state.state.get().activeId).toBe(first);
    expect(repaints()).toBe(afterFirstActivate);

    state.remove(second);
    expect(state.state.get().activeId).toBe(first); // removing a non-active baseline leaves it be
    expect(state.state.get().baselines.map((b) => b.id)).toEqual([first]);

    state.remove(first);
    expect(state.state.get().activeId).toBeUndefined();
    expect(repaints()).toBeGreaterThan(afterSaves);
  });

  it("no-ops removing an unknown id (no state change, no repaint)", () => {
    const { data, state, repaints } = bootState();
    data.load([task("a", 0, DAY)]);
    state.save();
    const before = state.state.get();
    const repaintsBefore = repaints();
    state.remove("unknown");
    expect(state.state.get()).toBe(before); // reference-stable: nothing changed
    expect(repaints()).toBe(repaintsBefore);
  });
});

describe("actual dates", () => {
  it("records, reads and clears actuals through one undoable task/update per call", () => {
    const { data, state } = bootState();
    data.load([task("a", 0, 5 * DAY)]);
    expect(state.actualOf("a")).toBeUndefined();

    state.setActual("a", { start: DAY, end: 6 * DAY });
    expect(state.actualOf("a")).toEqual({ start: DAY, end: 6 * DAY });
    expect(data.getTask("a")?.meta).toEqual({ actualStart: DAY, actualEnd: 6 * DAY });

    state.setActual("a", { end: null });
    expect(state.actualOf("a")).toEqual({ start: DAY });

    state.setActual("a", { start: Number.NaN }); // unusable: no-op
    expect(state.actualOf("a")).toEqual({ start: DAY });

    state.setActual("ghost", { start: 0 }); // unknown task: no-op
    expect(state.actualOf("ghost")).toBeUndefined();
  });

  it("dispatches nothing when the write would change nothing (no undo step for a no-op call)", () => {
    const { data, state } = bootState();
    data.load([task("a", 0, 5 * DAY)]);
    state.setActual("a", { start: DAY });
    const before = data.getTask("a");
    state.setActual("a", { start: DAY }); // identical value: no-op, must not re-dispatch
    expect(data.getTask("a")).toBe(before); // same object identity: no transaction landed
  });
});
