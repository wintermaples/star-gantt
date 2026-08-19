/**
 * Fit-based label thinning.
 *
 *
 * When a row's labels do not fit their cells, the header labels only every n-th boundary — the
 * smallest n at which the labelled cells hold their labels — while grid separators stay one per
 * boundary. The labelled set is anchored on each boundary's absolute calendar index, so it does
 * not change while the user scrolls.
 */
import { afterEach, describe, expect, it } from "vitest";
import type { ZoomLevel } from "../../src/internal/timeline/index";
import type { TimelineConfig } from "../../src/config";
import { boot, wheelScroll } from "./_boot";
import type { Booted } from "./_boot";

let booted: Booted | null = null;

afterEach(() => {
  booted?.dom.restore();
  booted = null;
});

/** Tolerant membership check: the header's `tToX`/`xToT` round trips accumulate float noise. */
function containsClose(xs: number[], want: number): boolean {
  return xs.some((x) => Math.abs(x - want) < 1e-6);
}

/**
 * A single-row, 3 px-per-hour level: the fixed two-letter label "HH" (12 px at the fake context's
 * 6 px/char) plus 2*4px padding needs 20 px. Against 3 px cells that clears at n = 7 (21 px) and
 * fails at n = 6 (18 px) with a full pixel of margin either side — comfortably clear of the
 * float noise that a hairline (`required === n*cellWidth`) boundary would expose. 3 px/hour =
 * 72 px/day.
 */
const HOUR_LEVEL: ZoomLevel = {
  id: "hour-3px",
  pxPerDay: 72,
  scales: [{ unit: "hour", format: () => "HH" }],
};

function bootHourLevel(config: TimelineConfig = {}): Booted {
  const b = boot([], {}, { origin: 0, zoomLevels: [HOUR_LEVEL], ...config });
  booted = b;
  return b;
}

describe("smallest fitting n", () => {
  it("labels every boundary (n = 1) when labels already fit", () => {
    // Same level, but each hour is 40 px wide — "HH" (12 px) plus 2*4px padding fits easily.
    const b = boot([], {}, { origin: 0, zoomLevels: [{ ...HOUR_LEVEL, pxPerDay: 960 }] });
    booted = b;
    b.dom.flushFrames();
    const xs = b.header.context.texts.map((t) => t.x).sort((a, c) => a - c);
    // 40 px/hour, default padding 4: boundary 0 at x 0 -> label x 4; boundary 1 at x 40 -> 44; ...
    expect(xs.slice(0, 3)).toEqual([4, 44, 84]);
  });

  it("thins to the smallest n that lets every selected label fit", () => {
    const b = bootHourLevel();
    b.dom.flushFrames();
    // "HH" needs 20 px; at 3 px/hour cells that first clears at n = 7 (21 px, 6 fails at 18 px).
    // Every visible boundary's calendar index (hours since epoch) that is a multiple of 7 is
    // labelled; local x = calendarIndex*3 + 4 (scrollLeft is 0 at startup).
    const xs = b.header.context.texts.map((t) => t.x).sort((a, c) => a - c);
    expect(xs.slice(0, 4)).toEqual([4, 25, 46, 67]); // hours 0, 7, 14, 21
  });

  it("does not thin the grid separators — one tick per boundary regardless of n", () => {
    const b = bootHourLevel();
    b.dom.flushFrames();
    const separators = b.header.context.verticalXs();
    // The default viewport is 800 px wide at 3 px/hour: ~267 boundaries, none dropped.
    expect(separators.length).toBeGreaterThan(250);
    expect(b.header.context.texts.length).toBeLessThan(separators.length);
  });
});

describe("the labelled set is anchored on absolute calendar index", () => {
  it("keeps the same hours labelled after scrolling, not the first-visible one", () => {
    const b = bootHourLevel();
    b.dom.flushFrames();
    b.header.context.reset();

    // Scroll by 6 px (2 hours): hour 7 was labelled before, and stays labelled — now at local
    // x = 21 - 6 = 15, label x = 19 — rather than shifting to whichever boundary now leads.
    wheelScroll(b, 6);
    b.dom.flushFrames();
    const xs = b.header.context.texts.map((t) => t.x);
    expect(containsClose(xs, 19)).toBe(true); // hour 7 (calendar index 7, still a multiple of 7)
    // Hour 2, now the leading (partially scrolled-off) boundary, is not part of the labelled set
    // (2 is not a multiple of 7) and stays unlabelled — the anchor does not "pull in" whatever
    // boundary happens to lead the viewport.
    expect(containsClose(xs, 4)).toBe(false); // would be hour 2's label x if it were (wrongly) always labelled
  });
});

/**
 * A stepped row: each boundary spans two hours, so at 3 px/hour the cell is 6 px wide. "HH" (12
 * px) plus 2*4px padding needs 20 px, which first clears at n = 4 candidates apart (24 px);
 * n = 1..3 all fail (6, 12, 18 px). Candidates are already `step` calendar-index units apart, so
 * the labelled boundaries are calendar hours 0, 8, 16, ... (multiples of `n * step` = 8), not
 * hours 0, 4, 8 (multiples of the unmultiplied `n`).
 */
const STEPPED_HOUR_LEVEL: ZoomLevel = {
  id: "hour-2-3px",
  pxPerDay: 72,
  scales: [{ unit: "hour", step: 2, format: () => "HH" }],
};

function bootSteppedHourLevel(config: TimelineConfig = {}): Booted {
  const b = boot([], {}, { origin: 0, zoomLevels: [STEPPED_HOUR_LEVEL], ...config });
  booted = b;
  return b;
}

describe("thinning stride accounts for a row's own `step`", () => {
  it("labels every n-th boundary of the row's own sequence, not every n-th calendar unit", () => {
    const b = bootSteppedHourLevel();
    b.dom.flushFrames();
    // Local x = calendarIndex*3 + 4 (scrollLeft is 0 at startup).
    const xs = b.header.context.texts.map((t) => t.x).sort((a, c) => a - c);
    expect(xs.slice(0, 3)).toEqual([4, 28, 52]); // hours 0, 8, 16
  });

  it("keeps the same labelled hours after scrolling", () => {
    const b = bootSteppedHourLevel();
    b.dom.flushFrames();
    b.header.context.reset();

    // Scroll by 6 px (2 hours): hour 8 was labelled before, and stays labelled — now at local
    // x = 24 - 6 = 18, label x = 22 — rather than shifting to whichever boundary now leads.
    wheelScroll(b, 6);
    b.dom.flushFrames();
    const xs = b.header.context.texts.map((t) => t.x);
    expect(containsClose(xs, 22)).toBe(true); // hour 8, still a multiple of n*step (= 8)
    // Hour 2, now the leading (partially scrolled-off) boundary, is not part of the labelled set.
    expect(containsClose(xs, 4)).toBe(false);
  });
});

describe("interaction with the sticky leading label", () => {
  it("still applies the sticky rule when the leading boundary is itself in the thinned set", () => {
    // Scroll to hour 7 exactly (21 px): hour 7 (a multiple of 7) becomes the leading boundary, at
    // local x = 0 — not straddling, so it paints at its own cell edge plus padding.
    const b = bootHourLevel();
    booted = b;
    wheelScroll(b, 21);
    b.dom.flushFrames();
    const hour7 = b.header.context.texts.find((t) => Math.abs(t.x - 4) < 1e-6);
    expect(hour7?.text).toBe("HH");
  });
});
