/**
 * The grid's CSS-token geometry, the shared vertical scroll viewport, the header/body horizontal
 * lockstep, the horizontal-overflow cue, and scrolling a focused row into view.
 */
import { afterEach, describe, expect, it } from "vitest";
import { boot, flatTasks, treeTasks } from "./_boot";
import type { Booted } from "./_boot";
import type { ColumnDef } from "../src/types";

let b: Booted | undefined;
afterEach(() => {
  b?.gantt.dispose();
  b?.dom.restore();
  b = undefined;
});

// The toggle gutter's base width and the cell padding come from CSS custom properties
// (`--sg-treegrid-toggle-width` / `--sg-treegrid-cell-padding`), with the built-in constants
// serving only as fallbacks. Every other test in this file declares no such token, so
// `getComputedStyle` reports "" for them and the fallback path (24 / 8) is what runs — which is
// why the defaults are unchanged.
//
// The token values go through the shared harness's token map: it owns `globalThis.getComputedStyle`
// and installs it at boot, so a stub wrapped around the boot would simply be overwritten.
describe("CSS-token geometry", () => {
  it("sizes the header gutter and the row toggle from `--sg-treegrid-toggle-width`", () => {
    b = boot([], { tokens: { "--sg-treegrid-toggle-width": "32px" } });
    b.data.load(treeTasks(1, 1));
    b.dom.flushFrames();
    expect(b.header.find("sg-grid-header-gutter")?.style["width"]).toBe("32px");
    const rows = b.visibleRows();
    expect(rows[0]?.find("sg-grid-toggle")?.style["width"]).toBe("32px");
    // Depth 1 still adds exactly one `indent` (16) on top of the token width.
    expect(rows[1]?.find("sg-grid-toggle")?.style["width"]).toBe("48px");
  });

  it("uses `--sg-treegrid-cell-padding` as the indent base of a width-less first column", () => {
    const wide: ColumnDef = {
      id: "name",
      header: "Name",
      render: (el, task) => void (el.textContent = task.name),
      getValue: (task) => task.name,
    };
    b = boot([], { tokens: { "--sg-treegrid-cell-padding": "12px" } }, { columns: [wide] });
    // The column declares no width, so the grid normally shrinks it by the indent using the
    // header cell's measured width. Zeroing that measurement (the fake DOM otherwise reports its
    // fixed rect for every element) forces the variant-A path, where the indent is added to the
    // cell padding — the token under test.
    const headerCell = b.header.findAll("sg-grid-cell sg-grid-header-cell")[0];
    if (headerCell !== undefined) headerCell.rect = { ...headerCell.rect, width: 0 };
    b.data.load(treeTasks(1, 1));
    b.dom.flushFrames();
    const rows = b.visibleRows();
    // Depth 0 gets the bare token; depth 1 adds one `indent` (16) on top of it.
    expect(rows[0]?.findAll("sg-grid-cell")[0]?.style["paddingLeft"]).toBe("12px");
    expect(rows[1]?.findAll("sg-grid-cell")[0]?.style["paddingLeft"]).toBe("28px");
  });

  it("falls back to the built-in 24 / 8 when the tokens are unreadable", () => {
    // No `getComputedStyle` at all — the composition without the bundled stylesheet.
    b = boot([], { noComputedStyle: true });
    b.data.load(treeTasks(1, 1));
    b.dom.flushFrames();
    expect(b.header.find("sg-grid-header-gutter")?.style["width"]).toBe("24px");
    expect(b.visibleRows()[1]?.find("sg-grid-toggle")?.style["width"]).toBe("40px");
  });

  it("re-reads the tokens on a theme change instead of caching them forever", () => {
    b = boot([], { tokens: { "--sg-treegrid-toggle-width": "24px" } });
    b.data.load(treeTasks(1, 1));
    b.dom.flushFrames();
    expect(b.header.find("sg-grid-header-gutter")?.style["width"]).toBe("24px");

    // `dom.tokens` is the live map `getComputedStyle` reads, so a restyle is a plain write; setting
    // the theme-token snapshot is what the grid's own cache invalidation is wired to.
    b.dom.tokens["--sg-treegrid-toggle-width"] = "36px";
    b.themeTokens.set({ ...b.themeTokens.get() });
    b.dom.flushFrames();
    expect(b.header.find("sg-grid-header-gutter")?.style["width"]).toBe("36px");
    expect(b.visibleRows()[0]?.find("sg-grid-toggle")?.style["width"]).toBe("36px");
  });
});

describe("shared vertical scroll viewport", () => {
  it("follows an incoming shared-viewport scroll", () => {
    b = boot();
    b.data.load(flatTasks(1000));
    b.dom.flushFrames();

    b.viewport.set({ ...b.viewport.get(), scrollTop: 100 });
    b.dom.flushFrames();
    expect(b.visibleRows()[0]?.getAttribute("data-row-index")).toBe("3");
    expect(b.visibleRows()[0]?.style["transform"]).toBe("translateY(-16px)");
  });

  it("requests a scrollTop through the view service on a wheel gesture", () => {
    b = boot();
    b.data.load(flatTasks(1000));
    b.dom.flushFrames();

    b.pane.fire("wheel", { deltaY: 100, preventDefault: () => {} });
    expect(b.scrollRequests()).toEqual([100]);
  });

  it("does not recurse when its own request round-trips back in", () => {
    b = boot();
    b.data.load(flatTasks(1000));
    b.dom.flushFrames();

    b.pane.fire("wheel", { deltaY: 56, preventDefault: () => {} });
    expect(b.scrollRequests().length).toBe(1);
    expect(b.dom.flushFrames()).toBe(1);
    expect(b.visibleRows()[0]?.getAttribute("data-row-index")).toBe("2");
  });
});

// The grid body is a native horizontal scroll container; the header follows in lockstep. The
// grid's horizontal offset is native to the body element and never travels through the shared
// vertical viewport.
describe("horizontal scroll", () => {
  it("mirrors the body's `scrollLeft` onto the header on a `scroll` event", () => {
    b = boot();
    b.data.load(flatTasks(2));
    b.dom.flushFrames();
    b.body.scrollLeft = 200;
    b.body.fire("scroll", {});
    expect(b.header.scrollLeft).toBe(200);
  });

  it("does not intercept a horizontal-dominant wheel gesture", () => {
    b = boot();
    b.data.load(flatTasks(50));
    let prevented = false;
    b.pane.fire("wheel", {
      deltaX: 50,
      deltaY: 5,
      preventDefault: () => {
        prevented = true;
      },
    });
    expect(prevented).toBe(false);
  });

  it("does not intercept a `Shift`+wheel gesture", () => {
    b = boot();
    b.data.load(flatTasks(50));
    let prevented = false;
    b.pane.fire("wheel", {
      deltaY: 50,
      shiftKey: true,
      preventDefault: () => {
        prevented = true;
      },
    });
    expect(prevented).toBe(false);
  });

  it("still intercepts a vertical-dominant wheel gesture", () => {
    b = boot();
    b.data.load(flatTasks(50));
    let prevented = false;
    b.pane.fire("wheel", {
      deltaX: 5,
      deltaY: 50,
      preventDefault: () => {
        prevented = true;
      },
    });
    expect(prevented).toBe(true);
  });
});

// The body is already a horizontal scroll container; this only marks whether (and which side)
// content is currently clipped, so a stylesheet can paint an edge cue. `overflow-cue.test.ts`
// covers the pure derivation; these test the wiring points that keep it live.
describe("horizontal-overflow cue", () => {
  /** The fake DOM has no layout engine, so `scrollWidth`/`clientWidth` are set directly. */
  function setBodyContentWidth(booted: Booted, scrollWidth: number, clientWidth: number): void {
    Object.assign(booted.body as unknown as { scrollWidth: number; clientWidth: number }, {
      scrollWidth,
      clientWidth,
    });
  }

  it("carries no `data-overflow` when the body's content fits", () => {
    b = boot();
    setBodyContentWidth(b, 400, 400);
    b.body.fire("scroll", {});
    expect(b.body.getAttribute("data-overflow")).toBeNull();
  });

  it("marks 'end' on a body scroll when overflowing content sits at the start", () => {
    b = boot();
    setBodyContentWidth(b, 800, 400);
    b.body.scrollLeft = 0;
    b.body.fire("scroll", {});
    expect(b.body.getAttribute("data-overflow")).toBe("end");
  });

  it("updates to 'start' as the body scrolls to the overflowing end", () => {
    b = boot();
    setBodyContentWidth(b, 800, 400);
    b.body.scrollLeft = 400;
    b.body.fire("scroll", {});
    expect(b.body.getAttribute("data-overflow")).toBe("start");
  });

  it("also re-derives from the header's own scroll (the reverse mirror)", () => {
    b = boot();
    setBodyContentWidth(b, 800, 400);
    // The header's own native scroll (e.g. a keyboard scroll-into-view of an off-pane header
    // cell) drives the body back via the reverse mirror; the cue must follow that write too.
    b.header.scrollLeft = 400;
    b.header.fire("scroll", {});
    expect(b.body.scrollLeft).toBe(400);
    expect(b.body.getAttribute("data-overflow")).toBe("start");
  });

  it("refreshes on a pane resize (`view/panes`' `onResize`)", () => {
    b = boot();
    setBodyContentWidth(b, 800, 400);
    b.body.scrollLeft = 0;
    expect(b.body.getAttribute("data-overflow")).toBeNull();
    b.paneResize(300);
    expect(b.body.getAttribute("data-overflow")).toBe("end");
  });

  it("refreshes on a column-resize drag", () => {
    b = boot();
    b.data.load(flatTasks(1));
    b.dom.flushFrames();
    setBodyContentWidth(b, 800, 400);
    expect(b.body.getAttribute("data-overflow")).toBeNull();
    const handle = b.header
      .findAll("sg-grid-cell sg-grid-header-cell")[0]
      ?.find("sg-grid-header-resize-handle");
    if (handle === undefined) throw new Error("resize handle not found");
    b.header.fire("pointerdown", { clientX: 100, target: handle });
    b.dom.document.fire("pointermove", { clientX: 150 });
    // The drag-step publication is frame-coalesced.
    b.dom.flushFrames();
    expect(b.body.getAttribute("data-overflow")).toBe("end");
  });

  // `render()` runs on every repaint (a plain vertical scroll, a data change, sorting,
  // expand/collapse), none of which can move the body's horizontal geometry, and the cue's read of
  // `scrollWidth`/`clientWidth` forces a synchronous relayout — a cost the per-frame repaint path
  // must not pay for nothing. A data change must NOT recompute the cue.
  it("does not recompute on an ordinary repaint (e.g. a data change)", () => {
    b = boot();
    b.dom.flushFrames();
    setBodyContentWidth(b, 800, 400);
    // Nothing has told the cue about this new geometry yet.
    expect(b.body.getAttribute("data-overflow")).toBeNull();
    b.data.load(flatTasks(1));
    b.dom.flushFrames();
    expect(b.body.getAttribute("data-overflow")).toBeNull();
  });

  // The toggle gutter's base width (`--sg-treegrid-toggle-width`) is part of the body's total
  // content width and is not itself depth-compensated, so a theme swap that changes it is a real
  // width-changing trigger, distinct from the ordinary-repaint case above.
  it("refreshes on a theme change (the gutter-width token)", () => {
    b = boot();
    b.dom.flushFrames();
    setBodyContentWidth(b, 800, 400);
    expect(b.body.getAttribute("data-overflow")).toBeNull();
    b.themeTokens.set({ ...b.themeTokens.get() });
    expect(b.body.getAttribute("data-overflow")).toBe("end");
  });

  it("clears the cue once a resize step removes the overflow", () => {
    b = boot();
    setBodyContentWidth(b, 800, 400);
    b.body.fire("scroll", {});
    expect(b.body.getAttribute("data-overflow")).toBe("end");

    setBodyContentWidth(b, 400, 400);
    b.paneResize(300);
    expect(b.body.getAttribute("data-overflow")).toBeNull();
  });
});

// Mirrors a roving-focus owner's placement onto `.sg-grid-row--focused` and scrolls that row into
// the pane's own viewport; the mark itself is covered in `pane.test.ts`.
describe("scrolling a focused row into view", () => {
  it("scrolls a focused row below the viewport into view", () => {
    b = boot();
    b.data.load(flatTasks(1000));
    b.dom.flushFrames();
    b.grid.setFocused("t50");
    b.dom.flushFrames();
    expect(b.visibleRows().some((r) => r.getAttribute("data-row-index") === "50")).toBe(true);
  });

  it("does not scroll when the focused row is already fully visible", () => {
    b = boot();
    b.data.load(flatTasks(1000));
    b.dom.flushFrames();
    b.grid.setFocused("t0");
    b.dom.flushFrames();
    expect(b.scrollRequests()).toHaveLength(0);
  });
});
