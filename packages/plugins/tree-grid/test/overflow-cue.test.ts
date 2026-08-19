/**
 * `src/internal/overflow-cue.ts` — the horizontal-overflow cue: pure geometry → `data-overflow`
 * derivation, tested with plain recording objects the way `dom-walk.test.ts` tests its walks.
 */
import { describe, expect, it } from "vitest";
import { updateOverflowCue } from "../src/internal/overflow-cue";

/** A mutable geometry + attribute recorder: `updateOverflowCue` only ever sees this shape. */
interface Recorder {
  scrollLeft: number;
  scrollWidth: number;
  clientWidth: number;
  attr(): string | undefined;
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
}

function recorder(geometry: {
  scrollLeft: number;
  scrollWidth: number;
  clientWidth: number;
}): Recorder {
  let value: string | undefined;
  return {
    ...geometry,
    attr: () => value,
    setAttribute(name, v) {
      if (name === "data-overflow") value = v;
    },
    removeAttribute(name) {
      if (name === "data-overflow") value = undefined;
    },
  };
}

describe("updateOverflowCue", () => {
  it("removes the attribute when content fits without scrolling", () => {
    const el = recorder({ scrollLeft: 0, scrollWidth: 400, clientWidth: 400 });
    updateOverflowCue(el);
    expect(el.attr()).toBeUndefined();
  });

  it("marks 'end' when overflowing content is scrolled fully to the start", () => {
    const el = recorder({ scrollLeft: 0, scrollWidth: 800, clientWidth: 400 });
    updateOverflowCue(el);
    expect(el.attr()).toBe("end");
  });

  it("marks 'start' when scrolled fully to the overflowing end", () => {
    const el = recorder({ scrollLeft: 400, scrollWidth: 800, clientWidth: 400 });
    updateOverflowCue(el);
    expect(el.attr()).toBe("start");
  });

  it("marks 'both' when scrolled to the middle of overflowing content", () => {
    const el = recorder({ scrollLeft: 200, scrollWidth: 800, clientWidth: 400 });
    updateOverflowCue(el);
    expect(el.attr()).toBe("both");
  });

  it("ignores sub-pixel geometry noise at rest", () => {
    const el = recorder({ scrollLeft: 0, scrollWidth: 400.4, clientWidth: 400 });
    updateOverflowCue(el);
    expect(el.attr()).toBeUndefined();
  });

  it("removes a previously set attribute once content stops overflowing", () => {
    const el = recorder({ scrollLeft: 0, scrollWidth: 800, clientWidth: 400 });
    updateOverflowCue(el);
    expect(el.attr()).toBe("end");

    el.scrollWidth = 400;
    updateOverflowCue(el);
    expect(el.attr()).toBeUndefined();
  });

  it("re-derives from 'both' back down to 'end' as the scroll returns to the start", () => {
    const el = recorder({ scrollLeft: 200, scrollWidth: 800, clientWidth: 400 });
    updateOverflowCue(el);
    expect(el.attr()).toBe("both");

    el.scrollLeft = 0;
    updateOverflowCue(el);
    expect(el.attr()).toBe("end");
  });
});
