/**
 * `internal/links/link-drag` and `internal/links/keyboard-link` — the port-drag gesture, the drop
 * rules and the two-step keyboard chord, exercised without a host.
 *
 * docs/specs/plugins/scheduling.md §5.2 / §5.6 / §4.3, including the §4.3 pointer-identity and
 * cancellation rules the spec states explicitly.
 */
import { describe, expect, it } from "vitest";
import {
  PORT_CLEARANCE,
  PORT_HIT_SLACK,
  centreY,
  portCentre,
} from "../src/internal/links/geometry";
import type { BarEnd } from "../src/internal/links/geometry";
import { DROP_REACH, createPortDragGesture, dropEnd, resolveDrop } from "../src/internal/links/link-drag";
import type { LinkDrag } from "../src/internal/links/link-drag";
import { LINK_CHORD, linkChordAnnouncement, linkChordStep } from "../src/internal/links/keyboard-link";
import type { TaskAtY } from "../src/internal/links/routes";
import { rect, stubTask } from "./links-doubles";

/** A bar of task `id` at `x`, on a row whose band starts at `y`. */
function at(id: string, x: number, y = 0): TaskAtY {
  return { task: stubTask(id), box: rect(x, y) };
}

const source = at("t0", 0);
const target = at("t1", 400, 30);

/** No pair is linked yet — the state every drop rule below is stated against. */
const unlinked = (): boolean => false;

/** A drag in flight from one end of `t0`'s bar. */
function dragFrom(end: BarEnd, pointerId?: number): LinkDrag {
  return {
    sourceId: "t0",
    sourceEnd: end,
    origin: portCentre(source.box, end),
    point: { x: 0, y: 0 },
    pointerId,
  };
}

describe("the port-drag gesture (§5.2)", () => {
  it("is idle before anything happens", () => {
    expect(createPortDragGesture().current()).toBeNull();
  });

  it("starts from the port the press landed on, remembering its centre", () => {
    const gesture = createPortDragGesture();
    const c = portCentre(source.box, "end");
    expect(gesture.start(source, c.x, c.y, { x: 7, y: 9 }, 3)).toBe(true);
    expect(gesture.current()).toEqual({
      sourceId: "t0",
      sourceEnd: "end",
      origin: c,
      point: { x: 7, y: 9 },
      pointerId: 3,
    });
  });

  it("starts from the start port when that is the one pressed", () => {
    const gesture = createPortDragGesture();
    const c = portCentre(source.box, "start");
    expect(gesture.start(source, c.x, c.y, { x: 0, y: 0 })).toBe(true);
    expect(gesture.current()?.sourceEnd).toBe("start");
  });

  it("does not start when the press missed both ports", () => {
    const gesture = createPortDragGesture();
    const inside = { x: source.box.x + source.box.width / 2, y: centreY(source.box) };
    expect(gesture.start(source, inside.x, inside.y, inside)).toBe(false);
    expect(gesture.current()).toBeNull();
  });

  // §4.3 pointer identity, mirroring the gesture arbiter's own rule: only one drag is ever in
  // flight. Minor fix (P4 review ruling) — a second `start()` while a drag is already active used
  // to silently HIJACK it, overwriting pointer 1's `origin`/`sourceEnd` with pointer 2's.
  it("refuses a second start() while a drag is already in flight, from any pointer", () => {
    const gesture = createPortDragGesture();
    const c1 = portCentre(source.box, "end");
    expect(gesture.start(source, c1.x, c1.y, { x: 0, y: 0 }, 1)).toBe(true);
    const inFlight = gesture.current();

    // A second pointer pressing the SAME port does not hijack the drag.
    expect(gesture.start(source, c1.x, c1.y, { x: 5, y: 5 }, 2)).toBe(false);
    expect(gesture.current()).toEqual(inFlight);

    // Nor does a second pointer pressing the OTHER end's port.
    const c2 = portCentre(source.box, "start");
    expect(gesture.start(source, c2.x, c2.y, { x: 9, y: 9 }, 3)).toBe(false);
    expect(gesture.current()).toEqual(inFlight);

    // The original pointer can still finish its own, un-hijacked drag.
    expect(gesture.finish(1)).toEqual(inFlight);
  });

  it("tracks the pointer while a drag is in flight", () => {
    const gesture = createPortDragGesture();
    const c = portCentre(source.box, "end");
    gesture.start(source, c.x, c.y, { x: 0, y: 0 });
    expect(gesture.track({ x: 120, y: 40 })).toBe(true);
    expect(gesture.current()?.point).toEqual({ x: 120, y: 40 });
  });

  it("ignores tracking while idle, so another plugin's gesture cannot move it", () => {
    const gesture = createPortDragGesture();
    expect(gesture.track({ x: 120, y: 40 })).toBe(false);
    expect(gesture.current()).toBeNull();
  });

  it("hands the drag over on finish and goes idle", () => {
    const gesture = createPortDragGesture();
    const c = portCentre(source.box, "end");
    gesture.start(source, c.x, c.y, { x: 0, y: 0 });
    expect(gesture.finish()?.sourceId).toBe("t0");
    expect(gesture.current()).toBeNull();
  });

  it("finishes as nothing when no drag was in flight", () => {
    expect(createPortDragGesture().finish()).toBeNull();
  });

  // §4.3 — only the pointer that started the drag advances or finishes it.
  it("declines a move and a release reported by a different pointer", () => {
    const gesture = createPortDragGesture();
    const c = portCentre(source.box, "end");
    gesture.start(source, c.x, c.y, { x: 0, y: 0 }, 1);
    expect(gesture.track({ x: 50, y: 50 }, 2)).toBe(false);
    expect(gesture.current()?.point).toEqual({ x: 0, y: 0 });
    expect(gesture.finish(2)).toBeNull();
    // The owning pointer still finishes it.
    expect(gesture.track({ x: 50, y: 50 }, 1)).toBe(true);
    expect(gesture.finish(1)?.sourceId).toBe("t0");
  });

  it("cancels an in-flight drag, and reports whether there was one", () => {
    const gesture = createPortDragGesture();
    expect(gesture.cancel()).toBe(false);
    const c = portCentre(source.box, "end");
    gesture.start(source, c.x, c.y, { x: 0, y: 0 });
    expect(gesture.cancel()).toBe(true);
    expect(gesture.current()).toBeNull();
    expect(gesture.finish()).toBeNull();
  });
});

describe("resolveDrop (§5.2)", () => {
  it("derives each of the four link types from the two joined ports", () => {
    const cases: [BarEnd, BarEnd, string][] = [
      ["end", "start", "FS"],
      ["start", "start", "SS"],
      ["end", "end", "FF"],
      ["start", "end", "SF"],
    ];
    for (const [from, to, type] of cases) {
      const c = portCentre(target.box, to);
      expect(resolveDrop(dragFrom(from), target, c.x, c.y, unlinked)).toEqual({
        sourceId: "t0",
        targetId: "t1",
        type,
      });
    }
  });

  it("falls back to the nearer half of the bar when the drop missed both ports", () => {
    const y = centreY(target.box);
    const nearStart = resolveDrop(dragFrom("end"), target, target.box.x + 1, y, unlinked);
    expect(nearStart?.type).toBe("FS");
    const nearEnd = resolveDrop(
      dragFrom("end"),
      target,
      target.box.x + target.box.width - 1,
      y,
      unlinked,
    );
    expect(nearEnd?.type).toBe("FF");
  });

  it("resolves the same end the drop-candidate ring would highlight", () => {
    const y = centreY(target.box);
    expect(dropEnd(target.box, target.box.x + 1, y)).toBe("start");
    expect(dropEnd(target.box, target.box.x + target.box.width - 1, y)).toBe("end");
    const c = portCentre(target.box, "end");
    expect(dropEnd(target.box, c.x, c.y)).toBe("end");
  });

  it("refuses a drop on the drag's own task", () => {
    const c = portCentre(source.box, "start");
    expect(resolveDrop(dragFrom("end"), source, c.x, c.y, unlinked)).toBeUndefined();
  });

  it("refuses a drop on a task the source is already linked to (one link per ordered pair)", () => {
    const c = portCentre(target.box, "start");
    expect(resolveDrop(dragFrom("end"), target, c.x, c.y, () => true)).toBeUndefined();
  });

  it("refuses it whichever ends are joined, since the pair is what counts", () => {
    const ends: BarEnd[] = ["start", "end"];
    for (const from of ends) {
      for (const to of ends) {
        const c = portCentre(target.box, to);
        expect(resolveDrop(dragFrom(from), target, c.x, c.y, () => true)).toBeUndefined();
      }
    }
  });

  it("asks about the pair the drop would create, not the reverse one", () => {
    const asked: [string, string][] = [];
    const c = portCentre(target.box, "start");
    resolveDrop(dragFrom("end"), target, c.x, c.y, (sourceId, targetId) => {
      asked.push([String(sourceId), String(targetId)]);
      return false;
    });
    expect(asked).toEqual([["t0", "t1"]]);
  });

  it("accepts a drop just within the horizontal reach of the bar", () => {
    const y = centreY(target.box);
    const rightEdge = target.box.x + target.box.width;
    expect(resolveDrop(dragFrom("end"), target, rightEdge + DROP_REACH, y, unlinked)).toBeDefined();
    expect(
      resolveDrop(dragFrom("end"), target, target.box.x - DROP_REACH, y, unlinked),
    ).toBeDefined();
  });

  it("refuses a drop beyond the horizontal reach of the bar", () => {
    const y = centreY(target.box);
    const rightEdge = target.box.x + target.box.width;
    expect(
      resolveDrop(dragFrom("end"), target, rightEdge + DROP_REACH + 1, y, unlinked),
    ).toBeUndefined();
    expect(
      resolveDrop(dragFrom("end"), target, target.box.x - DROP_REACH - 1, y, unlinked),
    ).toBeUndefined();
  });

  it("reaches exactly as far as a port's own hit target does", () => {
    // §5.1 — the drop reach is the port clearance plus the hit slack, never an independent
    // number, so it cannot drift from the disc.
    expect(DROP_REACH).toBe(PORT_CLEARANCE + PORT_HIT_SLACK);
  });
});

describe("linkChordStep (§5.6)", () => {
  const nameOf = (id: string | number): string => `task ${String(id)}`;

  it("uses the Alt+L chord", () => {
    expect(LINK_CHORD).toBe("Alt+L");
  });

  it("marks the focused task on the first press", () => {
    expect(linkChordStep(null, "t0", unlinked)).toEqual({ kind: "mark", sourceId: "t0" });
  });

  it("creates the link when the second press lands on another task", () => {
    expect(linkChordStep("t0", "t1", unlinked)).toEqual({
      kind: "create",
      sourceId: "t0",
      targetId: "t1",
    });
  });

  it("cancels when the second press lands on the pending source itself", () => {
    expect(linkChordStep("t0", "t0", unlinked)).toEqual({ kind: "cancel", sourceId: "t0" });
  });

  it("reports the pair as already linked instead of creating a second link", () => {
    expect(linkChordStep("t0", "t1", () => true)).toEqual({
      kind: "duplicate",
      sourceId: "t0",
      targetId: "t1",
    });
  });

  it("asks about the pair in the order the link would run", () => {
    const asked: [string, string][] = [];
    linkChordStep("t0", "t1", (sourceId, targetId) => {
      asked.push([String(sourceId), String(targetId)]);
      return false;
    });
    expect(asked).toEqual([["t0", "t1"]]);
  });

  it("announces each of the four outcomes", () => {
    expect(linkChordAnnouncement({ kind: "mark", sourceId: "t0" }, nameOf)).toBe(
      "task t0 marked as link source",
    );
    expect(linkChordAnnouncement({ kind: "create", sourceId: "t0", targetId: "t1" }, nameOf)).toBe(
      "Linked task t0 to task t1",
    );
    expect(linkChordAnnouncement({ kind: "cancel", sourceId: "t0" }, nameOf)).toBe(
      "Link creation cancelled",
    );
    expect(
      linkChordAnnouncement({ kind: "duplicate", sourceId: "t0", targetId: "t1" }, nameOf),
    ).toBe("task t0 is already linked to task t1");
  });
});
