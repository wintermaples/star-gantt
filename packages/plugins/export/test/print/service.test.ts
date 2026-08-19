// @vitest-environment happy-dom
/** The print side of the `stargantt.export` facade through a real host: pagination, PDF, preview. */
import { afterEach, describe, expect, it } from "vitest";
import {
  DAY,
  boot,
  createdContexts,
  denyCanvasContext,
  denyPixelReadback,
  drawnTexts,
  previewBox,
} from "./_boot";
import type { Booted } from "./_boot";

/** The y of the chart region's clip rect — the last `rect` of a page composition. */
function chartTop(): number {
  const rects = createdContexts()[0]!.op("rect");
  return rects[rects.length - 1]!.args[1]!;
}

// Every test disposes its own host; this keeps one that threw first from leaking its DOM (and its
// preview stylesheets) into the next test's document-wide assertions.
afterEach(() => {
  document.body.innerHTML = "";
  document.head.innerHTML = "";
});

function tall(count: number): { id: string; name: string; start: number; end: number }[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `t${i}`,
    name: `Task ${i}`,
    start: 0,
    end: DAY,
  }));
}

describe("pageCount / pagination", () => {
  it("counts one page when the span fits", () => {
    const b = boot(); // 40 days at 1 px/day ≪ one chart region
    expect(b.service.pageCount()).toBe(1);
    b.dispose();
  });

  it("splits the time axis into several pages at higher resolution", () => {
    const b = boot({ pxPerMs: 100 / DAY }); // 4000 content px
    expect(b.service.pageCount()).toBeGreaterThan(1);
    b.dispose();
  });

  it("an explicit range narrows the exported span", () => {
    const b = boot({ pxPerMs: 100 / DAY });
    const all = b.service.pageCount();
    const some = b.service.pageCount({ range: { start: 0, end: 5 * DAY } });
    expect(some).toBe(1);
    expect(some).toBeLessThan(all);
    b.dispose();
  });

  it("degrades to a single viewport page when no bound resolves (§1.2)", () => {
    // Composing without the timeline-scale service is not possible (hard `view` dependency); what
    // remains is the live degradation: no dated task and no fully explicit range leaves the span
    // unresolved, so the export is the viewport's time window.
    const b = boot({ tasks: [], pxPerMs: 100 / DAY });
    expect(b.service.pageCount()).toBe(1);
    b.dispose();
  });

  it("a row range narrows the vertical span", () => {
    const b = boot({ tasks: tall(200) });
    const all = b.service.pageCount();
    const some = b.service.pageCount({ rows: { from: 0, to: 3 } });
    expect(all).toBeGreaterThan(1);
    expect(some).toBe(1);
    b.dispose();
  });

  it("takes the viewport's row band without the rows service", () => {
    const withRows = boot({ tasks: tall(200) });
    const banded = withRows.service.pageCount();
    withRows.dispose();
    const withoutRows = boot({ tasks: tall(200), rows: false });
    expect(withoutRows.service.pageCount()).toBe(1);
    expect(banded).toBeGreaterThan(1);
    withoutRows.dispose();
  });
});

describe("data snapshot per export", () => {
  it("queries the data store exactly once per export, not once per task/cell", () => {
    const b = boot({ tasks: tall(50) });
    b.queryCalls.count = 0;
    b.service.pageCount();
    // One `query()` call for the whole export, however many tasks/cells the layout visits.
    expect(b.queryCalls.count).toBe(1);
    b.dispose();
  });

  it("toPdf also queries the data store exactly once", async () => {
    const b = boot({
      tasks: tall(50),
      print: { columns: ["name", "start", "end", "progress"] },
    });
    b.queryCalls.count = 0;
    await b.service.toPdf();
    expect(b.queryCalls.count).toBe(1);
    b.dispose();
  });
});

describe("toPdf", () => {
  it("produces an application/pdf Blob with one virtual render per page and no scrolling", async () => {
    const b = boot({ pxPerMs: 100 / DAY });
    const pages = b.service.pageCount();
    const blob = await b.service.toPdf();
    expect(blob.type).toBe("application/pdf");
    expect(blob.size).toBeGreaterThan(100);
    expect(b.renders).toHaveLength(pages);
    // Contiguous virtual viewports from the range's left edge.
    expect(b.renders[0]!.scrollLeft).toBe(0);
    expect(b.renders[1]!.scrollLeft).toBeCloseTo(b.renders[0]!.width);
    b.dispose();
  });

  it("rasterizes at the resolved pixelRatio, clamped at 4", async () => {
    const b = boot({ print: { pixelRatio: 10_000 } });
    await b.service.toPdf();
    const canvas = createdContexts()[0]!.canvas;
    // A4 landscape is 1122.5 × 793.7 CSS px; the clamp caps the raster at 4× that.
    expect(canvas.width).toBe(Math.round(1122.5196850393702 * 4));
    b.dispose();
  });

  it("rejects when the canvas cannot produce a 2D context", async () => {
    const b = boot();
    denyCanvasContext();
    await expect(b.service.toPdf()).rejects.toThrow(/2D canvas context/);
    b.dispose();
  });

  it("rejects when the environment refuses pixel readback", async () => {
    const b = boot();
    denyPixelReadback();
    await expect(b.service.toPdf()).rejects.toThrow(/encoding failed/);
    b.dispose();
  });
});

// docs/specs/plugins/export.md §1.3 — the exported chart pass pins the light colour scheme so a
// dark-theme chart doesn't composite onto the page's white chrome/legend; the pin is restored
// afterward. `pageCount` renders nothing and pins nothing.
describe("light-scheme pin during export", () => {
  it("pins the theme to light for every render during toPdf and restores it after", async () => {
    const b = boot({ theme: "dark", pxPerMs: 100 / DAY });
    expect(b.themeSpy.current).toBe("dark");
    await b.service.toPdf();
    expect(b.themeSpy.schemeDuringRenders.length).toBeGreaterThan(0);
    expect(b.themeSpy.schemeDuringRenders.every((s) => s === "light")).toBe(true);
    expect(b.themeSpy.calls).toEqual(["light", "dark"]);
    expect(b.themeSpy.current).toBe("dark");
    b.dispose();
  });

  it("does nothing when the chart is already light", async () => {
    const b = boot({ theme: "light" });
    await b.service.toPdf();
    expect(b.themeSpy.calls).toEqual([]);
    expect(b.themeSpy.current).toBe("light");
    b.dispose();
  });

  it("pins/restores around printPreview as well", () => {
    const b = boot({ theme: "auto" });
    expect(b.service.printPreview()).toBe(true);
    expect(b.themeSpy.calls).toEqual(["light", "auto"]);
    expect(b.themeSpy.current).toBe("auto");
    b.service.printPreview(false);
    b.dispose();
  });

  it("restores the prior scheme when the render throws", () => {
    const b = boot({ theme: "dark", pxPerMs: 100 / DAY });
    expect(() => b.service.toPdf({ range: { start: 0, end: 100_000 * DAY } })).toThrow(/page count/i);
    expect(b.themeSpy.calls).toEqual(["light", "dark"]);
    expect(b.themeSpy.current).toBe("dark");
    b.dispose();
  });

  it("pageCount pins nothing and renders nothing", () => {
    const b = boot({ theme: "dark", pxPerMs: 100 / DAY });
    expect(b.service.pageCount()).toBeGreaterThan(1);
    expect(b.themeSpy.calls).toEqual([]);
    expect(b.themeSpy.current).toBe("dark");
    expect(b.renders).toHaveLength(0);
    expect(createdContexts()).toHaveLength(0);
    b.dispose();
  });
});

describe("the conditional date band (§1.2)", () => {
  const withBand = (top: number): boolean => Math.abs(top - (10 * (96 / 25.4) + 24)) < 0.01;
  const withoutBand = (top: number): boolean => Math.abs(top - 10 * (96 / 25.4)) < 0.01;

  it("is present when the exported span resolved both bounds, even with no table column", async () => {
    const b = boot({ print: { columns: [] } });
    await b.service.toPdf();
    expect(withBand(chartTop())).toBe(true);
    b.dispose();
  });

  it("is present when at least one table column is configured, even with an unresolved span", async () => {
    const b = boot({ tasks: [], print: { columns: ["name"] } });
    await b.service.toPdf();
    expect(withBand(chartTop())).toBe(true);
    b.dispose();
  });

  it("is absent when the span is unresolved and no column is configured", async () => {
    const b = boot({ tasks: [], print: { columns: [] } });
    await b.service.toPdf();
    expect(withoutBand(chartTop())).toBe(true);
    // No bounds resolved means no date labels either.
    expect(drawnTexts().some((t) => t.includes("Jan"))).toBe(false);
    b.dispose();
  });
});

describe("page content", () => {
  it("draws header/footer text with the default page number", async () => {
    const b = boot({ print: { header: { left: "ACME Corp" } } });
    await b.service.toPdf();
    const texts = drawnTexts();
    expect(texts).toContain("ACME Corp");
    expect(texts).toContain("Page 1 of 1");
    b.dispose();
  });

  it("per-page builders receive the page info, and footer '' suppresses the page number", async () => {
    const b = boot({
      print: {
        header: { right: (info) => `${info.page}/${info.pages}` },
        footer: { center: "" },
      },
    });
    await b.service.toPdf();
    const texts = drawnTexts();
    expect(texts).toContain("1/1");
    expect(texts.some((t) => t.startsWith("Page "))).toBe(false);
    b.dispose();
  });

  it("contains a throwing text builder: pluginError once, empty text, export still resolves", async () => {
    const b = boot({
      print: {
        header: {
          center: () => {
            throw new Error("boom");
          },
        },
      },
    });
    const blob = await b.service.toPdf();
    expect(blob.type).toBe("application/pdf");
    expect(b.errors.length).toBeGreaterThan(0);
    expect(b.errors[0]!.pluginId).toBe("stargantt.export");
    expect(drawnTexts()).toContain("Page 1 of 1");
    b.dispose();
  });

  it("prints the selected columns: headers and per-task cells", async () => {
    const b = boot({ print: { columns: ["name", "start", "progress"] } });
    await b.service.toPdf();
    const texts = drawnTexts();
    for (const expected of ["Name", "Start", "Progress", "Design", "Build", "Ship", "50%", "25%"]) {
      expect(texts).toContain(expected);
    }
    expect(texts).not.toContain("End");
    b.dispose();
  });

  it("localizes printed dates through the instance locale", async () => {
    const b = boot({ print: { columns: ["name", "start"] } });
    await b.service.toPdf();
    // Task "b" starts at epoch + 10 days = Jan 11, 1970 (UTC).
    expect(drawnTexts().some((t) => t.includes("Jan") && t.includes("11"))).toBe(true);
    b.dispose();
  });

  it("draws the auto legend, and none with legend: false", async () => {
    const on = boot();
    await on.service.toPdf();
    for (const label of ["Legend", "Task", "Summary", "Milestone"]) {
      expect(drawnTexts()).toContain(label);
    }
    on.dispose();

    const off = boot({ print: { legend: false } });
    await off.service.toPdf();
    expect(drawnTexts()).not.toContain("Legend");
    off.dispose();
  });

  it("replaces the legend entries with a supplied array", async () => {
    const b = boot({ print: { legend: [{ color: "#123456", label: "On track" }] } });
    await b.service.toPdf();
    const texts = drawnTexts();
    expect(texts).toContain("On track");
    expect(texts).not.toContain("Milestone");
    b.dispose();
  });

  it("message catalog overrides replace the printed strings per key", async () => {
    const b = boot({
      config: { messages: { legendTitle: "Key", pageNumber: (i) => `p.${i.page}` } },
    });
    await b.service.toPdf();
    const texts = drawnTexts();
    expect(texts).toContain("Key");
    expect(texts).toContain("p.1");
    expect(texts).not.toContain("Legend");
    b.dispose();
  });
});

describe("critical-path emphasis", () => {
  const VEIL = "rgba(255, 255, 255, 0.75)";

  it("veils non-critical rows and adds the critical legend entry", async () => {
    const b = boot({ critical: new Set(["b"]), print: { criticalPathOnly: true } });
    await b.service.toPdf();
    const g = createdContexts()[0]!;
    const veils = g.op("fillRect").filter((c) => c.fill === VEIL);
    expect(veils).toHaveLength(2); // rows a and c dimmed, b left at full contrast
    // Each veil covers the row's own band across the whole chart slice.
    expect(veils[0]!.args[1]).toBe(0);
    expect(veils[0]!.args[3]).toBe(24);
    expect(drawnTexts()).toContain("Critical path");
    b.dispose();
  });

  it("is silently ignored without the criticality query", async () => {
    const b = boot({ print: { criticalPathOnly: true } });
    await b.service.toPdf();
    const g = createdContexts()[0]!;
    expect(g.op("fillRect").filter((c) => c.fill === VEIL)).toHaveLength(0);
    expect(drawnTexts()).not.toContain("Critical path");
    expect(b.errors).toHaveLength(0);
    b.dispose();
  });
});

describe("printPreview", () => {
  function mounted(b: Booted): HTMLElement | undefined {
    return previewBox(b.chartPane);
  }

  it("mounts a labelled dialog with Print and Close buttons into the chart pane", () => {
    const b = boot();
    expect(b.service.printPreview()).toBe(true);
    const box = mounted(b)!;
    expect(box).toBeDefined();
    expect(box.getAttribute("role")).toBe("dialog");
    expect(box.getAttribute("aria-label")).toBe("Print preview");
    expect(Array.from(box.querySelectorAll("button")).map((x) => x.textContent)).toEqual([
      "Print",
      "Close",
    ]);
    // One preview sheet per page, each holding a canvas.
    expect(box.querySelectorAll(".sg-print-preview-page").length).toBeGreaterThan(0);
    b.dispose();
  });

  it("returns false and mounts nothing when pages cannot be rendered", () => {
    const b = boot();
    denyCanvasContext();
    expect(b.service.printPreview()).toBe(false);
    expect(mounted(b)).toBeUndefined();
    b.dispose();
  });

  it("printPreview(false) closes it, and answers whether one is open", () => {
    const b = boot();
    expect(b.service.printPreview()).toBe(true);
    expect(b.service.printPreview(false)).toBe(false);
    expect(mounted(b)).toBeUndefined();
    // Closing again is a no-op.
    expect(b.service.printPreview(false)).toBe(false);
    b.dispose();
  });

  it("Escape closes the overlay and removes its print stylesheet", () => {
    const b = boot();
    b.service.printPreview();
    expect(document.querySelectorAll("style").length).toBeGreaterThan(0);
    mounted(b)!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(mounted(b)).toBeUndefined();
    expect(document.querySelectorAll("style")).toHaveLength(0);
    b.dispose();
  });

  it("the Close button closes the overlay", () => {
    const b = boot();
    b.service.printPreview();
    Array.from(mounted(b)!.querySelectorAll("button")).at(-1)!.click();
    expect(mounted(b)).toBeUndefined();
    b.dispose();
  });

  it("opening while open replaces the previous preview", () => {
    const b = boot();
    b.service.printPreview();
    b.service.printPreview();
    expect(b.chartPane.querySelectorAll(".sg-print-preview")).toHaveLength(1);
    b.dispose();
  });

  it("disposing the gantt instance removes an open preview (ctx.own)", () => {
    const b = boot();
    b.service.printPreview();
    b.testHost.dispose();
    expect(mounted(b)).toBeUndefined();
    b.root.remove();
  });
});

describe("task extent with milestone-only data (§1.2)", () => {
  it("a partial explicit range still maps against a zero-width task extent", () => {
    // Every task is a milestone (start === end): the extent is valid but zero-width, and an
    // explicit range.start must pair with the extent's end instead of degrading to the viewport.
    const b = boot({
      tasks: [
        { id: "m1", name: "Gate", start: 30 * DAY, end: 30 * DAY },
        { id: "m2", name: "Launch", start: 30 * DAY, end: 30 * DAY },
      ],
      pxPerMs: 100 / DAY,
    });
    // [0, 30 days] at 100 px/day = 3000 content px: several pages. The degrade path (the viewport
    // window, 800 px) would produce exactly one.
    expect(b.service.pageCount({ range: { start: 0 } })).toBeGreaterThan(1);
    b.dispose();
  });
});
