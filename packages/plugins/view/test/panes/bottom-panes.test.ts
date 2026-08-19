/**
 * The bottom region (docs/specs/plugins/view.md): the `.sg-pane-row` wrapper and its dispose-time
 * restoration, the `view/bottomPanes` collection, ordering, duplicate and fault
 * semantics, the gutter/body/trailing column widths, the horizontal divider's
 * pointer and keyboard resize with the interactive floor, height ownership
 * through `view/setBottomPaneHeight` / `view/bottomPaneResized`, the
 * zero-height pane, the view-mode coupling and focus guard, and the
 * side-pane notification after a height change.
 */
import { definePlugin } from "@stargantt/core";
import type { AnyPlugin } from "@stargantt/core";
import { asElement, keyEvent } from "../_utils/index";
import type { DomHarness, DomOptions, FakeElement } from "../_utils/index";
import { afterEach, describe, expect, it } from "vitest";
import type {
  BottomPaneContribution,
  BottomPaneElements,
  PaneContribution,
} from "../../src/internal/panes/index";
import { bottomResizeBounds, normalizeBottomContributions } from "../../src/internal/panes/bottom-panes";
import { createDragOwner } from "../../src/internal/panes/drag-owner";
import { boot } from "./_boot";
import type { Booted, ViewPluginOptions } from "./_boot";

let booted: Booted[] = [];

afterEach(() => {
  for (const b of booted) {
    b.gantt.dispose();
    b.dom.restore();
  }
  booted = [];
});

function sideContributor(id: string, contributions: PaneContribution[]): AnyPlugin {
  return definePlugin({
    meta: { id, dependsOn: ["stargantt.view"] },
    setup(ctx) {
      for (const c of contributions) ctx.contribute("view/panes", c);
    },
  });
}

function bottomContributor(id: string, contributions: BottomPaneContribution[]): AnyPlugin {
  return definePlugin({
    meta: { id, dependsOn: ["stargantt.view"] },
    setup(ctx) {
      for (const c of contributions) ctx.contribute("view/bottomPanes", c);
    },
  });
}

function side(id: string, over: Partial<PaneContribution> = {}): PaneContribution {
  return { id, side: "left", order: 0, initialWidth: 100, mount: () => {}, ...over };
}

function bottom(id: string, over: Partial<BottomPaneContribution> = {}): BottomPaneContribution {
  return { id, height: 40, mount: () => {}, ...over };
}

function errorsProbe(sink: unknown[]): AnyPlugin {
  return definePlugin({
    meta: { id: "test.errors" },
    setup(ctx) {
      ctx.on("core/pluginError", (e) => sink.push(e));
    },
  });
}

function resizedProbe(sink: unknown[]): AnyPlugin {
  return definePlugin({
    meta: { id: "test.resized" },
    setup(ctx) {
      ctx.on("view/bottomPaneResized", (e) => sink.push(e));
    },
  });
}

/** Boots and tracks the harness for cleanup, returning the `{ dom, g }` pair the tests use. */
function start(
  extra: AnyPlugin[] = [],
  domOptions: DomOptions = {},
  viewOpts: ViewPluginOptions = {},
): { dom: DomHarness; g: Booted["gantt"] } {
  const b = boot(extra, viewOpts, domOptions);
  booted.push(b);
  return { dom: b.dom, g: b.gantt };
}

function paneRow(dom: DomHarness): FakeElement {
  const row = dom.root.find("sg-pane-row");
  expect(row).toBeDefined();
  return row!;
}

function region(dom: DomHarness): FakeElement | undefined {
  return dom.root.find("sg-bottom-region");
}

function bottomPanes(dom: DomHarness): FakeElement[] {
  return dom.root.findAll("sg-bottom-pane");
}

function hDividers(dom: DomHarness): FakeElement[] {
  return dom.root.findAll("sg-pane-divider--horizontal");
}

function chartEl(dom: DomHarness): FakeElement | undefined {
  return dom.root.find("sg-pane--chart");
}

/** The token map that makes the `room` clamp determinable. */
function rowFloor(px: number): DomOptions {
  return { tokens: { "--sg-pane-row-min-height": `${px}px` } };
}

describe("bottom-region planning (hostless)", () => {
  it("keeps the first of duplicate ids and reports the later ones", () => {
    const { panes: out, duplicateIds } = normalizeBottomContributions([
      bottom("a", { height: 10 }),
      bottom("a", { height: 20 }),
      bottom("b"),
      bottom("a", { height: 30 }),
    ]);
    expect(out.map((p) => p.id)).toEqual(["a", "b"]);
    expect(out[0]?.height).toBe(10);
    expect(duplicateIds).toEqual(["a", "a"]);
  });

  it("sorts by order ascending with ties by registration order, defaulting order to 0", () => {
    const { panes: out } = normalizeBottomContributions([
      bottom("later", { order: 1 }),
      bottom("first", { order: -1 }),
      bottom("tieA"),
      bottom("tieB", { order: 0 }),
    ]);
    expect(out.map((p) => p.id)).toEqual(["first", "tieA", "tieB", "later"]);
  });

  it("sanitizes unusable heights and clamps to the defaults", () => {
    const { panes: out } = normalizeBottomContributions([
      bottom("nan", { height: Number.NaN }),
      bottom("neg", { height: -5 }),
      bottom("inf", { height: Infinity }),
      bottom("odd", { height: 40, minHeight: -3, maxHeight: Number.NaN }),
    ]);
    expect(out.map((p) => p.height)).toEqual([0, 0, 0, 40]);
    expect(out[3]?.minHeight).toBe(0);
    expect(out[3]?.maxHeight).toBe(Infinity);
  });

  it("falls back to the default divider name for an omitted, empty or blank label", () => {
    const { panes: out } = normalizeBottomContributions([
      bottom("a"),
      bottom("b", { label: "" }),
      bottom("c", { label: "   " }),
      bottom("d", { label: "Resize the load band" }),
      // A padded label is used trimmed: the accessible name must not carry the whitespace that
      // blankness was already decided without.
      bottom("e", { label: "  Resize band  " }),
    ]);
    expect(out.map((p) => p.label)).toEqual([
      "Resize panel",
      "Resize panel",
      "Resize panel",
      "Resize the load band",
      "Resize band",
    ]);
  });

  it("floors a resizable pane at max(minHeight, 24) and a non-resizable one at minHeight", () => {
    const base = { maxHeight: Infinity, currentHeight: 40, rowHeight: null, rowMinHeight: null };
    expect(bottomResizeBounds({ ...base, resizable: true, minHeight: 0 }).min).toBe(24);
    expect(bottomResizeBounds({ ...base, resizable: true, minHeight: 60 }).min).toBe(60);
    expect(bottomResizeBounds({ ...base, resizable: false, minHeight: 0 }).min).toBe(0);
  });

  it("caps the maximum at min(maxHeight, room) and never inverts the clamp", () => {
    const base = { resizable: true, minHeight: 0, currentHeight: 40 };
    // room = 40 + 300 - 120 = 220 binds below an unbounded maxHeight.
    expect(
      bottomResizeBounds({ ...base, maxHeight: Infinity, rowHeight: 300, rowMinHeight: 120 }).max,
    ).toBe(220);
    // maxHeight binds below room.
    expect(
      bottomResizeBounds({ ...base, maxHeight: 100, rowHeight: 300, rowMinHeight: 120 }).max,
    ).toBe(100);
    // A root shorter than the row floor makes room negative; the floor wins, no inversion.
    const short = bottomResizeBounds({
      ...base,
      maxHeight: Infinity,
      rowHeight: 60,
      rowMinHeight: 120,
    });
    expect(short.max).toBe(short.min);
    // No readable row floor: degrade to maxHeight alone.
    expect(
      bottomResizeBounds({ ...base, maxHeight: 90, rowHeight: null, rowMinHeight: null }).max,
    ).toBe(90);
  });

  it("drag owner refuses a second claim and filters foreign pointers", () => {
    const owner = createDragOwner();
    const moved: string[] = [];
    const first = {
      pointerId: 1,
      move: () => moved.push("first"),
      up: () => moved.push("first-up"),
    };
    expect(owner.claim(first)).toBe(true);
    expect(owner.claim({ pointerId: 2, move: () => moved.push("second"), up: () => {} })).toBe(
      false,
    );
    owner.move({ pointerId: 2 } as PointerEvent);
    owner.move({ pointerId: 1 } as PointerEvent);
    owner.up({ pointerId: 2 } as PointerEvent);
    owner.up({ pointerId: 1 } as PointerEvent);
    // The foreign pointer neither moved nor ended the claim; a new claim is possible after up.
    expect(moved).toEqual(["first", "first-up"]);
    expect(owner.claim(first)).toBe(true);
  });
});

describe("the pane row", () => {
  it("wraps the chart pane in .sg-pane-row and creates no region without contributions", () => {
    const { dom } = start([sideContributor("test.c", [side("l")])]);
    expect(dom.root.children.map((c) => c.className)).toEqual(["sg-pane-row"]);
    expect(paneRow(dom).children.map((c) => c.className)).toEqual([
      "sg-pane",
      "sg-pane-divider",
      "sg-pane sg-pane--chart",
    ]);
    expect(region(dom)).toBeUndefined();
  });

  it("returns the chart pane to the root and removes the row and region on dispose", () => {
    const { dom, g } = start(
      [sideContributor("test.c", [side("l")]), bottomContributor("test.b", [bottom("p")])],
      {},
      // The "renderer" leaves its pane alone on dispose, so the test can observe exactly what the
      // panes module put back (the "returned exactly as found" guarantee).
      { removeChartOnDispose: false },
    );
    const chart = chartEl(dom)!;
    expect(chart.parentNode).toBe(paneRow(dom));
    expect(region(dom)).toBeDefined();

    g.dispose();
    // The renderer stub left its pane alone, so what remains is exactly what the panes plugin
    // put back: the chart pane, a direct child of the root again — no row, no region, no panes.
    expect(dom.root.children.map((c) => c.className)).toEqual(["sg-pane sg-pane--chart"]);
    expect(chart.parentNode).toBe(dom.root);
  });
});

describe("contribution collection and mounting", () => {
  it("creates the region after the row and mounts each strip with its three columns", () => {
    const seen: BottomPaneElements[] = [];
    const { dom } = start([
      bottomContributor("test.b", [bottom("p", { mount: (els) => seen.push(els) })]),
    ]);
    expect(dom.root.children.map((c) => c.className)).toEqual(["sg-pane-row", "sg-bottom-region"]);
    expect(seen.length).toBe(1);
    const els = seen[0]!;
    const pane = bottomPanes(dom)[0]!;
    expect(els.pane).toBe(asElement(pane));
    expect(pane.children.map((c) => c.className)).toEqual([
      "sg-bottom-pane__gutter",
      "sg-bottom-pane__body",
      "sg-bottom-pane__trailing",
    ]);
    expect(els.gutter).toBe(asElement(pane.children[0]!));
    expect(els.body).toBe(asElement(pane.children[1]!));
    expect(els.trailing).toBe(asElement(pane.children[2]!));
    expect(pane.style["height"]).toBe("40px");
  });

  it("stacks strips downward by ascending order, ties by registration, after the side panes", () => {
    const mounted: string[] = [];
    const tag = (id: string, over: Partial<BottomPaneContribution>): BottomPaneContribution =>
      bottom(id, { ...over, mount: () => mounted.push(id) });
    const { dom } = start([
      sideContributor("test.s", [side("l", { mount: () => mounted.push("side") })]),
      bottomContributor("test.a", [tag("second", { order: 1 }), tag("tieA", { order: 0 })]),
      bottomContributor("test.b", [tag("tieB", { order: 0 })]),
    ]);
    // Side panes mount first (bottom mounts happen after them), then the strips top-down.
    expect(mounted).toEqual(["side", "tieA", "tieB", "second"]);
    // Each strip's divider precedes it in the region, as its top edge.
    expect(region(dom)?.children.map((c) => c.className)).toEqual([
      "sg-pane-divider sg-pane-divider--horizontal",
      "sg-bottom-pane",
      "sg-pane-divider sg-pane-divider--horizontal",
      "sg-bottom-pane",
      "sg-pane-divider sg-pane-divider--horizontal",
      "sg-bottom-pane",
    ]);
  });

  it("keeps the first of two same-id contributions and reports the duplicate on its own point", () => {
    const errors: unknown[] = [];
    const mounted: string[] = [];
    const { dom } = start([
      errorsProbe(errors),
      bottomContributor("test.a", [bottom("dup", { mount: () => mounted.push("first") })]),
      bottomContributor("test.b", [bottom("dup", { mount: () => mounted.push("second") })]),
    ]);
    expect(mounted).toEqual(["first"]);
    expect(bottomPanes(dom).length).toBe(1);
    expect(errors.length).toBe(1);
    expect(errors[0]).toMatchObject({
      pluginId: "stargantt.view",
      error: { point: "view/bottomPanes" },
    });
  });

  it("guards a throwing mount and still mounts the other strips", () => {
    const errors: unknown[] = [];
    const mounted: string[] = [];
    start([
      errorsProbe(errors),
      bottomContributor("test.b", [
        bottom("bad", {
          order: 0,
          mount: () => {
            throw new Error("boom");
          },
        }),
        bottom("good", { order: 1, mount: () => mounted.push("good") }),
      ]),
    ]);
    expect(mounted).toEqual(["good"]);
    expect(errors.length).toBe(1);
    expect(errors[0]).toMatchObject({ error: { point: "view/bottomPanes" } });
  });

  it("mounts exactly once across view-mode switches", () => {
    let mounts = 0;
    const { g } = start([
      sideContributor("test.s", [side("l")]),
      bottomContributor("test.b", [bottom("p", { mount: () => (mounts += 1) })]),
    ]);
    g.dispatch("view/setViewMode", { mode: "grid" });
    g.dispatch("view/setViewMode", { mode: "gantt" });
    g.dispatch("view/setViewMode", { mode: "split" });
    expect(mounts).toBe(1);
  });
});

describe("column widths", () => {
  /** Places the side pane, its divider and the chart pane at known widths. */
  function layOut(dom: DomHarness, widths: { pane?: number; divider?: number; chart?: number }): void {
    const p = dom.root.findAll("sg-pane").find((el) => !el.classList.contains("sg-pane--chart"));
    const d = paneRow(dom).children.find((c) => c.classList.contains("sg-pane-divider"));
    const c = chartEl(dom);
    if (p !== undefined && widths.pane !== undefined) p.rect = { ...p.rect, width: widths.pane };
    if (d !== undefined && widths.divider !== undefined) d.rect = { ...d.rect, width: widths.divider };
    if (c !== undefined && widths.chart !== undefined) c.rect = { ...c.rect, width: widths.chart };
  }

  function columns(dom: DomHarness): {
    gutter: string | undefined;
    body: string | undefined;
    trailing: string | undefined;
  } {
    const pane = bottomPanes(dom)[0]!;
    return {
      gutter: pane.children[0]?.style["width"],
      body: pane.children[1]?.style["width"],
      trailing: pane.children[2]?.style["width"],
    };
  }

  it("rewrites the columns from the live layout on a divider keyboard step", () => {
    const { dom } = start([
      sideContributor("test.s", [side("l")]),
      bottomContributor("test.b", [bottom("p")]),
    ]);
    layOut(dom, { pane: 150, divider: 6, chart: 244 });
    const divider = paneRow(dom).children.find((c) => c.classList.contains("sg-pane-divider"));
    divider?.fire("keydown", keyEvent("ArrowRight"));
    expect(columns(dom)).toEqual({ gutter: "156px", body: "244px", trailing: "0px" });
  });

  it("counts a collapsed pane as zero and rewrites on view/paneToggle", () => {
    const { dom, g } = start([
      sideContributor("test.s", [side("l", { collapsible: true })]),
      bottomContributor("test.b", [bottom("p")]),
    ]);
    layOut(dom, { pane: 150, divider: 6, chart: 244 });
    g.dispatch("view/paneToggle", { id: "l", collapsed: true });
    expect(columns(dom).gutter).toBe("6px");
    g.dispatch("view/paneToggle", { id: "l", collapsed: false });
    expect(columns(dom).gutter).toBe("156px");
  });

  it("rewrites when the row resizes, through a ResizeObserver on the row", () => {
    const { dom } = start([
      sideContributor("test.s", [side("l")]),
      bottomContributor("test.b", [bottom("p")]),
    ]);
    expect(dom.resizeObserverTargets()).toContain(paneRow(dom));
    layOut(dom, { pane: 120, divider: 4, chart: 200 });
    dom.triggerResizeObservers();
    expect(columns(dom)).toEqual({ gutter: "124px", body: "200px", trailing: "0px" });
  });

  it("registers no ResizeObserver without bottom panes and tolerates a missing one", () => {
    const { dom } = start([sideContributor("test.s", [side("l")])]);
    expect(dom.resizeObserverTargets()).toEqual([]);
    // A headless environment without ResizeObserver still boots with bottom panes composed.
    const { dom: bare } = start(
      [bottomContributor("test.b", [bottom("p")])],
      { noResizeObserver: true },
    );
    expect(bottomPanes(bare).length).toBe(1);
  });

  it("zeroes the gutter in gantt view and settles the widths before the viewMode store notifies", () => {
    const seen: { gutter: string | undefined }[] = [];
    let capture: (() => void) | null = null;
    // `view/modeChanged` is abolished (docs/specs/plugins/view.md): the `viewMode` store is the
    // sole notice of a mode change now, and `applyMode` rewrites the bottom columns before it
    // calls `viewModeStore.set()` — so a subscriber still reads settled geometry.
    const probe = definePlugin({
      meta: { id: "test.modes", dependsOn: ["stargantt.view"] },
      setup(ctx) {
        const service = ctx.use("stargantt.view");
        ctx.own(service.viewMode.subscribe(() => capture?.()));
      },
    });
    const { dom, g } = start([
      probe,
      sideContributor("test.s", [side("l")]),
      bottomContributor("test.b", [bottom("p")]),
    ]);
    layOut(dom, { pane: 150, divider: 6, chart: 244 });
    capture = () => seen.push({ gutter: columns(dom).gutter });
    g.dispatch("view/setViewMode", { mode: "gantt" });
    // A subscriber reads settled geometry: the hidden left pane counts as 0.
    expect(seen).toEqual([{ gutter: "0px" }]);
  });
});

describe("the horizontal divider", () => {
  it("is a tabbable horizontal separator on the strip's top edge, without data-side", () => {
    const { dom } = start([bottomContributor("test.b", [bottom("p")])]);
    const divider = hDividers(dom)[0]!;
    expect(divider.className).toBe("sg-pane-divider sg-pane-divider--horizontal");
    expect(divider.getAttribute("role")).toBe("separator");
    expect(divider.getAttribute("aria-orientation")).toBe("horizontal");
    expect(divider.getAttribute("aria-label")).toBe("Resize panel");
    expect(divider.tabIndex).toBe(0);
    expect(divider.hasAttribute("data-side")).toBe(false);
    expect(divider.nextSibling).toBe(bottomPanes(dom)[0]);
  });

  it("names the divider from label, falling back to the default for a blank one", () => {
    const { dom } = start([
      bottomContributor("test.b", [
        bottom("named", { order: 0, label: "Resize the load band" }),
        bottom("blank", { order: 1, label: "   " }),
        bottom("padded", { order: 2, label: "  Resize band  " }),
      ]),
    ]);
    expect(hDividers(dom).map((d) => d.getAttribute("aria-label"))).toEqual([
      "Resize the load band",
      "Resize panel",
      "Resize band",
    ]);
  });

  it("renders no divider for resizable: false, and only for that pane", () => {
    const { dom } = start([
      bottomContributor("test.b", [
        bottom("frozen", { order: 0, resizable: false }),
        bottom("live", { order: 1 }),
      ]),
    ]);
    expect(hDividers(dom).length).toBe(1);
    expect(region(dom)?.children.map((c) => c.className)).toEqual([
      "sg-bottom-pane",
      "sg-pane-divider sg-pane-divider--horizontal",
      "sg-bottom-pane",
    ]);
  });

  it("keeps the aria-value triad in sync with the clamp and the height", () => {
    const { dom, g } = start([
      bottomContributor("test.b", [bottom("p", { minHeight: 30, maxHeight: 100 })]),
    ]);
    const divider = hDividers(dom)[0]!;
    expect(divider.getAttribute("aria-valuemin")).toBe("30");
    expect(divider.getAttribute("aria-valuemax")).toBe("100");
    expect(divider.getAttribute("aria-valuenow")).toBe("40");
    g.dispatch("view/setBottomPaneHeight", { id: "p", height: 70 });
    expect(divider.getAttribute("aria-valuenow")).toBe("70");
  });

  it("omits aria-valuemax while the upper end is unbounded", () => {
    const { dom } = start([bottomContributor("test.b", [bottom("p")])]);
    expect(hDividers(dom)[0]?.getAttribute("aria-valuemax")).toBeNull();
  });

  it("bounds aria-valuemax by the row's room when the token is readable", () => {
    // room = 40 (pane) + 300 (row rect) - 120 (token) = 220.
    const { dom } = start([bottomContributor("test.b", [bottom("p")])], rowFloor(120));
    expect(hDividers(dom)[0]?.getAttribute("aria-valuemax")).toBe("220");
  });

  it("grows the pane when its divider is dragged up, and shrinks it dragged down", () => {
    const onResize: number[] = [];
    const { dom } = start([
      bottomContributor("test.b", [bottom("p", { onResize: (h) => onResize.push(h) })]),
    ]);
    const pane = bottomPanes(dom)[0];
    const divider = hDividers(dom)[0];
    divider?.fire("pointerdown", { clientY: 100 });
    dom.document.fire("pointermove", { clientY: 60 });
    // delta = −dy: 40 px up grows 40 → 80.
    expect(pane?.style["height"]).toBe("80px");
    dom.document.fire("pointermove", { clientY: 110 });
    expect(pane?.style["height"]).toBe("30px");
    dom.document.fire("pointerup", {});
    dom.document.fire("pointermove", { clientY: 0 });
    expect(pane?.style["height"]).toBe("30px");
    expect(onResize).toEqual([80, 30]);
  });

  it("clamps a drag to the interactive floor and to maxHeight", () => {
    const { dom } = start([bottomContributor("test.b", [bottom("p", { maxHeight: 100 })])]);
    const pane = bottomPanes(dom)[0];
    const divider = hDividers(dom)[0];
    divider?.fire("pointerdown", { clientY: 100 });
    dom.document.fire("pointermove", { clientY: 10_000 });
    // minHeight defaults to 0, but the interactive floor keeps a resizable pane at 24.
    expect(pane?.style["height"]).toBe("24px");
    dom.document.fire("pointermove", { clientY: -10_000 });
    expect(pane?.style["height"]).toBe("100px");
  });

  it("clamps a drag to the row's room read from --sg-pane-row-min-height", () => {
    const { dom } = start([bottomContributor("test.b", [bottom("p")])], rowFloor(120));
    const pane = bottomPanes(dom)[0];
    const divider = hDividers(dom)[0];
    divider?.fire("pointerdown", { clientY: 100 });
    dom.document.fire("pointermove", { clientY: -10_000 });
    // room = 40 + 300 - 120 = 220 (captured at pointerdown).
    expect(pane?.style["height"]).toBe("220px");
  });

  it("treats a sub-threshold press as a no-op — bottom panes have no collapse", () => {
    const events: unknown[] = [];
    const { dom } = start([resizedProbe(events), bottomContributor("test.b", [bottom("p")])]);
    const pane = bottomPanes(dom)[0];
    const divider = hDividers(dom)[0];
    divider?.fire("pointerdown", { clientY: 100 });
    dom.document.fire("pointermove", { clientY: 101 });
    dom.document.fire("pointerup", {});
    expect(pane?.style["height"]).toBe("40px");
    expect(events).toEqual([]);
  });

  it("refuses to start while a side divider drag is in progress (single drag owner)", () => {
    const { dom } = start([
      sideContributor("test.s", [side("l")]),
      bottomContributor("test.b", [bottom("p")]),
    ]);
    const sidePane = dom.root
      .findAll("sg-pane")
      .find((el) => !el.classList.contains("sg-pane--chart"));
    const vertical = paneRow(dom).children.find((c) => c.classList.contains("sg-pane-divider"));
    const horizontal = hDividers(dom)[0];
    const strip = bottomPanes(dom)[0];

    vertical?.fire("pointerdown", { clientX: 100, clientY: 100 });
    horizontal?.fire("pointerdown", { clientX: 100, clientY: 100 });
    dom.document.fire("pointermove", { clientX: 150, clientY: 60 });
    // The vertical drag (claimed first) tracks; the refused horizontal one does not.
    expect(sidePane?.style["width"]).toBe("150px");
    expect(strip?.style["height"]).toBe("40px");
    dom.document.fire("pointerup", {});
  });

  it("resizes by 16 px per arrow press and 64 with Shift, ArrowUp growing", () => {
    const { dom } = start([bottomContributor("test.b", [bottom("p")])]);
    const pane = bottomPanes(dom)[0];
    const divider = hDividers(dom)[0];
    divider?.fire("keydown", keyEvent("ArrowUp"));
    expect(pane?.style["height"]).toBe("56px");
    divider?.fire("keydown", keyEvent("ArrowDown"));
    divider?.fire("keydown", keyEvent("ArrowDown"));
    expect(pane?.style["height"]).toBe("24px");
    divider?.fire("keydown", keyEvent("ArrowUp", { shiftKey: true }));
    expect(pane?.style["height"]).toBe("88px");
  });

  it("keyboard steps stop at the interactive floor, and Home jumps to it", () => {
    const { dom } = start([bottomContributor("test.b", [bottom("p", { height: 30 })])]);
    const pane = bottomPanes(dom)[0];
    const divider = hDividers(dom)[0];
    divider?.fire("keydown", keyEvent("ArrowDown"));
    // 30 − 16 would land at 14; the floor is max(minHeight 0, 24).
    expect(pane?.style["height"]).toBe("24px");
    divider?.fire("keydown", keyEvent("ArrowUp"));
    divider?.fire("keydown", keyEvent("Home"));
    // Never 0: the divider cannot resize itself away, and the pane stays visible.
    expect(pane?.style["height"]).toBe("24px");
    expect(pane?.style["display"] ?? "").toBe("");
  });

  it("End jumps to the effective maximum and is a no-op while unbounded", () => {
    const { dom } = start([
      bottomContributor("test.b", [
        bottom("capped", { order: 0, maxHeight: 96 }),
        bottom("open", { order: 1 }),
      ]),
    ]);
    const [capped, open] = bottomPanes(dom);
    const [cappedDivider, openDivider] = hDividers(dom);
    cappedDivider?.fire("keydown", keyEvent("End"));
    expect(capped?.style["height"]).toBe("96px");
    openDivider?.fire("keydown", keyEvent("End"));
    // No readable row floor and no maxHeight: the upper end is unbounded, End does nothing.
    expect(open?.style["height"]).toBe("40px");
  });

  it("consumes every key it handles and leaves the others alone", () => {
    const { dom } = start([bottomContributor("test.b", [bottom("p")])]);
    const divider = hDividers(dom)[0];
    for (const k of ["ArrowUp", "ArrowDown", "Home", "End"]) {
      const e = keyEvent(k);
      divider?.fire("keydown", e);
      expect(e.defaultPrevented).toBe(true);
      expect(e.propagationStopped).toBe(true);
    }
    for (const k of ["ArrowLeft", "ArrowRight", "Enter", " ", "Tab"]) {
      const e = keyEvent(k);
      divider?.fire("keydown", e);
      expect(e.defaultPrevented).toBe(false);
      expect(e.propagationStopped).toBe(false);
    }
  });
});

describe("height ownership", () => {
  it("applies a clamped command height and publishes event and callback once", () => {
    const events: unknown[] = [];
    const onResize: number[] = [];
    const { dom, g } = start([
      resizedProbe(events),
      bottomContributor("test.b", [
        bottom("p", { maxHeight: 100, onResize: (h) => onResize.push(h) }),
      ]),
    ]);
    g.dispatch("view/setBottomPaneHeight", { id: "p", height: 500 });
    expect(bottomPanes(dom)[0]?.style["height"]).toBe("100px");
    expect(events).toEqual([{ id: "p", height: 100 }]);
    expect(onResize).toEqual([100]);
  });

  it("clamps a below-floor command up to the interactive floor on a resizable pane", () => {
    const { dom, g } = start([bottomContributor("test.b", [bottom("p")])]);
    g.dispatch("view/setBottomPaneHeight", { id: "p", height: 10 });
    expect(bottomPanes(dom)[0]?.style["height"]).toBe("24px");
    expect(bottomPanes(dom)[0]?.style["display"] ?? "").toBe("");
  });

  it("releases the strip entirely at exactly 0, floor and divider included", () => {
    // The floor stops a *gesture* from destroying the affordance that performed it. A programmatic
    // 0 is the opposite case: a contributor saying its strip is not showing, reversibly, and the
    // only way an opt-in strip can cost no height at all rather than a 24px empty band.
    const { dom, g } = start([bottomContributor("test.b", [bottom("p")])]);
    g.dispatch("view/setBottomPaneHeight", { id: "p", height: 0 });
    expect(bottomPanes(dom)[0]?.style["height"]).toBe("0px");
    expect(bottomPanes(dom)[0]?.style["display"]).toBe("none");
    // Reversible by the same command, back to a real height.
    g.dispatch("view/setBottomPaneHeight", { id: "p", height: 64 });
    expect(bottomPanes(dom)[0]?.style["height"]).toBe("64px");
    expect(bottomPanes(dom)[0]?.style["display"] ?? "").toBe("");
  });

  it("keeps working on a resizable: false pane, which the reader cannot drag", () => {
    const events: unknown[] = [];
    const onResize: number[] = [];
    const { dom, g } = start([
      resizedProbe(events),
      bottomContributor("test.b", [
        bottom("p", { resizable: false, onResize: (h) => onResize.push(h) }),
      ]),
    ]);
    expect(hDividers(dom).length).toBe(0);
    g.dispatch("view/setBottomPaneHeight", { id: "p", height: 64 });
    expect(bottomPanes(dom)[0]?.style["height"]).toBe("64px");
    expect(events).toEqual([{ id: "p", height: 64 }]);
    expect(onResize).toEqual([64]);
  });

  it("is silent for an unchanged height, an unknown id and an unusable height", () => {
    const events: unknown[] = [];
    const onResize: number[] = [];
    const { dom, g } = start([
      resizedProbe(events),
      bottomContributor("test.b", [bottom("p", { onResize: (h) => onResize.push(h) })]),
    ]);
    g.dispatch("view/setBottomPaneHeight", { id: "p", height: 40 });
    expect(() => g.dispatch("view/setBottomPaneHeight", { id: "nope", height: 64 })).not.toThrow();
    g.dispatch("view/setBottomPaneHeight", { id: "p", height: Number.NaN });
    g.dispatch("view/setBottomPaneHeight", { id: "p", height: Infinity });
    expect(bottomPanes(dom)[0]?.style["height"]).toBe("40px");
    expect(events).toEqual([]);
    expect(onResize).toEqual([]);
  });

  it("guards a throwing onResize and still applies the height and emits the event", () => {
    const errors: unknown[] = [];
    const events: unknown[] = [];
    const { dom, g } = start([
      errorsProbe(errors),
      resizedProbe(events),
      bottomContributor("test.b", [
        bottom("p", {
          onResize: () => {
            throw new Error("boom");
          },
        }),
      ]),
    ]);
    g.dispatch("view/setBottomPaneHeight", { id: "p", height: 64 });
    expect(bottomPanes(dom)[0]?.style["height"]).toBe("64px");
    expect(errors.length).toBe(1);
    expect(errors[0]).toMatchObject({ error: { point: "view/bottomPanes" } });
    expect(events).toEqual([{ id: "p", height: 64 }]);
  });
});

describe("commands dispatched from inside a contribution's mount", () => {
  // The command surface is wired through `mountBottomRegion`'s `connect` hook before any bottom
  // contribution's `mount` runs: a contributor that sets its own height from `mount` — the
  // empty-roster formula's first-paint shape — must hit the live implementation, not the
  // pre-wiring unknown-id no-op.
  it("applies view/setBottomPaneHeight dispatched from a mount", () => {
    const onResize: number[] = [];
    const dispatcher = definePlugin({
      meta: { id: "test.b", dependsOn: ["stargantt.view"] },
      setup(ctx) {
        ctx.contribute(
          "view/bottomPanes",
          bottom("p", {
            onResize: (h) => onResize.push(h),
            mount: () => ctx.dispatch("view/setBottomPaneHeight", { id: "p", height: 72 }),
          }),
        );
      },
    });
    const { dom } = start([dispatcher]);
    expect(bottomPanes(dom)[0]?.style["height"]).toBe("72px");
    expect(hDividers(dom)[0]?.getAttribute("aria-valuenow")).toBe("72");
    expect(onResize).toEqual([72]);
  });

  it("reflects a view/paneToggle dispatched from a mount in the written columns", () => {
    const toggler = definePlugin({
      meta: { id: "test.b", dependsOn: ["stargantt.view"] },
      setup(ctx) {
        ctx.contribute(
          "view/bottomPanes",
          bottom("p", {
            mount: () => ctx.dispatch("view/paneToggle", { id: "l", collapsed: true }),
          }),
        );
      },
    });
    const { dom } = start([
      // `resizable: false` renders no divider, so a collapsed pane leaves a 0 px gutter — a
      // value the pre-toggle layout (the pane at the harness's default rect width) cannot
      // produce, which is what makes a stale write detectable.
      sideContributor("test.s", [side("l", { collapsible: true, resizable: false })]),
      toggler,
    ]);
    expect(bottomPanes(dom)[0]?.children[0]?.style["width"]).toBe("0px");
  });
});

describe("a zero-height pane", () => {
  it("hides a pane whose initial height resolves to 0, together with its divider", () => {
    let mounts = 0;
    const { dom } = start([
      bottomContributor("test.b", [bottom("p", { height: 0, mount: () => (mounts += 1) })]),
    ]);
    const pane = bottomPanes(dom)[0];
    const divider = hDividers(dom)[0];
    expect(pane?.style["display"]).toBe("none");
    expect(divider?.style["display"]).toBe("none");
    // Still mounted exactly once.
    expect(mounts).toBe(1);
  });

  it("reappears with its divider the moment the height becomes positive", () => {
    const { dom, g } = start([bottomContributor("test.b", [bottom("p", { height: 0 })])]);
    g.dispatch("view/setBottomPaneHeight", { id: "p", height: 48 });
    expect(bottomPanes(dom)[0]?.style["display"]).toBe("");
    expect(bottomPanes(dom)[0]?.style["height"]).toBe("48px");
    expect(hDividers(dom)[0]?.style["display"]).toBe("");
  });

  it("lets the command drive a resizable: false pane back to 0, hiding it again", () => {
    const { dom, g } = start([
      bottomContributor("test.b", [bottom("p", { resizable: false, height: 32 })]),
    ]);
    g.dispatch("view/setBottomPaneHeight", { id: "p", height: 0 });
    expect(bottomPanes(dom)[0]?.style["height"]).toBe("0px");
    expect(bottomPanes(dom)[0]?.style["display"]).toBe("none");
  });

  // The interactive floor keeps every user gesture away from the zero-height state and the
  // view-mode path is similarly guarded — but a contributor can still drive a `resizable: false`
  // pane to 0 (the empty-roster lanes strip) while focus legitimately sits on a focusable surface
  // the contribution mounted, e.g. the lanes strip's `tabindex="0"` scroll surface. Hiding the
  // strip must not orphan `document.activeElement` to `<body>`.
  it("reanchors focus held inside a strip its contributor drives to zero height", () => {
    let bodyEl: HTMLElement | undefined;
    const { dom, g } = start([
      bottomContributor("test.b", [
        bottom("p", {
          resizable: false,
          height: 32,
          mount: (els) => {
            bodyEl = els.body;
          },
        }),
      ]),
    ]);
    const surface = dom.document.createElement("div");
    surface.setAttribute("tabindex", "0");
    (bodyEl as unknown as FakeElement).appendChild(surface);
    surface.focus();
    expect(dom.document.activeElement).toBe(surface);

    g.dispatch("view/setBottomPaneHeight", { id: "p", height: 0 });
    expect(bottomPanes(dom)[0]?.style["display"]).toBe("none");
    // Focus moved to the still-visible chart pane (the reanchoring target), not dropped to <body>.
    expect(dom.document.activeElement).toBe(chartEl(dom));
    expect(dom.document.activeElement).not.toBe(dom.document.body);
  });
});

describe("view modes over the region", () => {
  it("hides the region with the chart pane in grid view and shows it again elsewhere", () => {
    const { dom, g } = start([
      sideContributor("test.s", [side("l")]),
      bottomContributor("test.b", [bottom("p")]),
    ]);
    expect(region(dom)?.style["display"] ?? "").toBe("");
    g.dispatch("view/setViewMode", { mode: "grid" });
    expect(region(dom)?.style["display"]).toBe("none");
    g.dispatch("view/setViewMode", { mode: "gantt" });
    expect(region(dom)?.style["display"]).toBe("");
    g.dispatch("view/setViewMode", { mode: "split" });
    expect(region(dom)?.style["display"]).toBe("");
  });

  it("reanchors focus held inside the region before a grid switch hides it", () => {
    let bodyEl: HTMLElement | undefined;
    const { dom, g } = start([
      sideContributor("test.s", [side("l")]),
      bottomContributor("test.b", [
        bottom("p", {
          mount: (els) => {
            bodyEl = els.body;
          },
        }),
      ]),
    ]);
    const input = dom.document.createElement("div");
    (bodyEl as unknown as FakeElement).appendChild(input);
    input.focus();
    expect(dom.document.activeElement).toBe(input);

    g.dispatch("view/setViewMode", { mode: "grid" });

    // The chart pane is hidden too, so the still-visible anchor is the grown left pane.
    const leftPane = dom.root
      .findAll("sg-pane")
      .find((el) => !el.classList.contains("sg-pane--chart"));
    expect(dom.document.activeElement).toBe(leftPane);
    expect(dom.document.activeElement).not.toBe(dom.document.body);
  });

  it("reanchors focus off a horizontal divider a grid switch is about to hide", () => {
    const { dom, g } = start([
      sideContributor("test.s", [side("l")]),
      bottomContributor("test.b", [bottom("p")]),
    ]);
    const divider = hDividers(dom)[0]!;
    divider.focus();
    g.dispatch("view/setViewMode", { mode: "grid" });
    expect(dom.document.activeElement).not.toBe(divider);
    expect(dom.document.activeElement).not.toBe(dom.document.body);
  });

  it("leaves focus inside the region alone in gantt view, where the region stays visible", () => {
    const { dom, g } = start([
      sideContributor("test.s", [side("l")]),
      bottomContributor("test.b", [bottom("p")]),
    ]);
    const divider = hDividers(dom)[0]!;
    divider.focus();
    g.dispatch("view/setViewMode", { mode: "gantt" });
    expect(dom.document.activeElement).toBe(divider);
  });
});

describe("side panes learn of a height change", () => {
  it("re-invokes each mounted side pane's onResize with the width it occupies", () => {
    const widths: number[] = [];
    const { g } = start([
      sideContributor("test.s", [
        side("l", { initialWidth: 180, onResize: (w) => widths.push(w) }),
      ]),
      bottomContributor("test.b", [bottom("p")]),
    ]);
    g.dispatch("view/setBottomPaneHeight", { id: "p", height: 64 });
    expect(widths).toEqual([180]);
  });

  it("reports 0 for a collapsed side pane and skips a no-op height command", () => {
    const widths: number[] = [];
    const { g } = start([
      sideContributor("test.s", [
        side("l", { initialWidth: 180, collapsible: true, onResize: (w) => widths.push(w) }),
      ]),
      bottomContributor("test.b", [bottom("p")]),
    ]);
    g.dispatch("view/paneToggle", { id: "l", collapsed: true });
    g.dispatch("view/setBottomPaneHeight", { id: "p", height: 64 });
    expect(widths).toEqual([0]);
    // A command that does not move the height notifies nobody.
    g.dispatch("view/setBottomPaneHeight", { id: "p", height: 64 });
    expect(widths).toEqual([0]);
  });

  it("also notifies after a divider drag changes the height", () => {
    const widths: number[] = [];
    const { dom } = start([
      sideContributor("test.s", [
        side("l", { initialWidth: 180, onResize: (w) => widths.push(w) }),
      ]),
      bottomContributor("test.b", [bottom("p")]),
    ]);
    const divider = hDividers(dom)[0];
    divider?.fire("pointerdown", { clientY: 100 });
    dom.document.fire("pointermove", { clientY: 60 });
    dom.document.fire("pointerup", {});
    expect(widths).toEqual([180]);
  });
});

describe("resource ownership (CLAUDE.md constraint)", () => {
  it("dispose removes the region, its listeners and the row observer", () => {
    const { dom, g } = start([
      sideContributor("test.s", [side("l")]),
      bottomContributor("test.b", [bottom("p")]),
    ]);
    const divider = hDividers(dom)[0];
    expect(divider?.listenerCount("pointerdown")).toBe(1);
    expect(divider?.listenerCount("keydown")).toBe(1);
    expect(dom.resizeObserverCount()).toBe(1);
    expect(dom.document.listenerCount("pointermove")).toBe(1);

    g.dispose();
    expect(dom.root.children.length).toBe(0);
    expect(divider?.listenerCount()).toBe(0);
    expect(dom.resizeObserverCount()).toBe(0);
    expect(dom.document.listenerCount()).toBe(0);
    expect(dom.liveObservers()).toBe(0);
  });

  it("installs the document listeners when only bottom dividers exist", () => {
    const { dom } = start([bottomContributor("test.b", [bottom("p")])]);
    expect(dom.document.listenerCount("pointermove")).toBe(1);
    expect(dom.document.listenerCount("pointerup")).toBe(1);
    expect(dom.document.listenerCount("pointercancel")).toBe(1);
  });
});
