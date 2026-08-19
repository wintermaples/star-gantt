/**
 * `internal/links/routes` — the visible-link geometry, its memo, and the obstacle collection,
 * exercised without a host.
 *
 * Includes the §5.3 64-row abort the spec pins explicitly.
 */
import { describe, expect, it } from "vitest";
import { PORT_CLEARANCE, routeLink } from "../src/internal/links/geometry";
import type { Point, Rect } from "../src/internal/links/geometry";
import {
  CULL_PAD,
  NO_ROWS,
  OBSTACLE_ROW_CAP,
  createRouteIndex,
  inHorizontalView,
  rowGap,
  toViewport,
} from "../src/internal/links/routes";
import type { BarRectLookup, RouteIndexOptions } from "../src/internal/links/routes";
import { rect, stubData, stubLink, stubRows, stubTask, viewport } from "./links-doubles";
import type { StubData } from "./links-doubles";

const ROW_HEIGHT = 30;

/** Bar boxes laid out one per row, 100 px wide, 20 px tall, centred in their row. */
function barsFor(ids: string[], xOf: (id: string) => number = () => 0): BarRectLookup {
  const boxes = new Map<string, Rect>();
  ids.forEach((id, row) => boxes.set(id, rect(xOf(id), row * ROW_HEIGHT + 5)));
  return (id) => boxes.get(String(id));
}

interface Scene {
  index: ReturnType<typeof createRouteIndex>;
  data: StubData;
}

/** Three rows `t0`/`t1`/`t2`, one bar each, with the given links. */
function scene(links: ReturnType<typeof stubLink>[] = [], over: Partial<RouteIndexOptions> = {}): Scene {
  const ids = ["t0", "t1", "t2"];
  const data = stubData(
    ids.map((id) => stubTask(id)),
    links,
  );
  const index = createRouteIndex({
    rows: stubRows(ids, ROW_HEIGHT),
    data,
    barRect: barsFor(ids, (id) => ids.indexOf(id) * 200),
    routingStyle: "elbow",
    anchorInset: 0,
    ...over,
  });
  return { index, data };
}

describe("visibleRows", () => {
  it("covers the rows the viewport spans", () => {
    const { index } = scene();
    expect(index.visibleRows(viewport({ scrollTop: 0, height: 45 }))).toEqual({ first: 0, last: 1 });
  });

  it("starts at the row the scroll offset lands in", () => {
    const { index } = scene();
    expect(index.visibleRows(viewport({ scrollTop: 35, height: 30 }))).toEqual({
      first: 1,
      last: 2,
    });
  });

  it("clamps the last row to the row count", () => {
    const { index } = scene();
    expect(index.visibleRows(viewport({ scrollTop: 0, height: 10_000 }))).toEqual({
      first: 0,
      last: 2,
    });
  });

  it("covers nothing when there are no rows", () => {
    const data = stubData([]);
    const index = createRouteIndex({
      rows: stubRows([], ROW_HEIGHT),
      data,
      barRect: () => undefined,
      routingStyle: "elbow",
      anchorInset: 0,
    });
    expect(index.visibleRows(viewport())).toBeUndefined();
  });

  it("covers nothing when the viewport has no height", () => {
    const { index } = scene();
    expect(index.visibleRows(viewport({ height: 0 }))).toBeUndefined();
  });
});

describe("taskAtY", () => {
  it("answers with the task and its bar box for a point inside a row band", () => {
    const { index } = scene();
    const found = index.taskAtY(ROW_HEIGHT + 1);
    expect(found?.task.id).toBe("t1");
    expect(found?.box).toEqual(rect(200, ROW_HEIGHT + 5));
  });

  it("answers at the very top of a band and declines at its bottom edge", () => {
    const { index } = scene();
    expect(index.taskAtY(ROW_HEIGHT)?.task.id).toBe("t1");
    expect(index.taskAtY(2 * ROW_HEIGHT)?.task.id).toBe("t2");
  });

  it("declines a point past the end of the content, despite `rowAtY` clamping", () => {
    const { index } = scene();
    expect(index.taskAtY(3 * ROW_HEIGHT + 1)).toBeUndefined();
  });

  it("declines a negative y and a NaN y", () => {
    const { index } = scene();
    expect(index.taskAtY(-1)).toBeUndefined();
    expect(index.taskAtY(Number.NaN)).toBeUndefined();
  });

  it("declines a row that carries no task", () => {
    const data = stubData([stubTask("t0")]);
    const index = createRouteIndex({
      rows: stubRows(["t0", undefined], ROW_HEIGHT),
      data,
      barRect: barsFor(["t0"]),
      routingStyle: "elbow",
      anchorInset: 0,
    });
    expect(index.taskAtY(ROW_HEIGHT + 1)).toBeUndefined();
  });

  it("declines a row whose task the store does not have", () => {
    const data = stubData([]);
    const index = createRouteIndex({
      rows: stubRows(["gone"], ROW_HEIGHT),
      data,
      barRect: barsFor(["gone"]),
      routingStyle: "elbow",
      anchorInset: 0,
    });
    expect(index.taskAtY(1)).toBeUndefined();
  });

  it("declines a task with no bar box", () => {
    const data = stubData([stubTask("t0")]);
    const index = createRouteIndex({
      rows: stubRows(["t0"], ROW_HEIGHT),
      data,
      barRect: () => undefined,
      routingStyle: "elbow",
      anchorInset: 0,
    });
    expect(index.taskAtY(1)).toBeUndefined();
  });
});

describe("routedLinks", () => {
  it("routes every link with an end on a visible row", () => {
    const { index } = scene([stubLink("l0", "t0", "t1", "FS")]);
    const routed = index.routedLinks(viewport({ height: 10_000 }));
    expect(routed).toHaveLength(1);
    expect(routed[0]!.link.id).toBe("l0");
    expect(routed[0]!.route).toEqual(
      routeLink(rect(0, 5), rect(200, ROW_HEIGHT + 5), "FS", "elbow", 0),
    );
  });

  it("lists a link once even when both of its ends are visible", () => {
    const { index } = scene([stubLink("l0", "t0", "t1", "FS")]);
    expect(index.routedLinks(viewport({ height: 10_000 }))).toHaveLength(1);
  });

  it("includes a link whose other end is scrolled out of view", () => {
    // Only row 2 is visible, and it is the link's target — the link is reached through the `in`
    // bucket, and its source's bar box is still measurable off-screen.
    const { index } = scene([stubLink("l0", "t0", "t2", "FS")]);
    const routed = index.routedLinks(viewport({ scrollTop: 2 * ROW_HEIGHT, height: ROW_HEIGHT }));
    expect(routed.map((r) => r.link.id)).toEqual(["l0"]);
  });

  it("drops a link whose end has no bar box", () => {
    const data = stubData([stubTask("t0"), stubTask("t1")], [stubLink("l0", "t0", "t1", "FS")]);
    const index = createRouteIndex({
      rows: stubRows(["t0", "t1"], ROW_HEIGHT),
      data,
      // `t1` has no box: the link has nowhere to land.
      barRect: barsFor(["t0"]),
      routingStyle: "elbow",
      anchorInset: 0,
    });
    expect(index.routedLinks(viewport({ height: 10_000 }))).toEqual([]);
  });

  it("routes nothing when the viewport covers no row", () => {
    const { index, data } = scene([stubLink("l0", "t0", "t1", "FS")]);
    expect(index.routedLinks(viewport({ height: 0 }))).toEqual([]);
    expect(data.queries).toBe(0);
  });

  it("threads the routing style through to every route", () => {
    const { index } = scene([stubLink("l0", "t0", "t1", "FS")], { routingStyle: "straight" });
    expect(index.routedLinks(viewport({ height: 10_000 }))[0]!.route).toHaveLength(2);
  });

  it("threads the anchor inset through to every route", () => {
    const { index } = scene([stubLink("l0", "t0", "t1", "FS")], { anchorInset: PORT_CLEARANCE });
    const route = index.routedLinks(viewport({ height: 10_000 }))[0]!.route;
    expect(route[0]).toEqual({ x: 100 + PORT_CLEARANCE, y: 15 });
    expect(route[route.length - 1]).toEqual({ x: 200 - PORT_CLEARANCE, y: ROW_HEIGHT + 15 });
  });

  it("routes nothing at all against the no-rows stand-in (§14: rows is optional)", () => {
    const data = stubData([stubTask("t0"), stubTask("t1")], [stubLink("l0", "t0", "t1", "FS")]);
    const index = createRouteIndex({
      rows: NO_ROWS,
      data,
      barRect: barsFor(["t0", "t1"]),
      routingStyle: "elbow",
      anchorInset: 0,
    });
    expect(index.routedLinks(viewport({ height: 10_000 }))).toEqual([]);
    expect(index.visibleRows(viewport({ height: 10_000 }))).toBeUndefined();
    expect(index.taskAtY(5)).toBeUndefined();
  });
});

// The memo's key is exactly (revision, scrollTop, height): the three inputs that can change the
// answer. `queries` counts rebuilds, since the link table is read once per rebuild.
describe("the routed-link memo", () => {
  it("computes on the first call", () => {
    const { index, data } = scene([stubLink("l0", "t0", "t1", "FS")]);
    index.routedLinks(viewport());
    expect(data.queries).toBe(1);
  });

  it("reuses the same list while nothing has moved", () => {
    const { index, data } = scene([stubLink("l0", "t0", "t1", "FS")]);
    const first = index.routedLinks(viewport());
    const second = index.routedLinks(viewport());
    expect(second).toBe(first);
    expect(data.queries).toBe(1);
  });

  it("rebuilds after `invalidate()`", () => {
    const { index, data } = scene([stubLink("l0", "t0", "t1", "FS")]);
    index.routedLinks(viewport());
    index.invalidate();
    index.routedLinks(viewport());
    expect(data.queries).toBe(2);
  });

  it("rebuilds when the vertical scroll offset changes", () => {
    const { index, data } = scene([stubLink("l0", "t0", "t1", "FS")]);
    index.routedLinks(viewport({ scrollTop: 0 }));
    index.routedLinks(viewport({ scrollTop: ROW_HEIGHT }));
    expect(data.queries).toBe(2);
  });

  it("rebuilds when the viewport height changes", () => {
    const { index, data } = scene([stubLink("l0", "t0", "t1", "FS")]);
    index.routedLinks(viewport({ height: 300 }));
    index.routedLinks(viewport({ height: 301 }));
    expect(data.queries).toBe(2);
  });

  it("keeps the cache across a horizontal scroll, since routes are content coordinates", () => {
    const { index, data } = scene([stubLink("l0", "t0", "t1", "FS")]);
    const first = index.routedLinks(viewport({ scrollLeft: 0 }));
    const second = index.routedLinks(viewport({ scrollLeft: 400 }));
    expect(second).toBe(first);
    expect(data.queries).toBe(1);
  });

  it("never treats a NaN viewport measurement as a hit", () => {
    const { index, data } = scene([stubLink("l0", "t0", "t1", "FS")]);
    index.routedLinks(viewport({ scrollTop: Number.NaN }));
    index.routedLinks(viewport({ scrollTop: Number.NaN }));
    expect(data.queries).toBe(2);
  });

  it("does not resurrect a stale list after a rebuild", () => {
    const { index } = scene([stubLink("l0", "t0", "t1", "FS")]);
    const before = index.routedLinks(viewport({ scrollTop: 0 }));
    index.routedLinks(viewport({ scrollTop: ROW_HEIGHT }));
    expect(index.routedLinks(viewport({ scrollTop: 0 }))).not.toBe(before);
  });
});

describe("toViewport / inHorizontalView / rowGap", () => {
  it("subtracts both scroll offsets", () => {
    expect(toViewport({ x: 100, y: 50 }, viewport({ scrollLeft: 30, scrollTop: 20 }))).toEqual({
      x: 70,
      y: 30,
    });
  });

  it("culls a route wholly outside the padded horizontal window", () => {
    const entry = { minX: 0, maxX: 100 };
    expect(inHorizontalView(entry, { scrollLeft: 0, width: 800 })).toBe(true);
    // Just inside the pad on the left, then just outside it.
    expect(inHorizontalView(entry, { scrollLeft: 100 + CULL_PAD, width: 800 })).toBe(true);
    expect(inHorizontalView(entry, { scrollLeft: 100 + CULL_PAD + 1, width: 800 })).toBe(false);
    expect(inHorizontalView({ minX: 900, maxX: 1000 }, { scrollLeft: 0, width: 800 })).toBe(false);
    expect(inHorizontalView({ minX: 808, maxX: 900 }, { scrollLeft: 0, width: 800 })).toBe(true);
  });

  it("culls nothing against an unknown (non-positive) viewport width", () => {
    expect(inHorizontalView({ minX: 5000, maxX: 6000 }, { scrollLeft: 0, width: 0 })).toBe(true);
    expect(inHorizontalView({ minX: 5000, maxX: 6000 }, { scrollLeft: 0, width: -1 })).toBe(true);
  });

  it("measures the vertical gap between two bar boxes in either order", () => {
    expect(rowGap(rect(0, 0), rect(0, 50))).toBe(30);
    expect(rowGap(rect(0, 50), rect(0, 0))).toBe(30);
    expect(rowGap(rect(0, 0), rect(0, 10))).toBe(-10);
  });
});

describe("approach-direction fallback (§5.3)", () => {
  /**
   * Four rows: the FS link runs from `t0` (row 0) to `t3` (last row), `t1` carries the obstacle
   * bar, `t2` carries none. `targetBox` places the target bar, which is what the row gap is
   * measured from.
   */
  function detourScene(obstacle: Rect, targetBox: Rect): ReturnType<typeof createRouteIndex> {
    const ids = ["t0", "t1", "t2", "t3"];
    const boxes = new Map<string, Rect>([
      ["t0", { x: 0, y: 5, width: 100, height: 20 }],
      ["t1", obstacle],
      ["t3", targetBox],
    ]);
    return createRouteIndex({
      rows: stubRows(ids, ROW_HEIGHT),
      data: stubData(
        ids.map((id) => stubTask(id)),
        [stubLink("l0", "t0", "t3", "FS")],
      ),
      barRect: (id) => boxes.get(String(id)),
      routingStyle: "elbow",
      anchorInset: 0,
      avoidBars: true,
    });
  }

  const OBSTACLE: Rect = { x: 114, y: 35, width: 36, height: 20 };
  const FAR_TARGET: Rect = { x: 150, y: 95, width: 100, height: 20 };

  function routeOfOnly(index: ReturnType<typeof createRouteIndex>): Point[] {
    const routed = index.routedLinks(viewport({ scrollTop: 0, height: 4 * ROW_HEIGHT }));
    expect(routed).toHaveLength(1);
    return routed[0]!.route;
  }

  it("rebuilds as the between-rows route rather than doubling back over the target's bar", () => {
    const route = routeOfOnly(detourScene(OBSTACLE, FAR_TARGET));
    // The closing segment arrives from the left, the side an FS link's target end faces.
    expect(route).toEqual([
      { x: 100, y: 15 },
      { x: 110, y: 15 },
      { x: 110, y: 60 },
      { x: 140, y: 60 },
      { x: 140, y: 105 },
      { x: 150, y: 105 },
    ]);
    const last = route[route.length - 1]!;
    const before = route[route.length - 2]!;
    expect(last.x - before.x).toBeGreaterThan(0);
    // The unadjusted route it replaces did double back: its single vertical is pushed past the
    // target's anchor by the same obstacle.
    const plain = routeLink({ x: 0, y: 5, width: 100, height: 20 }, FAR_TARGET, "FS", "elbow", 0);
    expect(plain[1]?.x).toBe(140);
  });

  it("degrades to the plain route when the two bars are closer than twice the avoid margin", () => {
    // The target's box sits 5 px below the source's — under the 8 px the between-rows horizontal
    // would need — so the rebuild is skipped and the unadjusted route stands.
    const tight: Rect = { x: 150, y: 30, width: 100, height: 20 };
    const route = routeOfOnly(detourScene({ x: 114, y: 20, width: 36, height: 15 }, tight));
    expect(route).toEqual(
      routeLink({ x: 0, y: 5, width: 100, height: 20 }, tight, "FS", "elbow", 0),
    );
  });

  it("leaves a route that keeps its approach direction adjusted as before", () => {
    // The obstacle now sits left of the channel, so the nudge moves the vertical left and the
    // closing segment still arrives from the left: no rebuild, the adjusted route is kept.
    const route = routeOfOnly(detourScene({ x: 130, y: 35, width: 30, height: 20 }, FAR_TARGET));
    expect(route).toHaveLength(4);
    expect(route[1]?.x).toBe(126);
    expect(route[2]?.x).toBe(126);
  });
});

// §5.3 — "obstacle collection walks the bars of the rows the route's vertical span crosses, and a
// span crossing more than 64 rows ABORTS the collection, the route falling back to the plain
// unadjusted output (an aborted collection, not a truncated obstacle set)".
describe("the 64-row obstacle abort (§5.3)", () => {
  const OBSTACLE_ROW = 10;
  const OBSTACLE: Rect = { x: 130, y: OBSTACLE_ROW * ROW_HEIGHT + 5, width: 40, height: 20 };
  const SOURCE: Rect = { x: 0, y: 5, width: 100, height: 20 };

  /** A tall chart whose single FS link spans from row 0 to `targetRow`. */
  function spanScene(targetRow: number): ReturnType<typeof createRouteIndex> {
    const ids = Array.from({ length: targetRow + 2 }, (_, row) => `t${String(row)}`);
    const target: Rect = { x: 150, y: targetRow * ROW_HEIGHT + 5, width: 100, height: 20 };
    const boxes = new Map<string, Rect>([
      ["t0", SOURCE],
      [`t${String(OBSTACLE_ROW)}`, OBSTACLE],
      [`t${String(targetRow)}`, target],
    ]);
    return createRouteIndex({
      rows: stubRows(ids, ROW_HEIGHT),
      data: stubData(
        ids.map((id) => stubTask(id)),
        [stubLink("l0", "t0", `t${String(targetRow)}`, "FS")],
      ),
      barRect: (id) => boxes.get(String(id)),
      routingStyle: "elbow",
      anchorInset: 0,
      avoidBars: true,
    });
  }

  function onlyRoute(index: ReturnType<typeof createRouteIndex>): Point[] {
    const routed = index.routedLinks(viewport({ scrollTop: 0, height: 100_000 }));
    expect(routed).toHaveLength(1);
    return routed[0]!.route;
  }

  function plainRoute(targetRow: number): Point[] {
    return routeLink(
      SOURCE,
      { x: 150, y: targetRow * ROW_HEIGHT + 5, width: 100, height: 20 },
      "FS",
      "elbow",
      0,
    );
  }

  it("publishes the cap as 64", () => {
    expect(OBSTACLE_ROW_CAP).toBe(64);
  });

  it("still avoids the obstacle at exactly the cap (a 64-row span)", () => {
    const route = onlyRoute(spanScene(OBSTACLE_ROW_CAP));
    // The channel moved off the bar: the collection ran.
    expect(route[1]?.x).toBe(126);
    expect(route).not.toEqual(plainRoute(OBSTACLE_ROW_CAP));
  });

  it("aborts the collection one row past the cap, falling back to the plain route", () => {
    const targetRow = OBSTACLE_ROW_CAP + 1;
    const route = onlyRoute(spanScene(targetRow));
    expect(route).toEqual(plainRoute(targetRow));
    // Unadjusted: the channel is still on top of the obstacle bar.
    expect(route[1]?.x).toBe(140);
  });

  it("aborts wholesale rather than truncating the obstacle set", () => {
    // A far wider span still yields exactly the plain route — no partially-avoided middle ground.
    const targetRow = 200;
    expect(onlyRoute(spanScene(targetRow))).toEqual(plainRoute(targetRow));
  });
});
