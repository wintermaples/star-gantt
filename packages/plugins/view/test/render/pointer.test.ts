/**
 * Hostless unit tests for the pointer machines: the single-owner claim, the
 * gesture machine and the once-per-frame hover resolution, driven against a fake pane.
 */
import { describe, expect, it, vi } from "vitest";
import {
  capturePointer,
  createGestureMachine,
  createHoverMachine,
  createPointerClaim,
  isChartSurfaceTarget,
  releasePointer,
  sameHit,
} from "../../src/internal/render/pointer";
import type { GestureSink, PointerClaim } from "../../src/internal/render/pointer";
import type { HitResult } from "../../src/internal/render/index";
import { FakeDocument, asElement, asPointerEvent, pointerEvent as pointerDouble } from "../_utils/index";
import type { PointerInit } from "../_utils/index";

/**
 * A `PointerEvent`-typed double.
 *
 * The shared harness hands back a plain `PointerDouble` and leaves the cast to the call site (the
 * fork cast internally), while these machines take the real DOM type.
 */
const pointerEvent = (clientX: number, clientY: number, init?: PointerInit): PointerEvent =>
  asPointerEvent(pointerDouble(clientX, clientY, init));

const bar: HitResult = { kind: "bar", id: "t1", cursor: "move" };

function pane(): { el: ReturnType<FakeDocument["createElement"]>; html: HTMLElement } {
  const el = new FakeDocument().createElement("div");
  return { el, html: asElement(el) };
}

/** Records every emitted event as a `[name, hit, x, y]` tuple. */
function recorder(): { sink: GestureSink; seen: [string, string | undefined, number, number][] } {
  const seen: [string, string | undefined, number, number][] = [];
  const push = (name: string) => (hit: HitResult | undefined, x: number, y: number) => {
    seen.push([name, hit?.id as string | undefined, x, y]);
  };
  return {
    seen,
    sink: {
      barDown: (hit, x, y) => push("barDown")(hit, x, y),
      background: (x, y) => push("background")(undefined, x, y),
      barMove: push("barMove"),
      barUp: push("barUp"),
    },
  };
}

describe("createPointerClaim", () => {
  it("grants the claim to the first machine and refuses every other", () => {
    const claim = createPointerClaim();
    expect(claim.claim("gesture")).toBe(true);
    expect(claim.claim("thumb")).toBe(false);
    expect(claim.holder()).toBe("gesture");
  });

  it("is re-entrant for the holder, so a machine can re-claim what it already owns", () => {
    const claim = createPointerClaim();
    claim.claim("thumb");
    expect(claim.claim("thumb")).toBe(true);
  });

  it("frees the pointer only for the machine that holds it", () => {
    const claim = createPointerClaim();
    claim.claim("thumb");
    claim.release("gesture");
    expect(claim.holder()).toBe("thumb");
    claim.release("thumb");
    expect(claim.holder()).toBeNull();
    expect(claim.claim("gesture")).toBe(true);
  });
});

describe("pointer capture helpers", () => {
  it("captures and releases, and tolerates a pointerless or already-released host", () => {
    const { el, html } = pane();
    capturePointer(html, 7);
    expect(el.captured).toEqual([7]);
    releasePointer(html, 7);
    expect(el.captured).toEqual([]);
    // Releasing twice, and capturing with no pointer id, must not throw.
    releasePointer(html, 7);
    capturePointer(html, undefined);
    expect(el.captured).toEqual([]);
  });
});

describe("isChartSurfaceTarget", () => {
  /** A pane with two layer canvases, a DOM-overlay branch and a corner widget branch. */
  function tree() {
    const doc = new FakeDocument();
    const paneEl = doc.createElement("div");
    const background = doc.createElement("canvas");
    const main = doc.createElement("canvas");
    paneEl.appendChild(background);
    paneEl.appendChild(main);

    const domOverlay = doc.createElement("div");
    paneEl.appendChild(domOverlay);
    const wrapper = doc.createElement("div");
    domOverlay.appendChild(wrapper);
    const overlayButton = doc.createElement("button");
    wrapper.appendChild(overlayButton);

    const corner = doc.createElement("div");
    paneEl.appendChild(corner);
    const cornerButton = doc.createElement("button");
    corner.appendChild(cornerButton);

    return { paneEl, canvases: [background, main], main, overlayButton, cornerButton, corner, doc };
  }

  it("accepts the pane itself and any layer canvas", () => {
    const t = tree();
    expect(isChartSurfaceTarget(t.paneEl, t.paneEl, t.canvases)).toBe(true);
    expect(isChartSurfaceTarget(t.main, t.paneEl, t.canvases)).toBe(true);
  });

  it("rejects a target inside the DOM-overlay branch, however deep", () => {
    const t = tree();
    expect(isChartSurfaceTarget(t.overlayButton, t.paneEl, t.canvases)).toBe(false);
  });

  it("rejects a corner-slot child mounted straight into the pane", () => {
    const t = tree();
    expect(isChartSurfaceTarget(t.corner, t.paneEl, t.canvases)).toBe(false);
    expect(isChartSurfaceTarget(t.cornerButton, t.paneEl, t.canvases)).toBe(false);
  });

  it("treats a missing target, or one outside the pane, as chart input", () => {
    const t = tree();
    const stranger = t.doc.createElement("div");
    expect(isChartSurfaceTarget(undefined, t.paneEl, t.canvases)).toBe(true);
    expect(isChartSurfaceTarget(null, t.paneEl, t.canvases)).toBe(true);
    expect(isChartSurfaceTarget(stranger, t.paneEl, t.canvases)).toBe(true);
  });
});

describe("createGestureMachine", () => {
  function machine(hitAt: (x: number, y: number) => HitResult | undefined, claim?: PointerClaim) {
    const { el, html } = pane();
    const { sink, seen } = recorder();
    const onStart = vi.fn();
    const gestures = createGestureMachine({
      pane: html,
      claim: claim ?? createPointerClaim(),
      localPoint: (e) => ({ x: e.clientX, y: e.clientY }),
      hitAt,
      sink,
      onStart,
    });
    return { el, gestures, seen, onStart };
  }

  it("emits barDown, captures the pointer and freezes the hit for the gesture", () => {
    const { el, gestures, seen, onStart } = machine(() => bar);
    gestures.onDown(pointerEvent(10, 20, { pointerId: 3 }));
    expect(seen).toEqual([["barDown", "t1", 10, 20]]);
    expect(el.captured).toEqual([3]);
    expect(onStart).toHaveBeenCalledTimes(1);
    expect(gestures.active()).toBe(true);

    // The hit is frozen: the tester is not consulted again mid-gesture.
    expect(gestures.onMove(pointerEvent(11, 25, { pointerId: 3 }))).toBe(true);
    gestures.onEnd(pointerEvent(12, 30, { pointerId: 3 }));
    expect(seen.slice(1)).toEqual([
      ["barMove", "t1", 11, 25],
      ["barUp", "t1", 12, 30],
    ]);
    expect(el.captured).toEqual([]);
    expect(gestures.active()).toBe(false);
  });

  it("starts a hit-less gesture from empty space, with no hit on move or up", () => {
    const { gestures, seen } = machine(() => undefined);
    gestures.onDown(pointerEvent(4, 5));
    gestures.onMove(pointerEvent(6, 7));
    gestures.onEnd(pointerEvent(8, 9));
    expect(seen).toEqual([
      ["background", undefined, 4, 5],
      ["barMove", undefined, 6, 7],
      ["barUp", undefined, 8, 9],
    ]);
  });

  it("reports a move outside a gesture as unhandled, so the caller can record a hover", () => {
    const { gestures } = machine(() => bar);
    expect(gestures.onMove(pointerEvent(1, 1))).toBe(false);
  });

  it("emits nothing on a release the gesture does not own", () => {
    const { gestures, seen } = machine(() => bar);
    gestures.onDown(pointerEvent(0, 0, { pointerId: 1 }));
    gestures.onEnd(pointerEvent(0, 0, { pointerId: 2 }));
    expect(seen.map((e) => e[0])).toEqual(["barDown"]);
    expect(gestures.active()).toBe(true);
  });

  it("ignores a second pointer pressed during a gesture", () => {
    const { gestures, seen } = machine(() => bar);
    gestures.onDown(pointerEvent(0, 0, { pointerId: 1 }));
    gestures.onDown(pointerEvent(50, 50, { pointerId: 2 }));
    expect(seen.map((e) => e[0])).toEqual(["barDown"]);
  });

  it("closes a stale gesture with its single barUp when the same pointer presses again", () => {
    const { gestures, seen } = machine(() => bar);
    gestures.onDown(pointerEvent(0, 0, { pointerId: 1 }));
    gestures.onDown(pointerEvent(9, 9, { pointerId: 1 }));
    expect(seen.map((e) => e[0])).toEqual(["barDown", "barUp", "barDown"]);
  });

  it("emits exactly one barUp per gesture, even for two releases", () => {
    const { gestures, seen } = machine(() => bar);
    gestures.onDown(pointerEvent(0, 0));
    gestures.onEnd(pointerEvent(1, 1));
    gestures.onEnd(pointerEvent(2, 2));
    expect(seen.filter((e) => e[0] === "barUp")).toHaveLength(1);
  });

  it("starts nothing while another machine holds the pointer claim", () => {
    const claim = createPointerClaim();
    claim.claim("thumb");
    const { el, gestures, seen } = machine(() => bar, claim);

    gestures.onDown(pointerEvent(10, 20, { pointerId: 3 }));
    expect(seen).toEqual([]);
    expect(el.captured).toEqual([]);
    expect(gestures.active()).toBe(false);
  });

  it("frees the claim when the gesture ends, so the next press is granted it", () => {
    const claim = createPointerClaim();
    const { gestures } = machine(() => bar, claim);
    gestures.onDown(pointerEvent(0, 0));
    expect(claim.holder()).toBe("gesture");
    gestures.onEnd(pointerEvent(0, 0));
    expect(claim.holder()).toBeNull();
  });
});

describe("createHoverMachine", () => {
  function machine(hitAt: (x: number, y: number) => HitResult | undefined, claim?: PointerClaim) {
    const hovers: [string | undefined, number, number][] = [];
    const cursors: string[] = [];
    const localPoint = vi.fn((e: { clientX: number; clientY: number }) => ({
      x: e.clientX,
      y: e.clientY,
    }));
    const hover = createHoverMachine({
      claim: claim ?? createPointerClaim(),
      localPoint,
      hitAt,
      onHover: (hit, x, y) => hovers.push([hit?.id as string | undefined, x, y]),
      setCursor: (cursor) => cursors.push(cursor),
    });
    return { hover, hovers, cursors, localPoint };
  }

  it("resolves the latest recorded position once, not once per recorded move", () => {
    const hits = vi.fn(() => bar);
    const { hover, hovers, localPoint } = machine(hits);
    hover.record({ clientX: 1, clientY: 1 });
    hover.record({ clientX: 2, clientY: 2 });
    hover.record({ clientX: 3, clientY: 3 });
    hover.resolve();

    expect(hovers).toEqual([["t1", 3, 3]]);
    expect(hits).toHaveBeenCalledTimes(1);
    expect(localPoint).toHaveBeenCalledTimes(1);
  });

  it("resolves nothing without a recorded move", () => {
    const { hover, hovers } = machine(() => bar);
    hover.resolve();
    expect(hovers).toEqual([]);
  });

  it("emits only when the resolved target changed, including off every shape", () => {
    let hit: HitResult | undefined = bar;
    const { hover, hovers } = machine(() => hit);
    hover.record({ clientX: 1, clientY: 1 });
    hover.resolve();
    hover.record({ clientX: 2, clientY: 2 });
    hover.resolve();
    expect(hovers).toEqual([["t1", 1, 1]]);

    hit = undefined;
    hover.record({ clientX: 3, clientY: 3 });
    hover.resolve();
    expect(hovers).toEqual([
      ["t1", 1, 1],
      [undefined, 3, 3],
    ]);
  });

  it("writes the cursor only when its value changes", () => {
    let hit: HitResult | undefined = bar;
    const { hover, cursors } = machine(() => hit);
    hover.record({ clientX: 1, clientY: 1 });
    hover.resolve();
    hover.record({ clientX: 2, clientY: 2 });
    hover.resolve();
    expect(cursors).toEqual(["move"]);

    hit = undefined;
    hover.record({ clientX: 3, clientY: 3 });
    hover.resolve();
    expect(cursors).toEqual(["move", ""]);
  });

  it("resolves nothing while any machine owns the pointer, and keeps the record for later", () => {
    const claim = createPointerClaim();
    const { hover, hovers } = machine(() => bar, claim);
    claim.claim("gesture");
    hover.record({ clientX: 5, clientY: 6 });
    hover.resolve();
    expect(hovers).toEqual([]);

    claim.release("gesture");
    hover.resolve();
    expect(hovers).toEqual([["t1", 5, 6]]);
  });

  it("drops a recorded position on discard", () => {
    const { hover, hovers } = machine(() => bar);
    hover.record({ clientX: 5, clientY: 6 });
    hover.discard();
    hover.resolve();
    expect(hovers).toEqual([]);
  });
});

describe("sameHit", () => {
  it("compares kind, id and cursor, and treats absence as a target of its own", () => {
    expect(sameHit(bar, { ...bar })).toBe(true);
    expect(sameHit(bar, { ...bar, id: "t2" })).toBe(false);
    expect(sameHit(bar, { ...bar, cursor: "ew-resize" })).toBe(false);
    expect(sameHit(bar, { ...bar, kind: "handle" })).toBe(false);
    expect(sameHit(undefined, undefined)).toBe(true);
    expect(sameHit(bar, undefined)).toBe(false);
  });
});
