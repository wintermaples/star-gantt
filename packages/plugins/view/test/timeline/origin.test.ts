/**
 * The axis origin at runtime: moving it and noticing content that ended up left of it.
 *
 * The renderer clamps `scrollLeft` at 0, so an instant
 * before the origin has a negative content x that no gesture can reach; these are the three ways
 * out of that — a setter, a report, and an opt-in repair.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { definePlugin } from "@stargantt/core";
import type { AnyPlugin, PluginContext } from "@stargantt/core";
import { createOriginGuard, RETRACTION_DELAY_MS } from "../../src/internal/timeline/origin-guard";
import type { OriginGuard } from "../../src/internal/timeline/origin-guard";
import { MS_DAY } from "../../src/internal/timeline/scale";
import { boot, bootWithStore, watchZoom } from "./_boot";
import type { BootedWithStore, StoreReads } from "./_boot";

let booted: BootedWithStore | null = null;

afterEach(() => {
  // Disposing before restoring the DOM also runs the guard's own `ctx.own` cancellation, so a
  // deferred retraction armed by a test cannot fire into a torn-down chart later in the run.
  booted?.gantt.dispose();
  booted?.dom.restore();
  booted = null;
  vi.useRealTimers();
});

/**
 * Fakes only the timer pair the deferred retraction uses, leaving the harness's own
 * animation frames alone.
 */
function fakeTimers(): void {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
}

/** Lets the transaction stream go quiet, so the deferred retraction runs. */
function settle(): void {
  vi.advanceTimersByTime(RETRACTION_DELAY_MS);
}

/** The default `"day"` level's density. */
const PX_PER_DAY = 40;
const JAN10 = Date.UTC(2026, 0, 10);
const JAN1 = Date.UTC(2026, 0, 1);

/** A plugin that fills the store during startup, so `lifecycle/ready` already sees the tasks. */
function seed(rows: { id: string; name: string; start: number; end: number }[]): AnyPlugin {
  return definePlugin({
    meta: { id: "test.seed", dependsOn: ["stargantt.data-store"] },
    setup: (ctx: PluginContext) => void ctx.use("stargantt.data").load(rows),
  });
}

const message = (fault: unknown): string => (fault instanceof Error ? fault.message : String(fault));

/* ------------------------------------------------------------------ *
 * §1.16 — TimelineService.setOrigin
 * ------------------------------------------------------------------ */

describe("setOrigin", () => {
  it("keeps the visible time range unchanged — the view does not jump", () => {
    booted = bootWithStore({ origin: JAN10 });
    booted.renderer.scrollTo({ scrollLeft: 7 * PX_PER_DAY });
    const before = booted.visibleRange();
    expect(before.to).toBeGreaterThan(before.from);

    booted.gantt.service("stargantt.timeline").setOrigin(JAN1);

    const after = booted.visibleRange();
    expect(after.from).toBeCloseTo(before.from, 6);
    expect(after.to).toBeCloseTo(before.to, 6);
  });

  it("grows `scrollLeft` by exactly the distance the content shifted", () => {
    booted = bootWithStore({ origin: JAN10 });
    booted.renderer.scrollTo({ scrollLeft: 7 * PX_PER_DAY });
    const scale = booted.gantt.service("stargantt.timeline");

    // Nine days earlier at 40 px/day: every content x grows by 360.
    scale.setOrigin(JAN1);

    expect(booted.renderer.viewport.get().scrollLeft).toBeCloseTo(7 * PX_PER_DAY + 9 * PX_PER_DAY, 6);
    // …and the instant that was at x = 0 is now 360 px in.
    expect(scale.tToX(JAN10)).toBeCloseTo(9 * PX_PER_DAY, 6);
  });

  it("moves the origin later too, clamping the compensated scroll at the content's left edge", () => {
    booted = bootWithStore({ origin: JAN1 });
    const scale = booted.gantt.service("stargantt.timeline");
    // At scrollLeft 0 there is nothing to give back, so the compensation is clamped and the
    // view moves by the remainder — the one documented exception to "the view does not jump".
    scale.setOrigin(JAN10);
    expect(scale.xToT(0)).toBe(JAN10);
    expect(booted.renderer.viewport.get().scrollLeft).toBe(0);
    expect(booted.visibleRange().from).toBe(JAN10);
  });

  it("ignores a non-finite value and a value that changes nothing", () => {
    booted = bootWithStore({ origin: JAN10 });
    const scale = booted.gantt.service("stargantt.timeline");
    const events = watchZoom(booted);

    scale.setOrigin(Number.NaN);
    scale.setOrigin(Number.POSITIVE_INFINITY);
    scale.setOrigin(JAN10);

    expect(scale.xToT(0)).toBe(JAN10);
    expect(events).toEqual([]);
  });

  it("repaints the header and re-publishes the level on the `zoomLevel` store", () => {
    // As above: the clamped path, where no `view/scrolled` follows to repaint the header for us.
    booted = bootWithStore({ origin: JAN1 });
    booted.dom.flushFrames();
    expect(booted.renderer.viewport.get().scrollLeft).toBe(0);
    const before = booted.header.context.texts.length;
    const events = watchZoom(booted);

    booted.gantt.service("stargantt.timeline").setOrigin(JAN10);
    booted.dom.flushFrames();

    expect(booted.header.context.texts.length).toBeGreaterThan(before);
    // The level did not change, but every cached horizontal position did — so the still-active
    // level object is published again. Stores gate on nothing, so the subscriber is notified all the
    // same; the level it sees is the composed list's first entry ("day"), unchanged.
    expect(events).toEqual([{ level: 0, cause: "origin" }]);
  });

  // Level changes and origin moves share one notification channel for both, told apart by
  // comparing the two published levels' ids, so a subscriber that persists or reports the
  // zoom level can still tell a level the user or the host asked for from an origin move.
  it("distinguishes a level change from an origin move by the published level's id", () => {
    booted = bootWithStore({ origin: JAN10 });
    const scale = booted.gantt.service("stargantt.timeline");
    const events = watchZoom(booted);

    scale.setZoomLevel("week"); // composed list: day, week, hour, month, quarter, year
    scale.setOrigin(JAN1);
    scale.setZoomLevel("hour", JAN1); // the anchored route is still a level change
    booted.data.load([{ id: "a", name: "early", start: JAN1 - MS_DAY, end: JAN1 }]);

    expect(events).toEqual([
      { level: 1, cause: "zoom" },
      { level: 1, cause: "origin" },
      { level: 2, cause: "zoom" },
    ]);
    // The anchored zoom moved the origin too, but it compensates nothing and publishes no second
    // notification: the level change it published already told subscribers to recompute.
    expect(events.filter((e) => e.cause === "origin")).toHaveLength(1);
  });

  it("re-publishes the unchanged level for an automatic extension as well", () => {
    booted = bootWithStore({ origin: JAN10, autoExtendOrigin: true });
    const events = watchZoom(booted);

    booted.data.load([{ id: "a", name: "early", start: JAN1, end: JAN1 + MS_DAY }]);

    expect(events).toEqual([{ level: 0, cause: "origin" }]);
  });

  it("repaints every canvas layer, so nothing keeps drawing at the old x", () => {
    // One probe contribution per canvas (zIndex ranges: <50 background, <100 main, else overlay).
    const drawn: string[] = [];
    const layers = definePlugin({
      meta: { id: "test.layers", dependsOn: ["stargantt.view"] },
      setup: (ctx: PluginContext) => {
        for (const [name, zIndex] of [
          ["background", 10],
          ["main", 60],
          ["overlay", 200],
        ] as const) {
          ctx.contribute("renderer/layers", {
            id: `probe-${name}`,
            zIndex,
            draw: () => void drawn.push(name),
          });
        }
      },
    });
    // Origin at the content's left edge and `scrollLeft` already 0: moving the origin *later*
    // clamps the compensating scroll to no change at all, so no `view/scrolled` repaint follows and
    // the invalidation is the only thing that can bring the layers up to date.
    booted = bootWithStore({ origin: JAN1 }, {}, [layers]);
    booted.dom.flushFrames();
    expect(booted.renderer.viewport.get().scrollLeft).toBe(0);
    drawn.length = 0;

    booted.gantt.service("stargantt.timeline").setOrigin(JAN10);
    booted.dom.flushFrames();

    expect(booted.renderer.viewport.get().scrollLeft).toBe(0);
    expect([...new Set(drawn)].sort()).toEqual(["background", "main", "overlay"]);
  });
});

/* ------------------------------------------------------------------ *
 * §1.17 — the reachability guard, wired
 * ------------------------------------------------------------------ */

describe("unreachable-content report", () => {
  it("reports a task that starts before the origin when the data arrives", () => {
    booted = bootWithStore({ origin: JAN10 });
    expect(booted.faults).toEqual([]);

    booted.data.load([{ id: "a", name: "early", start: JAN1, end: JAN1 + MS_DAY }]);

    expect(booted.faults).toHaveLength(1);
    expect(message(booted.faults[0])).toContain("2026-01-01T00:00:00.000Z");
    expect(message(booted.faults[0])).toContain("2026-01-10T00:00:00.000Z");
  });

  it("reports once at startup when the store is already populated", () => {
    booted = bootWithStore({ origin: JAN10 }, {}, [
      seed([{ id: "a", name: "early", start: JAN1, end: JAN1 + MS_DAY }]),
    ]);
    expect(booted.faults).toHaveLength(1);
  });

  it("reports at most once per distinct origin value, however often the data changes", () => {
    booted = bootWithStore({ origin: JAN10 });
    booted.data.load([{ id: "a", name: "early", start: JAN1, end: JAN1 + MS_DAY }]);
    booted.data.load([{ id: "b", name: "earlier", start: JAN1 - MS_DAY, end: JAN1 }]);
    booted.data.load([{ id: "c", name: "earlier still", start: JAN1 - 2 * MS_DAY, end: JAN1 }]);
    expect(booted.faults).toHaveLength(1);

    // A new origin is a new condition, so the latch reopens.
    booted.gantt.service("stargantt.timeline").setOrigin(JAN1);
    booted.data.load([{ id: "d", name: "early", start: JAN1 - MS_DAY, end: JAN1 }]);
    expect(booted.faults).toHaveLength(2);
  });

  it("stays silent while every task starts at or after the origin", () => {
    booted = bootWithStore({ origin: JAN1 });
    booted.data.load([
      { id: "a", name: "on the origin", start: JAN1, end: JAN1 + MS_DAY },
      { id: "b", name: "later", start: JAN10, end: JAN10 + MS_DAY },
    ]);
    expect(booted.faults).toEqual([]);
  });

  it("stays silent in a composition with no data store", () => {
    const faults: unknown[] = [];
    const collector = definePlugin({
      meta: { id: "test.fault-collector" },
      setup: (ctx: PluginContext) => {
        ctx.on("core/pluginError", (e) => void faults.push(e.error));
      },
    });
    const plain = boot([collector], {}, { origin: JAN10 });
    try {
      plain.dom.flushFrames();
      expect(faults).toEqual([]);
    } finally {
      plain.gantt.dispose();
      plain.dom.restore();
    }
  });
});

/* ------------------------------------------------------------------ *
 * §1.17 — autoExtendOrigin
 * ------------------------------------------------------------------ */

describe("autoExtendOrigin", () => {
  it("moves the origin back to the UTC day the earliest task starts on, and reports nothing", () => {
    booted = bootWithStore({ origin: JAN10, autoExtendOrigin: true });
    const scale = booted.gantt.service("stargantt.timeline");

    const start = JAN1 + 13 * 3_600_000; // 2026-01-01T13:00Z — mid-day, so alignment is visible.
    booted.data.load([{ id: "a", name: "early", start, end: start + MS_DAY }]);

    expect(scale.xToT(0)).toBe(JAN1);
    expect(booted.faults).toEqual([]);
  });

  it("compensates the view, so the same span stays on screen", () => {
    booted = bootWithStore({ origin: JAN10, autoExtendOrigin: true });
    booted.renderer.scrollTo({ scrollLeft: 3 * PX_PER_DAY });
    const before = booted.visibleRange();

    booted.data.load([{ id: "a", name: "early", start: JAN1, end: JAN1 + MS_DAY }]);

    const after = booted.visibleRange();
    expect(after.from).toBeCloseTo(before.from, 6);
    expect(after.to).toBeCloseTo(before.to, 6);
  });

  it("never moves the origin later than the configured one, however late the data moves", () => {
    fakeTimers();
    booted = bootWithStore({ origin: JAN1, autoExtendOrigin: true });
    const scale = booted.gantt.service("stargantt.timeline");
    booted.data.load([{ id: "a", name: "late", start: JAN10, end: JAN10 + MS_DAY }]);
    settle();
    expect(scale.xToT(0)).toBe(JAN1);
  });

  it("extends again when a later edit reaches further back", () => {
    booted = bootWithStore({ origin: JAN10, autoExtendOrigin: true });
    const scale = booted.gantt.service("stargantt.timeline");
    booted.data.load([{ id: "a", name: "early", start: JAN1, end: JAN1 + MS_DAY }]);
    expect(scale.xToT(0)).toBe(JAN1);
    booted.data.load([{ id: "b", name: "earlier", start: JAN1 - 5 * MS_DAY, end: JAN1 }]);
    expect(scale.xToT(0)).toBe(JAN1 - 5 * MS_DAY);
  });
});

/* ------------------------------------------------------------------ *
 * §1.17 — the extension retracts
 *
 * The asymmetry this cures: the *right*-hand end of the scrollable range
 * is re-measured from the data on every reduction, so dragging a task's
 * end later and back again widens the chart and then narrows it. Without
 * this extension the left-hand end did not come back, so the identical
 * gesture on the other edge of the same bar behaved differently.
 * ------------------------------------------------------------------ */

/** Moves one task's whole range, as a committed drag does. */
function moveTask(b: BootedWithStore, id: string, start: number, end: number): void {
  b.gantt.dispatch("task/update", { id, after: { start, end } });
}

describe("autoExtendOrigin retraction", () => {
  it("gives the room back when the edit that needed it is undone", () => {
    fakeTimers();
    booted = bootWithStore({ origin: JAN10, autoExtendOrigin: true });
    const scale = booted.gantt.service("stargantt.timeline");
    booted.data.load([{ id: "a", name: "t", start: JAN10, end: JAN10 + MS_DAY }]);

    moveTask(booted, "a", JAN1, JAN10 + MS_DAY);
    expect(scale.xToT(0)).toBe(JAN1);

    moveTask(booted, "a", JAN10, JAN10 + MS_DAY);
    // Deferred, not immediate: the walk this needs is the one the per-frame path may not run.
    expect(scale.xToT(0)).toBe(JAN1);
    settle();
    expect(scale.xToT(0)).toBe(JAN10);
  });

  it("retracts only as far as the remaining data allows", () => {
    fakeTimers();
    booted = bootWithStore({ origin: JAN10, autoExtendOrigin: true });
    const scale = booted.gantt.service("stargantt.timeline");
    booted.data.load([
      { id: "a", name: "a", start: JAN1, end: JAN1 + MS_DAY },
      { id: "b", name: "b", start: JAN1 - 5 * MS_DAY, end: JAN1 },
    ]);
    expect(scale.xToT(0)).toBe(JAN1 - 5 * MS_DAY);

    moveTask(booted, "b", JAN1 + MS_DAY, JAN1 + 2 * MS_DAY);
    settle();

    // "a" still starts on JAN1, so that is as far back as the axis has to reach — the changed task
    // alone could not have said so, which is why this is the deferred whole-store walk's answer.
    expect(scale.xToT(0)).toBe(JAN1);
  });

  it("compensates the view when the room is given back", () => {
    fakeTimers();
    booted = bootWithStore({ origin: JAN10, autoExtendOrigin: true });
    booted.data.load([{ id: "a", name: "t", start: JAN1, end: JAN1 + MS_DAY }]);
    booted.renderer.scrollTo({ scrollLeft: 12 * PX_PER_DAY });
    const before = booted.visibleRange();

    moveTask(booted, "a", JAN10, JAN10 + MS_DAY);
    settle();

    const after = booted.visibleRange();
    expect(after.from).toBeCloseTo(before.from, 6);
    expect(after.to).toBeCloseTo(before.to, 6);
  });

  it("walks the store once per settled edit, never once per live-drag frame", () => {
    fakeTimers();
    booted = bootWithStore({ origin: JAN10, autoExtendOrigin: true });
    booted.data.load([{ id: "a", name: "t", start: JAN10, end: JAN10 + MS_DAY }]);

    const reads = countStoreReads(booted);
    for (let i = 1; i <= 20; i++) dragFrame(booted, "a", JAN10 - i * MS_DAY);
    expect(reads.full).toBe(0);

    settle();
    expect(reads.full).toBe(1);
  });

  it("schedules nothing at all while the axis already begins at the configured origin", () => {
    fakeTimers();
    booted = bootWithStore({ origin: JAN1, autoExtendOrigin: true });
    booted.data.load([{ id: "a", name: "t", start: JAN10, end: JAN10 + MS_DAY }]);

    const reads = countStoreReads(booted);
    for (let i = 0; i < 20; i++) dragFrame(booted, "a", JAN10 + i * MS_DAY);
    settle();

    expect(reads.full).toBe(0);
  });

  it("takes the base origin from `setOrigin`, so a wider range the host asked for is kept", () => {
    fakeTimers();
    booted = bootWithStore({ origin: JAN10, autoExtendOrigin: true });
    const scale = booted.gantt.service("stargantt.timeline");
    booted.data.load([{ id: "a", name: "t", start: JAN1, end: JAN1 + MS_DAY }]);
    expect(scale.xToT(0)).toBe(JAN1);

    scale.setOrigin(JAN1 - 10 * MS_DAY);
    expect(scale.xToT(0)).toBe(JAN1 - 10 * MS_DAY);

    moveTask(booted, "a", JAN10, JAN10 + MS_DAY);
    settle();
    expect(scale.xToT(0)).toBe(JAN1 - 10 * MS_DAY);
  });

  it("re-derives in a single move when `setOrigin` lands later than an active extension", () => {
    booted = bootWithStore({ origin: JAN10, autoExtendOrigin: true });
    const scale = booted.gantt.service("stargantt.timeline");
    booted.data.load([{ id: "a", name: "t", start: JAN1, end: JAN1 + MS_DAY }]);
    expect(scale.xToT(0)).toBe(JAN1);
    const events = watchZoom(booted);

    scale.setOrigin(JAN10 + 5 * MS_DAY);

    // The task still pins the axis at JAN1, so the axis does not move — and it must not move there
    // and back, which at `scrollLeft` 0 would clamp the intermediate position and lose the view.
    expect(scale.xToT(0)).toBe(JAN1);
    expect(events).toEqual([]);
  });
});

/* ------------------------------------------------------------------ *
 * §1.17 — requestOriginExtension
 * ------------------------------------------------------------------ */

describe("requestOriginExtension", () => {
  it("extends the axis for an instant the store does not hold, day-aligned", () => {
    booted = bootWithStore({ origin: JAN10, autoExtendOrigin: true });
    const scale = booted.gantt.service("stargantt.timeline");

    scale.requestOriginExtension(JAN1 + 13 * 3_600_000);

    expect(scale.xToT(0)).toBe(JAN1);
    expect(booted.faults).toEqual([]);
  });

  it("does nothing without `autoExtendOrigin`, and reports nothing either", () => {
    booted = bootWithStore({ origin: JAN10 });
    const scale = booted.gantt.service("stargantt.timeline");

    scale.requestOriginExtension(JAN1);

    expect(scale.xToT(0)).toBe(JAN10);
    expect(booted.faults).toEqual([]);
  });

  it("never moves the origin later, and ignores an unusable instant", () => {
    booted = bootWithStore({ origin: JAN10, autoExtendOrigin: true });
    const scale = booted.gantt.service("stargantt.timeline");

    scale.requestOriginExtension(JAN10 + 5 * MS_DAY);
    scale.requestOriginExtension(Number.NaN);
    scale.requestOriginExtension(Number.POSITIVE_INFINITY);

    expect(scale.xToT(0)).toBe(JAN10);
  });

  it("is taken back when the gesture it was made for writes nothing", () => {
    fakeTimers();
    booted = bootWithStore({ origin: JAN10, autoExtendOrigin: true });
    const scale = booted.gantt.service("stargantt.timeline");
    booted.data.load([{ id: "a", name: "t", start: JAN10, end: JAN10 + MS_DAY }]);

    // A drag heading left, abandoned with Escape: nothing reaches the store.
    scale.requestOriginExtension(JAN1);
    expect(scale.xToT(0)).toBe(JAN1);
    // Held: the axis stays put however long the gesture pauses.
    settle();
    expect(scale.xToT(0)).toBe(JAN1);

    scale.releaseOriginExtension();
    settle();
    expect(scale.xToT(0)).toBe(JAN10);
  });

  it("keeps the axis still while a request is held, then reconciles on release", () => {
    fakeTimers();
    booted = bootWithStore({ origin: JAN10, autoExtendOrigin: true });
    const scale = booted.gantt.service("stargantt.timeline");
    booted.data.load([{ id: "a", name: "t", start: JAN10, end: JAN10 + MS_DAY }]);

    scale.requestOriginExtension(JAN1);
    // A `liveUpdate` frame arriving mid-gesture must not arm a retraction either.
    booted.gantt.dispatch("task/update", { id: "a", after: { start: JAN1, end: JAN1 + MS_DAY } });
    settle();
    expect(scale.xToT(0)).toBe(JAN1);

    scale.releaseOriginExtension();
    settle();
    // The store now holds the early start, so the axis stays where the drag put it.
    expect(scale.xToT(0)).toBe(JAN1);
  });

  it("does nothing on a release with no hold, or without `autoExtendOrigin`", () => {
    fakeTimers();
    booted = bootWithStore({ origin: JAN10 });
    const scale = booted.gantt.service("stargantt.timeline");

    scale.releaseOriginExtension();
    scale.releaseOriginExtension();
    settle();

    expect(scale.xToT(0)).toBe(JAN10);
    expect(booted.faults).toEqual([]);
  });
});

/* ------------------------------------------------------------------ *
 * §1.17 — how much of the store the wired-up guard reads per transaction
 *
 * The task store is set once per frame while a bar is dragged with
 * `liveUpdate`, so this is a claim about work performed rather than about
 * output: asserting the reported faults alone cannot catch a full walk.
 * The counters come from the harness, which wraps the `TimelineDataSource`
 * the module is handed — the guard's own seam, where a `tasks` read can only
 * be the whole-store walk (the incremental path works off the snapshot pair
 * the subscription already carries).
 * ------------------------------------------------------------------ */

/** Zeroes the counters and hands back the live object, so startup's own reads are not counted. */
function countStoreReads(b: BootedWithStore): StoreReads {
  return b.countStoreReads();
}

/** Moves one task, exactly as a `liveUpdate` drag frame does. */
function dragFrame(b: BootedWithStore, id: string, start: number): void {
  b.gantt.dispatch("task/update", { id, after: { start, end: start + MS_DAY } });
}

describe("per-transaction store reads", () => {
  it("stops reading the store entirely once the fault is reported", () => {
    booted = bootWithStore({ origin: JAN10 });
    booted.data.load([
      { id: "a", name: "early", start: JAN1, end: JAN1 + MS_DAY },
      { id: "b", name: "later", start: JAN10, end: JAN10 + MS_DAY },
    ]);
    expect(booted.faults).toHaveLength(1);

    const reads = countStoreReads(booted);
    for (let i = 0; i < 20; i++) dragFrame(booted, "b", JAN10 + i * 1000);

    expect(reads).toEqual({ full: 0 });
    expect(booted.faults).toHaveLength(1);
  });

  it("reads only the transaction's own tasks on a healthy chart", () => {
    booted = bootWithStore({ origin: JAN1 });
    booted.data.load([
      { id: "a", name: "one", start: JAN10, end: JAN10 + MS_DAY },
      { id: "b", name: "two", start: JAN10, end: JAN10 + MS_DAY },
      { id: "c", name: "three", start: JAN10, end: JAN10 + MS_DAY },
    ]);
    expect(booted.faults).toEqual([]);

    const reads = countStoreReads(booted);
    for (let i = 0; i < 20; i++) dragFrame(booted, "b", JAN10 + i * 1000);

    // No whole-store walk, and no per-task lookup either: the snapshot pair the task store hands
    // its subscribers carries the changed entries by identity, so the lookups are gone entirely —
    // the seam the module reads through no longer even offers one.
    expect(reads.full).toBe(0);
    expect(booted.faults).toEqual([]);
  });

  it("keeps the auto-extend path off the whole-store walk while a bar is dragged left", () => {
    booted = bootWithStore({ origin: JAN10, autoExtendOrigin: true });
    booted.data.load([{ id: "a", name: "one", start: JAN10, end: JAN10 + MS_DAY }]);
    const scale = booted.gantt.service("stargantt.timeline");

    const reads = countStoreReads(booted);
    for (let i = 1; i <= 5; i++) dragFrame(booted, "a", JAN10 - i * MS_DAY);

    expect(scale.xToT(0)).toBe(JAN10 - 5 * MS_DAY);
    expect(reads.full).toBe(0);
    expect(booted.faults).toEqual([]);
  });
});

/* ------------------------------------------------------------------ *
 * The guard in isolation — the latch, the never-shrink rule, and how much
 * of the store each path is allowed to look at
 * ------------------------------------------------------------------ */

describe("createOriginGuard", () => {
  interface Log {
    moves: number[];
    reports: unknown[];
    /** How many times the whole-store walk was asked for. */
    fullWalks: number;
    /** How many times the transaction-only scan was asked for. */
    changedScans: number;
    /** How many times the deferred retraction was armed. */
    armings: number;
  }

  interface Harness {
    guard: OriginGuard;
    log: Log;
    /** The base origin the guard derives against; writable, as `setOrigin` makes it. */
    base: { value: number };
    /** Runs a transaction whose changed tasks have this earliest start. */
    changed(earliest: number | undefined): void;
    /** Fires the deferred retraction if one is armed. Returns whether one was. */
    settle(): boolean;
  }

  function guardOver(
    storeEarliest: () => number | undefined,
    origin: { value: number },
    autoExtend: boolean,
    base: { value: number } = { value: origin.value },
  ): Harness {
    const log: Log = { moves: [], reports: [], fullWalks: 0, changedScans: 0, armings: 0 };
    /** The single armed retraction, standing in for the timer the plugin supplies. */
    let pending: (() => void) | null = null;
    const guard = createOriginGuard({
      origin: () => origin.value,
      setOrigin: (ms) => {
        log.moves.push(ms);
        origin.value = ms;
      },
      baseOrigin: () => base.value,
      earliestTaskStart: () => {
        log.fullWalks++;
        return storeEarliest();
      },
      autoExtend,
      report: (error) => void log.reports.push(error),
      setTimer: (run) => {
        log.armings++;
        pending = run;
        return "timer";
      },
      clearTimer: () => {
        pending = null;
      },
    });
    return {
      guard,
      log,
      base,
      changed: (earliest) =>
        guard.checkChanged(() => {
          log.changedScans++;
          return earliest;
        }),
      settle: () => {
        const run = pending;
        pending = null;
        run?.();
        return run !== null;
      },
    };
  }

  it("does nothing when the store is absent or empty", () => {
    const { guard, log } = guardOver(() => undefined, { value: JAN10 }, false);
    guard.checkAll();
    expect(log.moves).toEqual([]);
    expect(log.reports).toEqual([]);
  });

  it("latches on the origin value, not on the offending task", () => {
    const origin = { value: JAN10 };
    let earliest = JAN1;
    const { guard, log } = guardOver(() => earliest, origin, false);
    guard.checkAll();
    earliest = JAN1 - MS_DAY;
    guard.checkAll();
    guard.checkAll();
    expect(log.reports).toHaveLength(1);

    origin.value = JAN1;
    guard.checkAll();
    expect(log.reports).toHaveLength(2);
  });

  it("day-aligns the auto-extended origin and reports nothing", () => {
    const origin = { value: JAN10 };
    const { guard, log } = guardOver(() => JAN1 + 1, origin, true);
    guard.checkAll();
    expect(log.moves).toEqual([JAN1]);
    expect(log.reports).toEqual([]);
  });

  it("does not move an origin that is already early enough", () => {
    const origin = { value: JAN1 };
    const { guard, log } = guardOver(() => JAN1, origin, true);
    guard.checkAll();
    expect(log.moves).toEqual([]);
  });

  /* --- how much of the store each path reads ------------------ */

  it("never touches the store again once the fault is reported for this origin", () => {
    const origin = { value: JAN10 };
    const { guard, log, changed } = guardOver(() => JAN1, origin, false);
    guard.checkAll();
    expect(log.reports).toHaveLength(1);
    const walksAfterStartup = log.fullWalks;

    // The steady state of a live drag over a chart whose data reaches back past the origin.
    for (let i = 0; i < 50; i++) changed(JAN1);

    expect(log.fullWalks).toBe(walksAfterStartup);
    expect(log.changedScans).toBe(0);
    expect(log.reports).toHaveLength(1);
  });

  it("scans only the transaction's tasks on a healthy chart, never the whole store", () => {
    const origin = { value: JAN1 };
    const { guard, log, changed } = guardOver(() => JAN10, origin, false);
    guard.checkAll();
    const walksAfterStartup = log.fullWalks;

    for (let i = 0; i < 50; i++) changed(JAN10 + i);

    expect(log.fullWalks).toBe(walksAfterStartup);
    expect(log.changedScans).toBe(50);
    expect(log.reports).toEqual([]);
  });

  it("keeps the auto-extend path incremental too, repairing from the transaction alone", () => {
    const origin = { value: JAN10 };
    const { guard, log, changed } = guardOver(() => JAN10, origin, true);
    guard.checkAll();
    const walksAfterStartup = log.fullWalks;

    // A bar dragged left past the origin, frame by frame.
    changed(JAN1 + 2 * MS_DAY);
    changed(JAN1 + MS_DAY);
    changed(JAN1);

    expect(origin.value).toBe(JAN1);
    expect(log.moves).toEqual([JAN1 + 2 * MS_DAY, JAN1 + MS_DAY, JAN1]);
    expect(log.fullWalks).toBe(walksAfterStartup);
    expect(log.reports).toEqual([]);
  });

  it("escalates to one full walk when the origin moved behind its back", () => {
    // A later `setOrigin` moves the origin without the guard hearing about it (that is the only
    // thing that can); a task the last transaction did not touch can be left before it, so
    // the incremental answer is no longer sound.
    const origin = { value: JAN1 };
    const { guard, log, changed } = guardOver(() => JAN1, origin, false);
    guard.checkAll();
    const walksAfterStartup = log.fullWalks;
    changed(JAN10);
    expect(log.fullWalks).toBe(walksAfterStartup);

    origin.value = JAN10; // e.g. a host calling `setOrigin` forward
    changed(JAN10); // the changed task is fine, but the store-wide earliest (JAN1) is not
    expect(log.fullWalks).toBe(walksAfterStartup + 1);
    expect(log.reports).toHaveLength(1);
  });

  it("costs no walk when the origin only moves earlier, which weakens the requirement", () => {
    const origin = { value: JAN10 };
    const { guard, log, changed } = guardOver(() => JAN10, origin, false);
    guard.checkAll();
    const walksAfterStartup = log.fullWalks;

    // Every task was known to start at or after JAN10, so it starts at or after JAN1 too.
    origin.value = JAN1;
    changed(JAN10);

    expect(log.fullWalks).toBe(walksAfterStartup);
    expect(log.changedScans).toBe(1);
  });

  /* --- the derived origin and its deferred retraction --------- */

  it("derives the origin from the base and the data, in both directions", () => {
    const origin = { value: JAN10 };
    let earliest = JAN1;
    const { guard, log, settle } = guardOver(() => earliest, origin, true);

    guard.checkAll();
    expect(origin.value).toBe(JAN1);

    // The task that pulled the axis back moves forward again; only a walk can know that.
    earliest = JAN10;
    guard.checkChanged(() => JAN10);
    expect(origin.value).toBe(JAN1);
    expect(settle()).toBe(true);
    expect(origin.value).toBe(JAN10);
    expect(log.reports).toEqual([]);
  });

  it("stops retracting at the base origin, whatever the data says", () => {
    const origin = { value: JAN10 };
    const { guard, settle } = guardOver(() => JAN10 + 30 * MS_DAY, origin, true, { value: JAN10 });
    guard.checkAll();
    // Nothing was ever extended, so nothing is armed and nothing walks the origin forward.
    expect(settle()).toBe(false);
    expect(origin.value).toBe(JAN10);
  });

  it("coalesces: many transactions, one walk once the stream goes quiet", () => {
    const origin = { value: JAN10 };
    const { guard, log, changed, settle } = guardOver(() => JAN1, origin, true);
    guard.checkAll();
    const walksAfterStartup = log.fullWalks;

    for (let i = 0; i < 50; i++) changed(JAN1 + i);
    expect(log.fullWalks).toBe(walksAfterStartup);

    settle();
    expect(log.fullWalks).toBe(walksAfterStartup + 1);
  });

  it("arms nothing while the axis already begins at the base origin", () => {
    const origin = { value: JAN1 };
    const { guard, log, changed } = guardOver(() => JAN10, origin, true, { value: JAN1 });
    guard.checkAll();
    for (let i = 0; i < 20; i++) changed(JAN10 + i);
    expect(log.armings).toBe(0);
  });

  it("never arms a retraction with the option off — the origin only moves by hand there", () => {
    const origin = { value: JAN10 };
    const { guard, log, changed } = guardOver(() => JAN10, origin, false, { value: JAN1 });
    guard.checkAll();
    for (let i = 0; i < 20; i++) changed(JAN10 + i);
    expect(log.armings).toBe(0);
  });

  /* --- requestExtension --------------------------------------- */

  it("extends for an instant the store does not hold, without walking it", () => {
    const origin = { value: JAN10 };
    const { guard, log } = guardOver(() => JAN10, origin, true);
    guard.checkAll();
    const walksAfterStartup = log.fullWalks;

    guard.requestExtension(JAN1 + 13 * 3_600_000);

    expect(origin.value).toBe(JAN1);
    expect(log.fullWalks).toBe(walksAfterStartup);
  });

  it("takes an extension back when the gesture that held it ends", () => {
    const origin = { value: JAN10 };
    const { guard, settle } = guardOver(() => JAN10, origin, true);
    guard.checkAll();
    guard.requestExtension(JAN1);
    expect(origin.value).toBe(JAN1);

    guard.releaseExtension();
    expect(settle()).toBe(true);
    expect(origin.value).toBe(JAN10);
  });

  it("holds the axis still while a gesture owns it, however long the pointer rests", () => {
    // The bug this exists for: the timer used to be armed by the request itself, so a pointer held
    // still for the quiet period retracted the axis underneath its own drag and re-extended it on
    // the next move — an origin that rubber-banded while the button was down.
    const origin = { value: JAN10 };
    const { guard, log, changed, settle } = guardOver(() => JAN10, origin, true);
    guard.checkAll();

    guard.requestExtension(JAN1);
    expect(origin.value).toBe(JAN1);
    // Nothing is armed at all, so there is no quiet period to wait out.
    expect(settle()).toBe(false);
    expect(origin.value).toBe(JAN1);

    // …and a transaction cannot arm one either, so a `liveUpdate` drag is covered by the same rule.
    const armingsBefore = log.armings;
    changed(JAN1);
    expect(log.armings).toBe(armingsBefore);
    expect(origin.value).toBe(JAN1);
  });

  it("cancels a retraction already armed when a gesture takes the axis", () => {
    const origin = { value: JAN10 };
    let storeEarliest = JAN1;
    const { guard, changed, settle } = guardOver(() => storeEarliest, origin, true);
    guard.checkAll();
    expect(origin.value).toBe(JAN1);
    storeEarliest = JAN10;
    changed(JAN10); // arms the retraction

    guard.requestExtension(JAN1 - MS_DAY);

    expect(settle()).toBe(false);
    expect(origin.value).toBe(JAN1 - MS_DAY);
  });

  it("ignores a release with no hold outstanding", () => {
    const origin = { value: JAN1 };
    const { guard, log, settle } = guardOver(() => JAN1, origin, true, { value: JAN10 });
    guard.releaseExtension();
    expect(log.armings).toBe(0);
    expect(settle()).toBe(false);
  });

  it("ignores an extension request with the option off, or for an unusable instant", () => {
    const off = { value: JAN10 };
    const offGuard = guardOver(() => JAN10, off, false);
    offGuard.guard.requestExtension(JAN1);
    expect(off.value).toBe(JAN10);

    const on = { value: JAN10 };
    const onGuard = guardOver(() => JAN10, on, true);
    onGuard.guard.requestExtension(Number.NaN);
    onGuard.guard.requestExtension(JAN10 + MS_DAY);
    expect(on.value).toBe(JAN10);
  });

  /* --- rebase ------------------------------------------ */

  it("applies a new base in one move, and re-derives against the store", () => {
    const origin = { value: JAN10 };
    const base = { value: JAN10 };
    const { guard, log } = guardOver(() => JAN1, origin, true, base);
    guard.checkAll();
    expect(origin.value).toBe(JAN1);
    log.moves.length = 0;

    // A host moving the base later than the active extension: the data still pins the axis, so the
    // origin must not move at all — least of all there and back.
    base.value = JAN10 + 5 * MS_DAY;
    guard.rebase();
    expect(log.moves).toEqual([]);
    expect(origin.value).toBe(JAN1);

    // …and moving it earlier than the data needs is honoured verbatim, in one move.
    base.value = JAN1 - 10 * MS_DAY;
    guard.rebase();
    expect(log.moves).toEqual([JAN1 - 10 * MS_DAY]);
  });

  it("applies the base itself with the option off, then re-checks at the new origin", () => {
    const origin = { value: JAN10 };
    const base = { value: JAN1 };
    const { guard, log } = guardOver(() => JAN1 - MS_DAY, origin, false, base);

    guard.rebase();

    expect(log.moves).toEqual([JAN1]);
    // The report names the origin the host just chose, not the one it replaced.
    expect(log.reports).toHaveLength(1);
    expect(message(log.reports[0])).toContain(new Date(JAN1).toISOString());
  });

  it("re-walks after an unrepaired violation rather than trusting the store again", () => {
    const origin = { value: JAN10 };
    let storeEarliest = JAN10;
    const { guard, log, changed } = guardOver(() => storeEarliest, origin, false);
    guard.checkAll();

    // A transaction puts a task before the origin: reported, and not repaired.
    storeEarliest = JAN1;
    changed(JAN1);
    expect(log.reports).toHaveLength(1);

    // The origin moves earlier, past the offender's day but not past a second, older one.
    origin.value = JAN1 + MS_DAY;
    const walksSoFar = log.fullWalks;
    changed(JAN10);
    // The offending task is not in this transaction, so only a full walk can still see it.
    expect(log.fullWalks).toBe(walksSoFar + 1);
    expect(log.reports).toHaveLength(2);
  });
});
