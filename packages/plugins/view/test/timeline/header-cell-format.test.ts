/**
 * The header-cell template hook.
 *
 * `headerCellFormat` rewrites a
 * cell's label before measurement; a non-string result keeps the default label; a throw is
 * reported once via `core/pluginError` and latches the hook off for the instance's lifetime.
 */
import { afterEach, describe, expect, it } from "vitest";
import type { HeaderCell } from "../../src/internal/timeline/index";
import { boot } from "./_boot";
import type { Booted } from "./_boot";

let booted: Booted | null = null;

afterEach(() => {
  booted?.dom.restore();
  booted = null;
});

function paintedTexts(b: Booted): string[] {
  b.dom.flushFrames();
  return b.header.context.texts.map((t) => t.text);
}

describe("headerCellFormat", () => {
  it("replaces a cell's label with the returned string", () => {
    booted = boot([], {}, {
      origin: 0,
      headerCellFormat: (cell) => (cell.unit === "day" ? `D${cell.time / 86_400_000}` : undefined),
    });
    const texts = paintedTexts(booted);
    expect(texts).toContain("D0");
    expect(texts).toContain("D1");
    // The month row returned undefined, so its default label survives.
    expect(texts).toContain("January 1970");
  });

  it("hands the hook the cell's span, granularity, row index and default label", () => {
    const seen: HeaderCell[] = [];
    booted = boot([], {}, {
      origin: 0,
      headerCellFormat: (cell) => {
        seen.push(cell);
        return undefined;
      },
    });
    booted.dom.flushFrames();
    const day = seen.find((c) => c.unit === "day" && c.time === 0);
    expect(day).toBeDefined();
    expect(day?.endTime).toBe(86_400_000);
    expect(day?.step).toBe(1);
    expect(day?.rowIndex).toBe(1);
    expect(day?.locale).toBe("en");
    expect(day?.defaultLabel).toBe("1");
    const month = seen.find((c) => c.unit === "month");
    expect(month?.rowIndex).toBe(0);
    expect(month?.defaultLabel).toBe("January 1970");
  });

  it("keeps the default label for any non-string result", () => {
    booted = boot([], {}, {
      origin: 0,
      // Deliberately returns a number, which the option's type forbids but a JS caller can pass.
      headerCellFormat: (() => 42) as unknown as (cell: HeaderCell) => string,
    });
    const texts = paintedTexts(booted);
    expect(texts).toContain("January 1970");
    expect(texts).not.toContain("42");
  });

  it("reports a throw once, latches the hook off, and keeps the default labels", () => {
    let calls = 0;
    const faults: { pluginId: string }[] = [];
    booted = boot([], {}, {
      origin: 0,
      headerCellFormat: () => {
        calls++;
        throw new Error("boom");
      },
    });
    booted.gantt.on("core/pluginError", (e) => void faults.push(e));
    const texts = paintedTexts(booted);
    // The very first cell's throw latches the hook: one call, one report, default labels.
    expect(calls).toBe(1);
    expect(faults.length).toBe(1);
    expect(faults[0]?.pluginId).toBe("stargantt.view");
    expect(texts).toContain("January 1970");

    // A later repaint neither calls the hook nor reports again.
    const s = booted.gantt.service("stargantt.timeline");
    s.setZoomLevel("week");
    booted.dom.flushFrames();
    expect(calls).toBe(1);
    expect(faults.length).toBe(1);
  });

  it("ignores a non-function value silently", () => {
    booted = boot([], {}, {
      origin: 0,
      headerCellFormat: "nope" as unknown as (cell: HeaderCell) => string,
    });
    expect(paintedTexts(booted)).toContain("January 1970");
  });
});
