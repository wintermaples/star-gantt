/**
 * Header row bands: how the total height is divided, and what a row the level does not supply does
 * to the rows below it.
 *
 * The two-row treatment every built-in level
 * uses is `headerRowRatio`'s business; any other row count divides the height evenly. A *sparse*
 * `scales` array — a hole rather than a row — is the edge this file pins: the hole takes no height,
 * so the rows below it move up, and only rows that exist are laid out at all.
 */
import { describe, expect, it } from "vitest";
import type { ScaleRow, ZoomLevel } from "../../src/internal/timeline/index";
import { computeHeaderRows } from "../../src/internal/timeline/header-layout";
import type { HeaderDrawOptions } from "../../src/internal/timeline/header-options";
import { MS_DAY } from "../../src/internal/timeline/scale";

const HEIGHT = 60;
const PX_PER_DAY = 40;

function dayRow(label: string): ScaleRow {
  return { unit: "day", format: () => label };
}

/** Draw options over a one-day-wide surface, with a fixed label width so nothing is thinned away. */
function options(scales: ScaleRow[], rowRatio = 0.5): HeaderDrawOptions {
  const level: ZoomLevel = { id: "test", pxPerDay: PX_PER_DAY, scales };
  const pxPerMs = PX_PER_DAY / MS_DAY;
  return {
    level,
    locale: "en",
    height: HEIGHT,
    fg: "",
    bg: "",
    border: "",
    font: "",
    fontMajor: "",
    borderMinor: "",
    firstDayOfWeek: 1,
    rowRatio,
    labelPadding: 4,
    sticky: false,
    scrollLeft: 0,
    width: PX_PER_DAY,
    tToX: (t) => t * pxPerMs,
    xToT: (x) => x / pxPerMs,
    measureText: () => 8,
    onFormatError: () => {
      throw new Error("no format should throw here");
    },
  };
}

/** `{ top, bottomY }` of every laid-out row, which is what a band boils down to on the surface. */
function bands(o: HeaderDrawOptions): { top: number; bottomY: number }[] {
  return computeHeaderRows(o).map((row) => ({ top: row.top, bottomY: row.bottomY }));
}

describe("header row bands", () => {
  it("splits a two-row header by `rowRatio`", () => {
    expect(bands(options([dayRow("top"), dayRow("bottom")], 0.25))).toEqual([
      { top: 0, bottomY: 15 },
      { top: 15, bottomY: 60 },
    ]);
  });

  it("divides any other row count evenly, `rowRatio` notwithstanding", () => {
    expect(bands(options([dayRow("a"), dayRow("b"), dayRow("c")], 0.25))).toEqual([
      { top: 0, bottomY: 20 },
      { top: 20, bottomY: 40 },
      { top: 40, bottomY: 60 },
    ]);
    expect(bands(options([dayRow("only")], 0.25))).toEqual([{ top: 0, bottomY: 60 }]);
  });

  it("gives a hole in a sparse `scales` array no height, so the rows below it move up", () => {
    // A literal hole — `scales[1]` is absent, not undefined-valued — is what a contributed level
    // built with `delete` or a sparse literal produces. It draws nothing and, since the even split
    // is derived from the array itself, it also takes none of the height: the third row rises into
    // its place instead of leaving a gap.
    const scales: ScaleRow[] = [dayRow("a"), dayRow("b"), dayRow("c")];
    delete scales[1];
    expect(1 in scales).toBe(false);
    expect(scales.length).toBe(3);

    expect(bands(options(scales))).toEqual([
      { top: 0, bottomY: 20 },
      // The surviving third row sits directly below the first, at one third of the height — not at
      // two thirds, which is where it would land if the hole had claimed a band of its own.
      { top: 20, bottomY: 40 },
    ]);
  });

  it("still gives a hole its share in the two-row treatment, whose heights are a pair", () => {
    // The two-row split is `[ratio, 1 - ratio]` rather than a per-entry map, so a hole there does
    // occupy its share and the surviving row keeps its own band.
    const scales: ScaleRow[] = [dayRow("top"), dayRow("bottom")];
    delete scales[0];
    expect(bands(options(scales, 0.25))).toEqual([{ top: 15, bottomY: 60 }]);
  });

  it("lays out nothing when the level has no rows", () => {
    expect(bands(options([]))).toEqual([]);
  });
});
