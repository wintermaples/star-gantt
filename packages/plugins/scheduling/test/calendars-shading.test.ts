/**
 * `internal/calendars/shading.ts` — the order-8 non-working shading layer and the §6.2
 * minimum-band-width guard, restated normatively there because v2's view.md does not carry it.
 *
 * Pure and hostless: `createShadingLayer` takes plain callbacks (`shading.ts`'s own `ShadingDeps` —
 * narrow `Pick`s over the real `@stargantt/plugin-view` service types, not a hand-mirrored
 * structural type), never a `PluginContext` or a real canvas, so every test here supplies recording
 * doubles — a fake 2D context that records `fillRect` calls, and fake timeline/theme objects — with
 * no `Gantt.create` anywhere in this file.
 */
import { describe, expect, it } from "vitest";
import { nonWorkingIntervals } from "@stargantt/sdk";
import type { CalendarDef } from "@stargantt/plugin-data-store";
import { createShadingLayer } from "../src/internal/calendars/shading";
import type { ShadingDeps } from "../src/internal/calendars/shading";

const DAY = 86_400_000;
const HOUR = 3_600_000;
/** 1970-01-05 was a Monday. */
const MON = 4 * DAY;

interface RectCall {
  x: number;
  y: number;
  w: number;
  h: number;
  fill: string;
}

/** A minimal fake 2D context recording every `fillRect`, with the `fillStyle` active at the time. */
function fakeContext(): { g: CanvasRenderingContext2D; calls: RectCall[] } {
  const calls: RectCall[] = [];
  let fillStyle = "";
  const g = {
    save(): void {},
    restore(): void {},
    get fillStyle(): string {
      return fillStyle;
    },
    set fillStyle(v: string) {
      fillStyle = v;
    },
    fillRect(x: number, y: number, w: number, h: number): void {
      calls.push({ x, y, w, h, fill: fillStyle });
    },
  } as unknown as CanvasRenderingContext2D;
  return { g, calls };
}

/** A timeline whose origin is epoch 0, at a chosen density. */
function fakeTimeline(pxPerMs: number): { pxPerMs: number; tToX(t: number): number; xToT(x: number): number } {
  return { pxPerMs, tToX: (t) => t * pxPerMs, xToT: (x) => x / pxPerMs };
}

const VIEWPORT_HEIGHT = 240;

function deps(over: Partial<ShadingDeps>): ShadingDeps {
  return {
    shadeCalendarId: () => undefined,
    resolve: () => undefined,
    timeline: () => undefined,
    theme: () => undefined,
    ...over,
  };
}

describe("no-op paths", () => {
  it("draws nothing when no shade calendar resolves", () => {
    const { g, calls } = fakeContext();
    const layer = createShadingLayer(deps({ shadeCalendarId: () => undefined }));
    layer.draw(g, { scrollLeft: 0, scrollTop: 0, width: 400, height: VIEWPORT_HEIGHT });
    expect(calls).toEqual([]);
  });

  it("draws nothing when the shade calendar id does not resolve to a definition", () => {
    const { g, calls } = fakeContext();
    const layer = createShadingLayer(
      deps({ shadeCalendarId: () => "missing", resolve: () => undefined, timeline: () => fakeTimeline(1) }),
    );
    layer.draw(g, { scrollLeft: 0, scrollTop: 0, width: 400, height: VIEWPORT_HEIGHT });
    expect(calls).toEqual([]);
  });

  it("draws nothing without a timeline service (absent-tolerant, §14)", () => {
    const cal: CalendarDef = { id: "wd", workingDays: [1, 2, 3, 4, 5] };
    const { g, calls } = fakeContext();
    const layer = createShadingLayer(
      deps({ shadeCalendarId: () => "wd", resolve: () => cal, timeline: () => undefined }),
    );
    layer.draw(g, { scrollLeft: 0, scrollTop: 0, width: 400, height: VIEWPORT_HEIGHT });
    expect(calls).toEqual([]);
  });
});

describe("gate 1 — the pass gate (§6.2 rule 1)", () => {
  it("draws nothing at all while a day column is under 3 CSS px wide", () => {
    const cal: CalendarDef = { id: "wd", workingDays: [1, 2, 3, 4, 5] };
    const { g, calls } = fakeContext();
    // pxPerDay = 2 (< 3) — the day-granular calendar has plenty of non-working days in range, but
    // the whole pass must still draw nothing.
    const layer = createShadingLayer(
      deps({ shadeCalendarId: () => "wd", resolve: () => cal, timeline: () => fakeTimeline(2 / DAY) }),
    );
    layer.draw(g, { scrollLeft: 0, scrollTop: 0, width: 4000, height: VIEWPORT_HEIGHT });
    expect(calls).toEqual([]);
  });

  it("draws once the day column reaches exactly 3 CSS px", () => {
    const cal: CalendarDef = { id: "wd", workingDays: [1, 2, 3, 4, 5] };
    const { g, calls } = fakeContext();
    const layer = createShadingLayer(
      deps({ shadeCalendarId: () => "wd", resolve: () => cal, timeline: () => fakeTimeline(3 / DAY) }),
    );
    layer.draw(g, { scrollLeft: 0, scrollTop: 0, width: 4000, height: VIEWPORT_HEIGHT });
    expect(calls.length).toBeGreaterThan(0);
  });
});

describe("gate 2 — the per-band gate, and the both-ends-qualify rule (§6.2 rules 2–3)", () => {
  it("omits a narrow band whose one end is whole-day-aligned but the other is not", () => {
    // Working 01:00–24:00 every weekday: each day's own gap is exactly the first hour — start is a
    // UTC midnight (aligned), end is 01:00 (not aligned, and not the query bound either) — one
    // aligned end is not enough (§6.2 rule 3: BOTH must qualify), so this band is intra-day and
    // subject to gate 2.
    const cal: CalendarDef = {
      id: "late-open",
      workingDays: [1, 2, 3, 4, 5],
      workingHours: [[1 * HOUR, 24 * HOUR]],
    };
    const { g, calls } = fakeContext();
    // pxPerDay exactly 3 (gate 1 passes); the 1-hour gap is then 3/24 = 0.125 CSS px — well under
    // the 3 px per-band threshold, so it must be omitted entirely, never widened.
    const layer = createShadingLayer(
      deps({ shadeCalendarId: () => "late-open", resolve: () => cal, timeline: () => fakeTimeline(3 / DAY) }),
    );
    // `scrollLeft` is the horizontal offset (px, `pxPerMs * MON` at this density) — a bare `MON`
    // (a raw ms instant) belongs there, not in `scrollTop` (vertical, unused by this pass): the
    // mistake previously left `from` at epoch 0 instead of the intended Monday window, so the
    // assertion loop below ran over zero draws and passed vacuously regardless of the guard it
    // meant to verify.
    layer.draw(g, {
      scrollLeft: (3 / DAY) * MON,
      scrollTop: 0,
      width: 20 * 3 /* ~20 days */,
      height: VIEWPORT_HEIGHT,
    });
    // The weekend (Sat 00:00–Mon 01:00) IS whole-day-aligned at its start only too, but is wide
    // (over a day), so gate 2 never suppresses it; the narrow per-weekday 1h gaps must all be
    // absent from what was drawn.
    expect(calls.length).toBeGreaterThan(0); // the fix must actually exercise the guard below
    for (const call of calls) {
      // Every drawn rect is at least the 3px per-band width in this configuration, or belongs to a
      // whole span far wider than one hour — nothing 0.125px wide made it through.
      expect(call.w).toBeGreaterThanOrEqual(3 - 1e-6);
    }
  });

  it("never widens or merges an omitted band — it is simply missing, not clamped up", () => {
    const cal: CalendarDef = {
      id: "lunch",
      workingDays: [1, 2, 3, 4, 5],
      workingHours: [
        [9 * HOUR, 12 * HOUR],
        [13 * HOUR, 17 * HOUR],
      ],
    };
    const { g, calls } = fakeContext();
    // The 1-hour lunch gap is intra-day both ends (12:00 and 13:00, neither midnight nor a query
    // bound); at this density it is under 3px and must vanish rather than reappear at 3px wide.
    const pxPerMs = 3 / DAY;
    const layer = createShadingLayer(
      deps({ shadeCalendarId: () => "lunch", resolve: () => cal, timeline: () => fakeTimeline(pxPerMs) }),
    );
    const vp = { scrollLeft: MON * pxPerMs, scrollTop: 0, width: 2 * DAY * pxPerMs, height: VIEWPORT_HEIGHT };
    layer.draw(g, vp);
    const lunchWidthPx = pxPerMs * HOUR;
    expect(lunchWidthPx).toBeLessThan(3);
    expect(calls.some((c) => Math.abs(c.w - lunchWidthPx) < 1e-6)).toBe(false);
  });
});

describe("whole-day alignment judged per end, with the clipped-edge exemption (§6.2 rule 3)", () => {
  it("draws a band the viewport clipped at its end, however narrow the remainder is", () => {
    // A known regression case: at 40 px/day an 81 px viewport ends 1 px into a non-working day. The
    // engine clips the trailing band to `to`, so its end fails the midnight-modulo test but equals
    // the query's own `to` — the exemption keeps it drawn although it is under the 3px threshold.
    const cal: CalendarDef = { id: "wd", workingDays: [1, 2, 3, 4, 5] };
    const pxPerMs = 40 / DAY;
    const { g, calls } = fakeContext();
    const layer = createShadingLayer(
      deps({ shadeCalendarId: () => "wd", resolve: () => cal, timeline: () => fakeTimeline(pxPerMs) }),
    );
    layer.draw(g, { scrollLeft: 0, scrollTop: 0, width: 81, height: VIEWPORT_HEIGHT });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.w).toBeCloseTo(1, 5);
    expect(calls[0]?.x).toBeCloseTo(2 * DAY * pxPerMs, 5);
  });

  it("draws a band the viewport clipped at its start, symmetrically", () => {
    const cal: CalendarDef = { id: "wd", workingDays: [1, 2, 3, 4, 5] };
    const pxPerMs = 40 / DAY;
    const { g, calls } = fakeContext();
    const layer = createShadingLayer(
      deps({ shadeCalendarId: () => "wd", resolve: () => cal, timeline: () => fakeTimeline(pxPerMs) }),
    );
    // Query starts 1px into Saturday (a non-working day): the leading edge of the weekend band is
    // clipped to `from`, which is not midnight-aligned, but the exemption still counts it.
    const scrollLeft = (MON + 5 * DAY) * pxPerMs + 1;
    layer.draw(g, { scrollLeft, scrollTop: 0, width: 400, height: VIEWPORT_HEIGHT });
    expect(calls[0]?.x).toBe(0); // clamped to the viewport's own left edge
    expect(calls[0]?.w).toBeCloseTo(2 * DAY * pxPerMs - 1, 3);
  });
});

describe("day-granular degrade (§6.2 rule 4)", () => {
  it("renders a windowless calendar byte-identically to the whole-day-column picture", () => {
    const cal: CalendarDef = { id: "wd", workingDays: [1, 2, 3, 4, 5] };
    const pxPerMs = 12 / DAY;
    const { g, calls } = fakeContext();
    const layer = createShadingLayer(
      deps({ shadeCalendarId: () => "wd", resolve: () => cal, timeline: () => fakeTimeline(pxPerMs) }),
    );
    const vp = { scrollLeft: 0, scrollTop: 0, width: 14 * DAY * pxPerMs, height: VIEWPORT_HEIGHT };
    layer.draw(g, vp);
    const from = 0;
    const to = vp.width / pxPerMs;
    const expected = nonWorkingIntervals(cal, from, to);
    expect(calls).toHaveLength(expected.length);
    for (const [i, range] of expected.entries()) {
      expect(calls[i]?.x).toBeCloseTo(range.start * pxPerMs, 5);
      expect(calls[i]?.w).toBeCloseTo((range.end - range.start) * pxPerMs, 5);
      expect(calls[i]?.y).toBe(0);
      expect(calls[i]?.h).toBe(VIEWPORT_HEIGHT);
    }
  });
});

describe("color resolution", () => {
  const cal: CalendarDef = { id: "wd", workingDays: [1, 2, 3, 4, 5] };

  it("falls back to a translucent red when no theme resolves the token", () => {
    const { g, calls } = fakeContext();
    const layer = createShadingLayer(
      deps({
        shadeCalendarId: () => "wd",
        resolve: () => cal,
        timeline: () => fakeTimeline(20 / DAY),
        theme: () => ({ get: () => "" }),
      }),
    );
    layer.draw(g, { scrollLeft: 0, scrollTop: 0, width: 2000, height: VIEWPORT_HEIGHT });
    expect(calls[0]?.fill).toBe("rgba(220, 38, 38, 0.08)");
  });

  it("uses the theme's `--sg-calendar-nonworking` token when it resolves", () => {
    const { g, calls } = fakeContext();
    const layer = createShadingLayer(
      deps({
        shadeCalendarId: () => "wd",
        resolve: () => cal,
        timeline: () => fakeTimeline(20 / DAY),
        theme: () => ({ get: (token) => (token === "--sg-calendar-nonworking" ? "#123456" : "") }),
      }),
    );
    layer.draw(g, { scrollLeft: 0, scrollTop: 0, width: 2000, height: VIEWPORT_HEIGHT });
    expect(calls[0]?.fill).toBe("#123456");
  });
});
