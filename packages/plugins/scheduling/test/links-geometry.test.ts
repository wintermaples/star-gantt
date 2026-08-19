/**
 * docs/specs/plugins/scheduling.md §5.1 / §5.3 — link geometry, hostless.
 *
 * Includes the derived 24×24 hit size and the `linkEditing` cursor the spec pins.
 */
import { describe, expect, it } from "vitest";
import {
  LINK_CURSOR,
  LINK_EDIT_CURSOR,
  LINK_HIT_TOLERANCE,
  PORT_CLEARANCE,
  PORT_CURSOR,
  PORT_GAP,
  PORT_HIT_SIZE,
  PORT_HIT_SLACK,
  PORT_RADIUS,
  STUB,
  anchorX,
  approachHolds,
  betweenRowsRoute,
  centreY,
  hitLink,
  hitPort,
  linkTypeFor,
  portCentre,
  routeLink,
  sourceEndOf,
  targetEndOf,
} from "../src/internal/links/geometry";
import type { Point, Rect } from "../src/internal/links/geometry";

const box = (x: number, y: number, width = 100, height = 20): Rect => ({ x, y, width, height });

/** Every segment of a routed link must be axis-aligned. */
function isOrthogonal(points: readonly Point[]): boolean {
  for (let i = 1; i < points.length; i += 1) {
    const a = points[i - 1]!;
    const b = points[i]!;
    if (a.x !== b.x && a.y !== b.y) return false;
  }
  return true;
}

describe("link ends", () => {
  it("maps each link type to the ends it joins", () => {
    expect(sourceEndOf("FS")).toBe("end");
    expect(targetEndOf("FS")).toBe("start");
    expect(sourceEndOf("SS")).toBe("start");
    expect(targetEndOf("SS")).toBe("start");
    expect(sourceEndOf("FF")).toBe("end");
    expect(targetEndOf("FF")).toBe("end");
    expect(sourceEndOf("SF")).toBe("start");
    expect(targetEndOf("SF")).toBe("end");
  });

  it("derives the link type from the two connected ends", () => {
    expect(linkTypeFor("end", "start")).toBe("FS");
    expect(linkTypeFor("start", "start")).toBe("SS");
    expect(linkTypeFor("end", "end")).toBe("FF");
    expect(linkTypeFor("start", "end")).toBe("SF");
  });

  it("anchors on the requested edge at the bar's vertical centre", () => {
    const b = box(10, 4);
    expect(anchorX(b, "start")).toBe(10);
    expect(anchorX(b, "end")).toBe(110);
    expect(centreY(b)).toBe(14);
  });
});

describe("routeLink", () => {
  it("starts on the source edge and ends on the target edge", () => {
    const route = routeLink(box(0, 4), box(200, 32), "FS");
    expect(route[0]).toEqual({ x: 100, y: 14 });
    expect(route[route.length - 1]).toEqual({ x: 200, y: 42 });
  });

  it("keeps every segment axis-aligned for all four link types", () => {
    for (const type of ["FS", "SS", "FF", "SF"] as const) {
      const route = routeLink(box(0, 4), box(200, 32), type);
      expect(isOrthogonal(route)).toBe(true);
      expect(route.length).toBeGreaterThanOrEqual(2);
    }
  });

  it("takes a single step when the target leaves room ahead of the source", () => {
    const route = routeLink(box(0, 4), box(200, 32), "FS");
    expect(route).toHaveLength(4);
    expect(route[1]!.x).toBe(200 - STUB);
  });

  it("detours between the rows when the target starts behind the source", () => {
    const route = routeLink(box(200, 4), box(0, 32), "FS");
    expect(route.length).toBeGreaterThan(4);
    // The detour runs through the gap between the two row centres.
    const midY = (14 + 42) / 2;
    expect(route.some((p) => p.y === midY)).toBe(true);
    // It steps clear of the source's finish before turning.
    expect(route[1]).toEqual({ x: 300 + STUB, y: 14 });
  });

  it("puts the vertical run outside both anchors for a start-to-start link", () => {
    const route = routeLink(box(100, 4), box(200, 32), "SS");
    const channel = route[1]!.x;
    expect(channel).toBeLessThanOrEqual(100 - STUB);
    expect(channel).toBeLessThanOrEqual(200 - STUB);
  });

  it("puts the vertical run outside both anchors for a finish-to-finish link", () => {
    const route = routeLink(box(0, 4), box(50, 32), "FF");
    const channel = route[1]!.x;
    expect(channel).toBeGreaterThanOrEqual(100 + STUB);
    expect(channel).toBeGreaterThanOrEqual(150 + STUB);
  });

  it("still produces a usable route between two bars in the same row", () => {
    const route = routeLink(box(200, 4), box(0, 4), "FS");
    expect(isOrthogonal(route)).toBe(true);
    expect(route.some((p) => p.y > 14)).toBe(true);
  });
});

describe('routeLink with routingStyle: "straight"', () => {
  it("draws one direct segment between the same two anchors an elbow route would use", () => {
    const elbow = routeLink(box(0, 4), box(200, 32), "FS");
    const straight = routeLink(box(0, 4), box(200, 32), "FS", "straight");
    expect(straight).toEqual([elbow[0], elbow[elbow.length - 1]]);
  });

  it("does not require every segment to be axis-aligned", () => {
    // The two anchors differ in both x and y for an "FS" link between rows at different heights,
    // so the single segment is diagonal — the elbow style's orthogonality guarantee does not apply.
    const route = routeLink(box(0, 4), box(200, 60), "FS", "straight");
    expect(route).toHaveLength(2);
    expect(isOrthogonal(route)).toBe(false);
  });

  it("holds for all four link types", () => {
    for (const type of ["FS", "SS", "FF", "SF"] as const) {
      const route = routeLink(box(0, 4), box(200, 32), type, "straight");
      expect(route).toHaveLength(2);
    }
  });

  it("defaults to the elbow route when the style is omitted", () => {
    const withDefault = routeLink(box(0, 4), box(200, 32), "FS");
    const withExplicitElbow = routeLink(box(0, 4), box(200, 32), "FS", "elbow");
    expect(withDefault).toEqual(withExplicitElbow);
  });
});

describe("hitLink", () => {
  const route = routeLink(box(0, 4), box(200, 32), "FS");

  it("accepts a point on the line", () => {
    expect(hitLink(route, 150, 14)).toBe(true);
  });

  it("accepts a point just off the line", () => {
    expect(hitLink(route, 150, 14 + LINK_HIT_TOLERANCE - 0.5)).toBe(true);
  });

  it("rejects a point beyond the tolerance", () => {
    expect(hitLink(route, 150, 14 + LINK_HIT_TOLERANCE + 2)).toBe(false);
  });

  it("rejects everything for a degenerate route", () => {
    expect(hitLink([{ x: 0, y: 0 }], 0, 0)).toBe(false);
  });
});

describe("ports", () => {
  const b = box(100, 4);

  it("sits just outside each end of the bar", () => {
    expect(portCentre(b, "start")).toEqual({ x: 100 - PORT_GAP - PORT_RADIUS, y: 14 });
    expect(portCentre(b, "end")).toEqual({ x: 200 + PORT_GAP + PORT_RADIUS, y: 14 });
  });

  it("answers for a point on the disc", () => {
    const c = portCentre(b, "end");
    expect(hitPort(b, c.x, c.y)).toBe("end");
    expect(hitPort(b, portCentre(b, "start").x, 14)).toBe("start");
  });

  it("declines a point inside the bar itself", () => {
    expect(hitPort(b, 150, 14)).toBeUndefined();
  });
});

describe("port geometry bands (§5.1)", () => {
  it("paints the disc entirely outside the bar edge, at edge + 9 … edge + 17", () => {
    expect(PORT_GAP).toBe(9);
    expect(PORT_RADIUS * 2).toBe(8);
    const b = box(100, 4);
    const c = portCentre(b, "end");
    // The disc spans `[centre - radius, centre + radius]`, measured outward from the edge.
    expect(c.x - PORT_RADIUS - 200).toBe(9);
    expect(c.x + PORT_RADIUS - 200).toBe(17);
  });

  it("derives the port clearance from the gap and the full disc diameter", () => {
    expect(PORT_CLEARANCE).toBe(PORT_GAP + PORT_RADIUS * 2);
    expect(PORT_CLEARANCE).toBe(17);
  });

  it("sizes the hit target to 24 CSS px across, centred on the disc", () => {
    const half = PORT_RADIUS + PORT_HIT_SLACK;
    expect(half * 2).toBe(24);
    expect(PORT_HIT_SIZE).toBe(24);
  });

  it("accepts every point inside the 24 px target and declines just outside it", () => {
    const b = box(100, 4);
    const c = portCentre(b, "end");
    const reach = PORT_HIT_SIZE / 2;
    expect(hitPort(b, c.x, c.y - (reach - 0.5))).toBe("end");
    expect(hitPort(b, c.x + reach - 0.5, c.y)).toBe("end");
    expect(hitPort(b, c.x, c.y - (reach + 0.5))).toBeUndefined();
    expect(hitPort(b, c.x + reach + 0.5, c.y)).toBeUndefined();
  });

  it("keeps the hit target from reaching inward past the bar edge, disjoint from the resize handle", () => {
    // §5.1 — the port and handle hit bands must stay disjoint so a press near a bar end is never
    // ambiguous between the two. The handle's own hit band lives entirely inside the bar
    // (task-bars measures it inward from the edge), so it is enough for the port's hit band never
    // to cross the edge inward at all: its innermost point is
    // `PORT_GAP + PORT_RADIUS - (PORT_RADIUS + PORT_HIT_SLACK)`, i.e. `PORT_GAP - PORT_HIT_SLACK`,
    // measured outward from the edge.
    const innerReach = PORT_GAP - PORT_HIT_SLACK;
    expect(innerReach).toBeGreaterThanOrEqual(0);
    const b = box(100, 4);
    // A point one pixel inside the bar's end edge is not a port hit.
    expect(hitPort(b, 199, 14)).toBeUndefined();
  });

  it("names the three cursors the hit test reports (§5.1 / §5.4)", () => {
    expect(PORT_CURSOR).toBe("crosshair");
    expect(LINK_CURSOR).toBe("default");
    expect(LINK_EDIT_CURSOR).toBe("pointer");
  });
});

describe("routeLink anchor inset (§5.1)", () => {
  it("insets both anchors outward from the bar edge, for a finish-to-start link", () => {
    const source = box(0, 4);
    const target = box(200, 32);
    const route = routeLink(source, target, "FS", "elbow", PORT_CLEARANCE);
    expect(route[0]).toEqual({ x: 100 + PORT_CLEARANCE, y: 14 });
    expect(route[route.length - 1]).toEqual({ x: 200 - PORT_CLEARANCE, y: 42 });
  });

  it("is a no-op at inset 0, reproducing the port-less route exactly", () => {
    const source = box(0, 4);
    const target = box(200, 32);
    for (const type of ["FS", "SS", "FF", "SF"] as const) {
      expect(routeLink(source, target, type, "elbow", 0)).toEqual(
        routeLink(source, target, type, "elbow"),
      );
    }
  });

  it("insets the straight route's two anchors the same way", () => {
    const source = box(0, 4);
    const target = box(200, 32);
    const route = routeLink(source, target, "FS", "straight", PORT_CLEARANCE);
    expect(route).toEqual([
      { x: 100 + PORT_CLEARANCE, y: 14 },
      { x: 200 - PORT_CLEARANCE, y: 42 },
    ]);
  });

  it("insets outward on the correct side of each anchor for an opposed-ends (SS) link", () => {
    const source = box(100, 4);
    const target = box(200, 32);
    const route = routeLink(source, target, "SS", "elbow", PORT_CLEARANCE);
    // Both ends leave from "start", so both anchors move further left (outward, away from the bar).
    expect(route[0]).toEqual({ x: 100 - PORT_CLEARANCE, y: 14 });
    expect(route[route.length - 1]).toEqual({ x: 200 - PORT_CLEARANCE, y: 42 });
  });

  it("still produces only axis-aligned segments for a behind-the-source detour", () => {
    const source = box(200, 4);
    const target = box(0, 32);
    const route = routeLink(source, target, "FS", "elbow", PORT_CLEARANCE);
    expect(isOrthogonal(route)).toBe(true);
    expect(route[0]).toEqual({ x: 300 + PORT_CLEARANCE, y: 14 });
    expect(route[route.length - 1]).toEqual({ x: 0 - PORT_CLEARANCE, y: 42 });
  });

  it("stops the route tangent to the disc's outer edge, so the arrowhead lands outside it", () => {
    // §5.1 — separation, not z-order, preserves the direction cue: the inset equals the distance
    // from the bar edge to the outer rim of the port disc.
    const target = box(200, 32);
    const route = routeLink(box(0, 4), target, "FS", "elbow", PORT_CLEARANCE);
    const tip = route[route.length - 1]!;
    const disc = portCentre(target, "start");
    expect(disc.x - tip.x).toBe(PORT_RADIUS);
  });
});

describe("approachHolds (§5.3)", () => {
  it("accepts every route the router itself builds", () => {
    const source = box(0, 5);
    for (const type of ["FS", "SS", "FF", "SF"] as const) {
      for (const target of [box(200, 65), box(-300, 65), box(0, 65)]) {
        expect(approachHolds(routeLink(source, target, type), type)).toBe(true);
      }
    }
  });

  it("rejects a route whose closing segment doubles back over the target", () => {
    // An FS link arrives at the target's start edge travelling rightward; this one comes from the
    // right instead, exactly what an overshooting detour produces.
    const doubled: Point[] = [
      { x: 100, y: 15 },
      { x: 200, y: 15 },
      { x: 200, y: 75 },
      { x: 150, y: 75 },
    ];
    expect(approachHolds(doubled, "FS")).toBe(false);
  });

  it("rejects a route that leaves its source the wrong way", () => {
    const backwards: Point[] = [
      { x: 100, y: 15 },
      { x: 40, y: 15 },
      { x: 40, y: 75 },
      { x: 150, y: 75 },
    ];
    expect(approachHolds(backwards, "FS")).toBe(false);
  });
});

describe("betweenRowsRoute (§5.3)", () => {
  it("crosses over in the gap between the two rows, keeping both approaches", () => {
    const route = betweenRowsRoute(box(0, 5), box(150, 95), "FS");
    expect(route).toEqual([
      { x: 100, y: 15 },
      { x: 110, y: 15 },
      { x: 110, y: 60 },
      { x: 140, y: 60 },
      { x: 140, y: 105 },
      { x: 150, y: 105 },
    ]);
    expect(isOrthogonal(route)).toBe(true);
    expect(approachHolds(route, "FS")).toBe(true);
  });

  it("moves both anchors outward by the inset, as `routeLink` does", () => {
    const route = betweenRowsRoute(box(0, 5), box(150, 95), "FS", PORT_CLEARANCE);
    expect(route[0]).toEqual({ x: 100 + PORT_CLEARANCE, y: 15 });
    expect(route[route.length - 1]).toEqual({ x: 150 - PORT_CLEARANCE, y: 105 });
  });

  it("is what `routeLink` returns when the target sits behind the source", () => {
    const source = box(300, 5);
    const target = box(0, 95);
    expect(routeLink(source, target, "FS")).toEqual(betweenRowsRoute(source, target, "FS"));
  });
});
