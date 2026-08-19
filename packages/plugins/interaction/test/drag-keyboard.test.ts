// Hostless unit tests for the keyboard equivalents' arithmetic (`src/internal/drag/keyboard.ts`): the
// chord table and what one press computes, without a host, a focus owner or a key-binding point.
import { MS_DAY } from "@stargantt/sdk";
import { describe, expect, it } from "vitest";
import type { Stepping } from "../src/internal/drag/keyboard";
import {
  EDIT_KEYS,
  PROGRESS_KEYS,
  PROGRESS_STEP,
  nextProgress,
  steppedRange,
  stepFrom,
} from "../src/internal/drag/keyboard";

const ORIGIN = { start: 4 * MS_DAY, end: 6 * MS_DAY };

/** A rounding rule that steps by hours and snaps down to the hour. */
const HOUR = 3_600_000;
const hourly: Stepping = {
  snap: (t) => Math.floor(t / HOUR) * HOUR,
  step: (_t, direction) => direction * HOUR,
};

describe("the chord table", () => {
  it("covers all eight chords, each one distinct", () => {
    const keys = [...EDIT_KEYS, ...PROGRESS_KEYS].map((entry) => entry.key);
    expect(keys).toHaveLength(8);
    expect(new Set(keys).size).toBe(8);
  });

  it("moves on Ctrl+Arrow, resizes the end on Ctrl+Shift+Arrow, the start on Ctrl+Alt+Arrow", () => {
    expect(EDIT_KEYS).toEqual([
      { key: "Ctrl+ArrowRight", mode: "move", direction: 1 },
      { key: "Ctrl+ArrowLeft", mode: "move", direction: -1 },
      { key: "Ctrl+Shift+ArrowRight", mode: "resize-end", direction: 1 },
      { key: "Ctrl+Shift+ArrowLeft", mode: "resize-end", direction: -1 },
      { key: "Ctrl+Alt+ArrowRight", mode: "resize-start", direction: 1 },
      { key: "Ctrl+Alt+ArrowLeft", mode: "resize-start", direction: -1 },
    ]);
    expect(PROGRESS_KEYS).toEqual([
      { key: "Ctrl+Shift+ArrowUp", direction: 1 },
      { key: "Ctrl+Shift+ArrowDown", direction: -1 },
    ]);
  });
});

describe("stepFrom", () => {
  it("steps by one UTC day when the composition has no rounding rule", () => {
    expect(stepFrom(0, 1, undefined)).toBe(MS_DAY);
    expect(stepFrom(0, -1, undefined)).toBe(-MS_DAY);
  });

  it("asks the rounding rule how far one step goes when there is one", () => {
    const asked: { t: number; direction: number }[] = [];
    const rule: Stepping = {
      snap: (t) => t,
      step: (t, direction) => {
        asked.push({ t, direction });
        return direction * 7 * MS_DAY;
      },
    };
    expect(stepFrom(1_234, 1, rule)).toBe(7 * MS_DAY);
    expect(asked).toEqual([{ t: 1_234, direction: 1 }]);
  });
});

describe("steppedRange", () => {
  it("moves the whole task by one step, keeping its duration", () => {
    const range = steppedRange("move", ORIGIN, 1, undefined);
    expect(range).toEqual({ start: 5 * MS_DAY, end: 7 * MS_DAY });
  });

  it("drags only the end when resizing, leaving the start alone", () => {
    const range = steppedRange("resize-end", ORIGIN, -1, undefined);
    expect(range).toEqual({ start: 4 * MS_DAY, end: 5 * MS_DAY });
  });

  it("never drags the end past the start", () => {
    // One day back from a one-day task lands the end on the start, and a step that would overshoot
    // it clamps there too — the task is never turned inside out.
    expect(steppedRange("resize-end", { start: 0, end: MS_DAY }, -1, undefined)).toEqual({
      start: 0,
      end: 0,
    });
    expect(steppedRange("resize-end", { start: 0, end: MS_DAY / 2 }, -1, undefined)).toEqual({
      start: 0,
      end: 0,
    });
    // Once collapsed, a further press changes nothing.
    expect(steppedRange("resize-end", { start: 0, end: 0 }, -1, undefined)).toBeUndefined();
  });

  it("measures the step from the edge the chord drags", () => {
    const measured: number[] = [];
    const rule: Stepping = {
      snap: (t) => t,
      step: (t, direction) => {
        measured.push(t);
        return direction * HOUR;
      },
    };
    steppedRange("move", ORIGIN, 1, rule);
    steppedRange("resize-end", ORIGIN, 1, rule);
    expect(measured).toEqual([ORIGIN.start, ORIGIN.end]);
  });

  it("rounds the stepped instant with the same rule the pointer path uses", () => {
    const origin = { start: 90 * 60_000, end: 150 * 60_000 };
    // Stepping an hour forward from 01:30 lands on 02:30, which the rule rounds down to 02:00; the
    // duration follows the rounded start.
    expect(steppedRange("move", origin, 1, hourly)).toEqual({
      start: 2 * HOUR,
      end: 2 * HOUR + 60 * 60_000,
    });
  });

  it("answers undefined when the press would land the task exactly where it is", () => {
    const rule: Stepping = { snap: (t) => t, step: () => 0 };
    expect(steppedRange("move", ORIGIN, 1, rule)).toBeUndefined();
    expect(steppedRange("resize-end", ORIGIN, 1, rule)).toBeUndefined();
  });
});

describe("nextProgress", () => {
  it("steps the completion by ten percentage points", () => {
    expect(PROGRESS_STEP).toBe(0.1);
    expect(nextProgress(0.2, 1)).toBe(0.3);
    expect(nextProgress(0.2, -1)).toBe(0.1);
  });

  it("clamps to 0..1", () => {
    expect(nextProgress(0.95, 1)).toBe(1);
    expect(nextProgress(0.05, -1)).toBe(0);
    // A press at either end answers the stored value itself, which is how the caller knows to
    // dispatch nothing.
    expect(nextProgress(1, 1)).toBe(1);
    expect(nextProgress(0, -1)).toBe(0);
  });

  it("does not accumulate binary-fraction drift", () => {
    let value = 0;
    for (let press = 0; press < 10; press += 1) value = nextProgress(value, 1);
    expect(value).toBe(1);
    expect(nextProgress(0.1, 1)).toBe(0.2);
    expect(nextProgress(0.7, 1)).toBe(0.8);
  });
});
