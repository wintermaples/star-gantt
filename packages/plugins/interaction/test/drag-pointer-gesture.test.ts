// Hostless unit tests for the pointer gesture's state and arithmetic
// (`src/internal/drag/pointer-gesture.ts`): no host, no fake DOM, no plugins — the module takes
// numbers and answers with values, so every rule about the 3px threshold, the Alt bypass and the
// snapped/unsnapped split is checked here directly.
import { describe, expect, it } from "vitest";
import type { DateGesture, MoveInput, ProgressGesture } from "../src/internal/drag/pointer-gesture";
import {
  DRAG_THRESHOLD_PX,
  applyMove,
  belongsTo,
  decideMove,
  deltaMsFor,
  exceedsThreshold,
  isCancelledCapture,
  mintCoalesceKey,
  progressOf,
  proposalAt,
  startGesture,
} from "../src/internal/drag/pointer-gesture";

// A press also records the box's edges against its own dates. This module never reads them (they
// belong to the ghost's geometry), so the values only have to be present and consistent.
const BAR = { left: 100, top: 40, width: 200, height: 20, startOffset: 0, endOffset: 0 };
const ORIGIN = { start: 1_000, end: 3_000 };

/** A press on the given part of a bar spanning 1000..3000 ms across 100..300 px. */
function press(
  hitKind: "bar" | "handle" | "progress",
  overrides: { grabbed?: number; progress?: number } = {},
) {
  return startGesture({
    hitKind,
    id: "t1",
    pointerId: 7,
    clientX: 150,
    clientY: 50,
    bar: BAR,
    coalesceKey: "key-1",
    origin: ORIGIN,
    progress: overrides.progress ?? 0.25,
    grabbed: overrides.grabbed ?? 1_100,
  });
}

/** A pointer position, with one pixel worth of time being one millisecond. */
function input(overrides: Partial<MoveInput> = {}): MoveInput {
  return {
    clientX: 150,
    clientY: 50,
    buttons: 1,
    altKey: false,
    x: 150,
    scrollLeft: 0,
    pxPerMs: 1,
    rounding: undefined,
    ...overrides,
  };
}

/** A rounding rule that snaps every instant down to a multiple of 500. */
const roundTo500 = { snap: (t: number): number => Math.floor(t / 500) * 500 };

describe("startGesture", () => {
  it("makes a press on a bar's body a move", () => {
    const gesture = press("bar");
    expect(gesture.kind).toBe("date");
    expect((gesture as DateGesture).mode).toBe("move");
  });

  it("recovers which end a handle press grabbed from the time under the pointer", () => {
    expect((press("handle", { grabbed: 1_100 }) as DateGesture).mode).toBe("resize-start");
    expect((press("handle", { grabbed: 2_900 }) as DateGesture).mode).toBe("resize-end");
    // A tie takes the start.
    expect((press("handle", { grabbed: 2_000 }) as DateGesture).mode).toBe("resize-start");
  });

  it("starts a date gesture at the task's own dates, with nothing dispatched yet", () => {
    const gesture = press("bar") as DateGesture;
    expect(gesture.origin).toEqual(ORIGIN);
    expect(gesture.range).toEqual(ORIGIN);
    expect(gesture.commit).toEqual(ORIGIN);
    expect(gesture.dispatched).toEqual(ORIGIN);
    expect(gesture.rounded).toBe(false);
    expect(gesture.dragging).toBe(false);
  });

  it("starts a progress gesture at the fraction the store already holds", () => {
    const gesture = press("progress", { progress: 0.4 }) as ProgressGesture;
    expect(gesture.kind).toBe("progress");
    expect(gesture.value).toBe(0.4);
    expect(gesture.dispatched).toBe(0.4);
    expect(gesture.dragging).toBe(false);
  });

  it("keeps the press's own pointer and coalesce key", () => {
    const gesture = press("bar");
    expect(gesture.pointerId).toBe(7);
    expect(gesture.coalesceKey).toBe("key-1");
    expect(belongsTo(gesture, 7)).toBe(true);
    expect(belongsTo(gesture, 8)).toBe(false);
  });
});

describe("mintCoalesceKey", () => {
  it("never repeats a key, so two drags of one task stay two undo entries", () => {
    const keys = new Set([
      mintCoalesceKey("p"),
      mintCoalesceKey("p"),
      mintCoalesceKey("p"),
      mintCoalesceKey("p"),
    ]);
    expect(keys.size).toBe(4);
    for (const key of keys) expect(key.startsWith("p:")).toBe(true);
  });
});

describe("the 3px threshold", () => {
  it("is exclusive: exactly 3px is still a click", () => {
    expect(DRAG_THRESHOLD_PX).toBe(3);
    expect(exceedsThreshold(3, 0)).toBe(false);
    expect(exceedsThreshold(0, -3)).toBe(false);
    expect(exceedsThreshold(3.1, 0)).toBe(true);
  });

  it("measures the diagonal, not either axis alone", () => {
    expect(exceedsThreshold(2, 2)).toBe(false);
    expect(exceedsThreshold(3, 3)).toBe(true);
  });

  it("keeps a wobbling press from becoming a drag", () => {
    const gesture = press("bar");
    expect(decideMove(gesture, input({ clientX: 152, clientY: 52 }))).toEqual({ type: "ignore" });
    expect(gesture.dragging).toBe(false);
  });

  it("stops applying once the drag is under way", () => {
    const gesture = press("bar");
    applyMove(gesture, decideMove(gesture, input({ clientX: 200 })));
    expect(gesture.dragging).toBe(true);
    // A 1px move now counts, because the gesture is already a drag.
    expect(decideMove(gesture, input({ clientX: 151 })).type).toBe("date");
  });
});

describe("deltaMsFor", () => {
  it("converts pixels travelled into milliseconds", () => {
    expect(deltaMsFor(200, 150, 0.5)).toBe(100);
    expect(deltaMsFor(100, 150, 2)).toBe(-25);
  });

  it("answers zero for a scale with no mapping, rather than a non-finite delta", () => {
    expect(deltaMsFor(200, 150, 0)).toBe(0);
    expect(deltaMsFor(200, 150, -1)).toBe(0);
  });
});

describe("proposalAt", () => {
  it("commits the unrounded instant when there is no rounding rule", () => {
    const gesture = press("bar") as DateGesture;
    const proposal = proposalAt(gesture, input({ clientX: 273 }));
    expect(proposal.range).toEqual({ start: 1_123, end: 3_123 });
    expect(proposal.commit).toEqual(proposal.range);
    expect(proposal.rounded).toBe(false);
  });

  it("draws the unsnapped band and commits the snapped dates when there is one", () => {
    const gesture = press("bar") as DateGesture;
    const proposal = proposalAt(gesture, input({ clientX: 273, rounding: roundTo500 }));
    expect(proposal.range).toEqual({ start: 1_123, end: 3_123 });
    expect(proposal.commit).toEqual({ start: 1_000, end: 3_000 });
    expect(proposal.rounded).toBe(true);
  });

  it("keeps the duration of a move and rounds only the start", () => {
    const gesture = press("bar") as DateGesture;
    const { commit } = proposalAt(gesture, input({ clientX: 1_000, rounding: roundTo500 }));
    expect(commit.end - commit.start).toBe(ORIGIN.end - ORIGIN.start);
  });

  it("never drags a resized end past the fixed one", () => {
    const gesture = press("handle", { grabbed: 2_900 }) as DateGesture;
    const { commit, range } = proposalAt(gesture, input({ clientX: -5_000 }));
    expect(range.end).toBe(ORIGIN.start);
    expect(commit.end).toBe(ORIGIN.start);
  });

  it("bypasses the rounding rule entirely while Alt is held", () => {
    const gesture = press("bar") as DateGesture;
    const held = proposalAt(gesture, input({ clientX: 273, altKey: true, rounding: roundTo500 }));
    expect(held.commit).toEqual({ start: 1_123, end: 3_123 });
    expect(held.rounded).toBe(false);
    // Releasing Alt mid-drag takes effect on the very next position.
    const released = proposalAt(gesture, input({ clientX: 273, rounding: roundTo500 }));
    expect(released.commit).toEqual({ start: 1_000, end: 3_000 });
    expect(released.rounded).toBe(true);
  });
});

describe("progressOf", () => {
  it("maps the pointer's position inside the bar to a fraction", () => {
    const gesture = press("progress") as ProgressGesture;
    expect(progressOf(gesture, 150, 0)).toBeCloseTo(0.25, 10);
    expect(progressOf(gesture, 200, 0)).toBeCloseTo(0.5, 10);
  });

  it("reads the pointer in content space, so a scrolled view still maps correctly", () => {
    const gesture = press("progress") as ProgressGesture;
    expect(progressOf(gesture, 100, 100)).toBeCloseTo(0.5, 10);
  });

  it("saturates instead of leaving 0..1", () => {
    const gesture = press("progress") as ProgressGesture;
    expect(progressOf(gesture, -500, 0)).toBe(0);
    expect(progressOf(gesture, 5_000, 0)).toBe(1);
  });
});

describe("decideMove", () => {
  it("abandons the drag when the pointer reports no button held", () => {
    const gesture = press("bar");
    expect(decideMove(gesture, input({ clientX: 400, buttons: 0 }))).toEqual({ type: "abandon" });
  });

  it("proposes dates for a date gesture and a fraction for a progress gesture", () => {
    const dates = press("bar");
    const decision = decideMove(dates, input({ clientX: 200 }));
    expect(decision.type).toBe("date");

    const progress = press("progress");
    const progressDecision = decideMove(progress, input({ clientX: 200, x: 200 }));
    expect(progressDecision).toEqual({ type: "progress", value: 0.5 });
  });
});

describe("applyMove", () => {
  it("writes what the ghost draws and what a release would commit", () => {
    const gesture = press("bar") as DateGesture;
    applyMove(gesture, decideMove(gesture, input({ clientX: 273, rounding: roundTo500 })));
    expect(gesture.dragging).toBe(true);
    expect(gesture.range).toEqual({ start: 1_123, end: 3_123 });
    expect(gesture.commit).toEqual({ start: 1_000, end: 3_000 });
    expect(gesture.rounded).toBe(true);
    // What the store already holds is untouched — dispatching is the caller's decision.
    expect(gesture.dispatched).toEqual(ORIGIN);
  });

  it("writes the fraction of a progress drag", () => {
    const gesture = press("progress") as ProgressGesture;
    applyMove(gesture, decideMove(gesture, input({ clientX: 200, x: 200 })));
    expect(gesture.dragging).toBe(true);
    expect(gesture.value).toBe(0.5);
    expect(gesture.dispatched).toBe(0.25);
  });

  it("changes nothing for a decision that is not a proposal", () => {
    const gesture = press("bar") as DateGesture;
    applyMove(gesture, { type: "ignore" });
    applyMove(gesture, { type: "abandon" });
    expect(gesture.dragging).toBe(false);
    expect(gesture.range).toEqual(ORIGIN);
  });

  it("ignores a decision meant for the other kind of gesture", () => {
    const dates = press("bar") as DateGesture;
    applyMove(dates, { type: "progress", value: 0.9 });
    expect(dates.dragging).toBe(false);

    const progress = press("progress") as ProgressGesture;
    applyMove(progress, {
      type: "date",
      proposal: { range: ORIGIN, commit: ORIGIN, rounded: false },
    });
    expect(progress.dragging).toBe(false);
    expect(progress.value).toBe(0.25);
  });
});

describe("isCancelledCapture", () => {
  it("tells a cancelled capture apart from a release", () => {
    expect(isCancelledCapture("pointercancel")).toBe(true);
    expect(isCancelledCapture("pointerup")).toBe(false);
  });
});
