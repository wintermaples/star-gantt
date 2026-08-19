/**
 * `src/internal/layer.ts` — the bar layer's paint pass and the guarded overlay list, without a host.
 *
 * Only the rows the viewport covers are visited, the pass-scoped resolutions happen once per pass,
 * each bar is painted then labelled then overlaid, and the geometry snapshot is committed even when
 * the pass throws.
 */
import { describe, expect, it, vi } from "vitest";
import type { BarBox, BarOverlayRenderer, BarRenderer, BarStyleProvider } from "../src/index";
import { createLabelFeature } from "../src/internal/labels";
import { asHostLabel, resolveBarOptions } from "../src/internal/options";
import { createBarLayerDraw, createOverlayList } from "../src/internal/layer";
import { LABEL_GAP } from "../src/internal/paint-text";
import { createBarGeometry } from "../src/internal/service";
import { FakeContext2D, asContext } from "./_utils/canvas";
import { rowsOf, scaleOf, store, task, themeOf } from "./_fakes";

const ROW = 20;
const VP = { scrollLeft: 0, scrollTop: 0, width: 200, height: 40 };

const tasks = [
  task({ id: "a", start: 0, end: 10_000 }),
  task({ id: "b", start: 20_000, end: 30_000 }),
  task({ id: "c", start: 40_000, end: 50_000 }),
];

interface PassOptions {
  order?: (string | undefined)[];
  styleProvider?: BarStyleProvider | undefined;
  label?: unknown;
  overlays?: readonly BarOverlayRenderer[];
  tokens?: Record<string, string>;
  themeReads?: string[];
  /** The latched `avatar` provider, as `setup()` would hand it over. */
  avatarOf?: (task: { id: string }) => { initials?: string; color?: string } | undefined;
  /** The replacement bar renderer and the reporter its first throw goes to. */
  renderBar?: BarRenderer;
  renderBarFault?: (error: unknown) => void;
  /** The view's live viewport, as `setup()` wires it; omitted commits every draw. */
  liveViewport?: () => typeof VP;
}

function pass(options: PassOptions = {}) {
  const reads = options.themeReads ?? [];
  const tokens = options.tokens ?? {};
  const theme = { get: (t: string) => (reads.push(t), tokens[t] ?? "") };
  const rows = rowsOf({ order: options.order ?? ["a", "b", "c"], rowHeight: ROW });
  const geometry = createBarGeometry({
    rows,
    data: store(tasks),
    scale: scaleOf(),
    expand: { isExpanded: () => true },
    collapsedSummary: "range",
  });
  const draws = createBarLayerDraw({
    rows,
    geometry,
    theme,
    styleProvider: () => options.styleProvider,
    labels: createLabelFeature(theme, () => undefined, {
      host: asHostLabel(options.label),
      duration: { enabled: false, placement: undefined },
      progress: { enabled: false, placement: undefined },
      backdrop: { color: undefined, padding: undefined, radius: undefined },
    }),
    overlays: () => options.overlays ?? [],
    ...(options.avatarOf === undefined && options.renderBar === undefined
      ? {}
      : {
          decor: {
            ...(options.avatarOf === undefined ? {} : { avatarOf: options.avatarOf as never }),
            ...(options.renderBar === undefined ? {} : { renderBar: options.renderBar }),
            ...(options.renderBarFault === undefined
              ? {}
              : { renderBarFault: options.renderBarFault }),
          },
        }),
    ...(options.liveViewport === undefined ? {} : { liveViewport: options.liveViewport }),
  });
  const g = new FakeContext2D();
  return {
    geometry,
    g,
    reads,
    draw: (vp: typeof VP = VP): void => draws.bars(asContext(g), vp),
    drawDecorations: (vp: typeof VP = VP): void => draws.decorations(asContext(g), vp),
  };
}

/** The `fillRect` calls a bar body produces, in order. */
function bars(g: FakeContext2D): { x: number; width: number; fill: string }[] {
  return g.calls("fillRect").map((op) => ({ x: op.args[0] ?? 0, width: op.args[2] ?? 0, fill: op.fill }));
}

describe("createBarLayerDraw", () => {
  it("paints one bar per row the viewport covers, top to bottom", () => {
    const p = pass();
    p.draw();
    // The viewport is 40px tall over 20px rows, so rows 0..2 are visited (`rowAtY` clamps).
    expect(bars(p.g).map((b) => b.x)).toEqual([0, 20, 40]);
  });

  it("paints nothing at all with no rows or a degenerate viewport", () => {
    const empty = pass({ order: [] });
    empty.draw();
    expect(empty.g.ops).toHaveLength(0);

    for (const vp of [
      { ...VP, width: 0 },
      { ...VP, height: 0 },
    ]) {
      const p = pass();
      p.draw(vp);
      expect(p.g.ops).toHaveLength(0);
    }
  });

  it("commits the snapshot of the rows it visited, in row order", () => {
    const p = pass();
    p.draw();
    expect(p.geometry.service.visibleBoxes().map((b) => b.id)).toEqual(["a", "b", "c"]);
    expect(p.geometry.service.barBoxOf("b")?.x).toBe(20);
  });

  // `renderTo` (export tiles, thumbnails) replays the draw for a foreign viewport and must touch no
  // on-screen state.
  it("does not commit a snapshot for a draw with a foreign viewport", () => {
    const p = pass({ liveViewport: () => VP });
    p.draw();
    const before = p.geometry.service.visibleBoxes().map((b) => ({ id: b.id, x: b.x }));
    expect(before.map((b) => b.id)).toEqual(["a", "b", "c"]);
    // An export-style draw over a scrolled/resized viewport the screen is not showing.
    p.draw({ scrollLeft: 25, scrollTop: 0, width: 400, height: 40 });
    expect(p.geometry.service.visibleBoxes().map((b) => ({ id: b.id, x: b.x }))).toEqual(before);
    expect(p.geometry.service.barBoxOf("b")?.x).toBe(20);
  });

  it("commits the snapshot of a draw whose viewport matches the live one", () => {
    const live = { ...VP, scrollLeft: 15 };
    const p = pass({ liveViewport: () => live });
    p.draw({ ...VP, scrollLeft: 15 });
    expect(p.geometry.service.barBoxOf("b")?.x).toBe(5);
  });

  it("keeps a horizontally culled bar in the snapshot but does not paint it", () => {
    const p = pass();
    // Scrolled so bar "a" (content x 0..10) is entirely left of the viewport.
    p.draw({ ...VP, scrollLeft: 15 });
    expect(p.geometry.service.visibleBoxes().map((b) => b.id)).toEqual(["a", "b", "c"]);
    expect(bars(p.g).map((b) => b.x)).toEqual([5, 25]);
  });

  it("skips a row carrying no task without disturbing the rest", () => {
    const p = pass({ order: ["a", undefined, "c"] });
    p.draw();
    expect(bars(p.g).map((b) => b.x)).toEqual([0, 40]);
    expect(p.geometry.service.visibleBoxes().map((b) => b.id)).toEqual(["a", "c"]);
  });

  it("commits the snapshot even when the pass throws part-way through it", () => {
    const boom: BarStyleProvider = (t) => {
      if (t.id === "b") throw new Error("boom");
      return undefined;
    };
    const p = pass({ styleProvider: boom });
    // The pass's own style guard is bypassed here: the provider is handed over already "guarded".
    expect(() => p.draw()).toThrow("boom");
    expect(p.geometry.service.visibleBoxes().map((b) => b.id)).toEqual(["a", "b"]);
  });

  it("resolves the style provider once per pass, not once per bar", () => {
    let resolutions = 0;
    const rows = rowsOf({ order: ["a", "b", "c"], rowHeight: ROW });
    const geometry = createBarGeometry({
      rows,
      data: store(tasks),
      scale: scaleOf(),
      expand: { isExpanded: () => true },
      collapsedSummary: "range",
    });
    const provider: BarStyleProvider = () => ({ color: "red" });
    const draws = createBarLayerDraw({
      rows,
      geometry,
      theme: themeOf(),
      styleProvider: () => {
        resolutions += 1;
        return provider;
      },
      labels: createLabelFeature(themeOf(), () => undefined),
      overlays: () => [],
    });
    const g = new FakeContext2D();
    draws.bars(asContext(g), VP);
    expect(resolutions).toBe(1);
    expect(bars(g).every((b) => b.fill === "red")).toBe(true);
  });

  it("reads the track token once per pass and no label token while labels are off", () => {
    const p = pass();
    p.draw();
    expect(p.reads.filter((t) => t === "--sg-bar-track-alpha")).toHaveLength(1);
    expect(p.reads).not.toContain("--sg-bar-label-fg");
    expect(p.reads).not.toContain("--sg-bar-label-font");
    expect(p.g.texts).toHaveLength(0);
  });

  // Labels are recorded by the bar pass and painted by the decoration pass, above the dependency
  // lines, so both passes run here.
  it("reads each label token once per pass and labels every painted bar", () => {
    const p = pass({ label: (t: { id: string }) => `#${t.id}` });
    p.draw();
    p.drawDecorations();
    expect(p.reads.filter((t) => t === "--sg-bar-label-fg")).toHaveLength(1);
    expect(p.reads.filter((t) => t === "--sg-bar-label-font")).toHaveLength(1);
    expect(p.g.texts.map((t) => t.text)).toEqual(["#a", "#b", "#c"]);
    expect(p.g.texts[0]?.x).toBe(10 + LABEL_GAP);
  });

  // The bar band paints only the bar bodies. Labels *and* overlays follow in the later decoration
  // band, so a dependency line can be drawn over neither; within that band the order per bar is
  // labels then the overlay, keeping the overlay last for its own bar.
  it("paints only bodies in the bar band, then label-then-overlay per bar afterwards", () => {
    const order: string[] = [];
    const overlay: BarOverlayRenderer = (_g, bar) => void order.push(`overlay:${String(bar.id)}`);
    const p = pass({ label: (t: { id: string }) => String(t.id), overlays: [overlay] });
    const g = p.g;
    const original = g.fillText.bind(g);
    vi.spyOn(g, "fillText").mockImplementation((text: string, x: number, y: number) => {
      order.push(`label:${text}`);
      original(text, x, y);
    });
    vi.spyOn(g, "fillRect").mockImplementation(() => void order.push("bar"));
    p.draw();
    expect(order).toEqual(["bar", "bar", "bar"]);
    p.drawDecorations();
    expect(order.slice(3)).toEqual([
      "label:a",
      "overlay:a",
      "label:b",
      "overlay:b",
      "label:c",
      "overlay:c",
    ]);
    vi.restoreAllMocks();
  });

  it("skips a label the provider declines, and paints its bar anyway", () => {
    const p = pass({ label: (t: { id: string }) => (t.id === "b" ? "kept" : undefined) });
    p.draw();
    p.drawDecorations();
    expect(p.g.texts.map((t) => t.text)).toEqual(["kept"]);
    expect(bars(p.g)).toHaveLength(3);
  });
});

// The replacement bar renderer runs inside a saved canvas state; its first throw is reported once,
// painting falls back to the built-in look for that bar, and the renderer is disabled for good.
describe("renderBar", () => {
  it("replaces the built-in painting and can call it back", () => {
    const seen: string[] = [];
    const p = pass({
      renderBar: (g, args) => {
        seen.push(String(args.task.id));
        g.strokeRect(args.box.x, args.box.y, args.box.width, args.box.height);
      },
    });
    p.draw();
    expect(seen).toEqual(["a", "b", "c"]);
    expect(p.g.calls("strokeRect")).toHaveLength(3);
    expect(p.g.calls("fillRect")).toHaveLength(0);
  });

  it("paints the built-in look when the renderer calls defaultPaint", () => {
    const p = pass({ renderBar: (_g, args) => args.defaultPaint() });
    p.draw();
    expect(bars(p.g).map((b) => b.x)).toEqual([0, 20, 40]);
  });

  it("falls back to the built-in look after a throw, reported once, and stays disabled", () => {
    const fault = vi.fn();
    let calls = 0;
    const p = pass({
      renderBar: () => {
        calls += 1;
        throw new Error("boom");
      },
      renderBarFault: fault,
    });
    p.draw();
    // The faulting bar still paints, and the two after it go straight to the built-in painter.
    expect(bars(p.g)).toHaveLength(3);
    expect(calls).toBe(1);
    expect(fault).toHaveBeenCalledTimes(1);
    p.draw();
    expect(calls).toBe(1);
    expect(fault).toHaveBeenCalledTimes(1);
  });

  it("brackets the renderer in a saved canvas state, restored even when it throws", () => {
    const clean = pass({ renderBar: (g) => g.strokeRect(0, 0, 1, 1) });
    clean.draw();
    expect(clean.g.depth).toBe(0);
    expect(clean.g.calls("save")).toHaveLength(3);
    expect(clean.g.calls("restore")).toHaveLength(3);

    const thrown = pass({
      renderBar: () => {
        throw new Error("boom");
      },
      renderBarFault: () => undefined,
    });
    thrown.draw();
    expect(thrown.g.depth).toBe(0);
  });
});

// Under `collapsedSummary: "hidden"` a collapsed summary paints nothing and leaves the composite.
describe("a hidden collapsed summary", () => {
  const parent = task({ id: "p", start: 0, end: 60_000, type: "summary" });

  function hiddenPass(expanded: boolean) {
    const rows = rowsOf({ order: ["p"], rowHeight: ROW });
    const data = store([parent]);
    const geometry = createBarGeometry({
      rows,
      data,
      scale: scaleOf(),
      expand: { isExpanded: () => expanded },
      collapsedSummary: "hidden",
    });
    const draws = createBarLayerDraw({
      rows,
      geometry,
      theme: themeOf(),
      styleProvider: () => undefined,
      labels: createLabelFeature(themeOf(), () => undefined),
      overlays: () => [],
      options: resolveBarOptions({ collapsedSummary: "hidden" }),
      expand: { isExpanded: () => expanded },
      data,
    });
    const g = new FakeContext2D();
    return { g, geometry, draw: (): void => draws.bars(asContext(g), VP) };
  }

  it("paints nothing and publishes no box while collapsed", () => {
    const p = hiddenPass(false);
    p.draw();
    expect(p.g.ops).toHaveLength(0);
    expect(p.geometry.service.visibleBoxes()).toEqual([]);
    expect(p.geometry.service.barBoxOf("p")).toBeUndefined();
  });

  it("paints its own span again once expanded", () => {
    const p = hiddenPass(true);
    p.draw();
    expect(p.geometry.service.barBoxOf("p")).toBeDefined();
    expect(p.g.ops.length).toBeGreaterThan(0);
  });
});

// A split row paints its children, minus any whose own row is hidden, and each painted child
// carries the regular per-task pipeline (style, pattern, renderBar, labels) but none of the
// per-row-owning-bar contributions.
describe("a split row", () => {
  const parent = task({ id: "p", start: 0, end: 60_000, type: "summary" });
  const kids = [
    task({ id: "c1", parentId: "p", start: 0, end: 10_000 }),
    task({ id: "c2", parentId: "p", start: 20_000, end: 30_000 }),
  ];

  interface SplitOptions {
    /**
     * Children the row model gave a row of height 0 — what the `rows/height` reduction produces
     * for a filtered-out task. They are listed after the parent's own row.
     */
    hidden?: string[];
    label?: unknown;
    overlays?: readonly BarOverlayRenderer[];
    styleProvider?: BarStyleProvider | undefined;
    avatarOf?: (task: { id: string }) => { initials?: string } | undefined;
    renderBar?: BarRenderer;
  }

  function splitPass(options: SplitOptions = {}) {
    const hidden = options.hidden ?? [];
    const rows = rowsOf({ order: ["p", ...hidden], rowHeight: ROW, zeroHeight: hidden });
    const data = store([parent, ...kids]);
    const geometry = createBarGeometry({
      rows,
      data,
      scale: scaleOf(),
      expand: { isExpanded: () => false },
      collapsedSummary: "split",
    });
    const theme = themeOf();
    const draws = createBarLayerDraw({
      rows,
      geometry,
      theme,
      styleProvider: () => options.styleProvider,
      labels: createLabelFeature(theme, () => undefined, {
        host: asHostLabel(options.label),
        duration: { enabled: false, placement: undefined },
        progress: { enabled: false, placement: undefined },
        backdrop: undefined,
      }),
      overlays: () => options.overlays ?? [],
      options: resolveBarOptions({ collapsedSummary: "split", label: options.label }),
      ...(options.avatarOf === undefined && options.renderBar === undefined
        ? {}
        : {
            decor: {
              ...(options.avatarOf === undefined ? {} : { avatarOf: options.avatarOf as never }),
              ...(options.renderBar === undefined ? {} : { renderBar: options.renderBar }),
            },
          }),
      expand: { isExpanded: () => false },
      tree: { query: () => ({ children: new Map([["p", kids.map((k) => k.id)]]) }) as never },
      data,
    });
    const g = new FakeContext2D();
    return {
      geometry,
      g,
      draw: (): void => draws.bars(asContext(g), VP),
      drawDecorations: (): void => draws.decorations(asContext(g), VP),
    };
  }

  it("paints every child in the parent's band and puts them in the snapshot", () => {
    const p = splitPass();
    p.draw();
    expect(bars(p.g).map((b) => b.x)).toEqual([0, 20]);
    expect(p.geometry.service.visibleBoxes().map((b) => b.id)).toEqual(["c1", "c2"]);
  });

  it("excludes a child whose own row is hidden from painting and from the snapshot", () => {
    const p = splitPass({ hidden: ["c2"] });
    p.draw();
    expect(bars(p.g).map((b) => b.x)).toEqual([0]);
    expect(p.geometry.service.visibleBoxes().map((b) => b.id)).toEqual(["c1"]);
    expect(p.geometry.service.barBoxOf("c2")).toBeUndefined();
  });

  it("paints nothing at all when every child is hidden", () => {
    const p = splitPass({ hidden: ["c1", "c2"] });
    p.draw();
    expect(bars(p.g)).toHaveLength(0);
    expect(p.geometry.service.visibleBoxes()).toEqual([]);
  });

  it("labels the painted children and colours them through the style provider", () => {
    const p = splitPass({
      hidden: ["c2"],
      label: (t: { id: string }) => `#${t.id}`,
      styleProvider: () => ({ color: "#123456" }),
    });
    p.draw();
    expect(bars(p.g).map((b) => b.fill)).toEqual(["#123456"]);
    p.drawDecorations();
    expect(p.g.texts.map((t) => t.text)).toEqual(["#c1"]);
  });

  it("routes the child bars through the replacement renderer", () => {
    const seen: string[] = [];
    const p = splitPass({
      renderBar: (_g, args) => {
        seen.push(String(args.task.id));
        args.defaultPaint();
      },
    });
    p.draw();
    expect(seen).toEqual(["c1", "c2"]);
  });

  it("withholds the adornments and the overlays an in-row child never owns", () => {
    const seen: string[] = [];
    const p = splitPass({
      label: (t: { id: string }) => t.id,
      overlays: [(_g, bar) => void seen.push(String(bar.id))],
      avatarOf: (t) => ({ initials: t.id }),
    });
    p.draw();
    p.drawDecorations();
    expect(seen).toEqual([]);
    // Only the labels reached the canvas: an avatar would have drawn its initials too.
    expect(p.g.texts.map((t) => t.text)).toEqual(["c1", "c2"]);
  });
});

describe("the decoration pass", () => {
  const avatarOf = (t: { id: string }) => ({ initials: t.id.toUpperCase() });

  it("draws no avatar during the bar pass, and one per painted bar afterwards", () => {
    const p = pass({ avatarOf });
    p.draw();
    expect(p.g.texts).toHaveLength(0);
    p.drawDecorations();
    expect(p.g.texts.map((t) => t.text)).toEqual(["A", "B", "C"]);
  });

  it("leaves a horizontally culled bar undecorated", () => {
    const p = pass({ avatarOf });
    // Bar "a" (content x 0..10) is entirely left of the viewport at this scroll offset.
    p.draw({ ...VP, scrollLeft: 15 });
    p.drawDecorations();
    expect(p.g.texts.map((t) => t.text)).toEqual(["B", "C"]);
  });

  it("consumes the record, so a second decoration pass alone draws nothing", () => {
    const p = pass({ avatarOf });
    p.draw();
    p.drawDecorations();
    const painted = p.g.texts.length;
    p.drawDecorations();
    expect(p.g.texts).toHaveLength(painted);
  });

  it("reuses the record's entries instead of allocating one per frame", () => {
    const p = pass({ avatarOf });
    p.draw();
    p.drawDecorations();
    const first = p.g.texts.map((t) => t.text);
    p.draw();
    p.drawDecorations();
    expect(p.g.texts.map((t) => t.text)).toEqual([...first, ...first]);
  });

  it("draws nothing at all while no decoration provider is configured", () => {
    const p = pass();
    p.draw();
    p.drawDecorations();
    expect(p.g.texts).toHaveLength(0);
  });
});

describe("createOverlayList", () => {
  const box: BarBox = { id: "a", x: 0, y: 0, width: 10, height: 10, gutterStart: 0, gutterEnd: 0 };

  it("wraps each contribution in a saved canvas state", () => {
    const depths: number[] = [];
    const g = new FakeContext2D();
    const list = createOverlayList(
      () => [(ctx) => void depths.push((ctx as unknown as FakeContext2D).depth)],
      () => undefined,
    );
    for (const overlay of list()) overlay(asContext(g), box);
    expect(depths).toEqual([1]);
    expect(g.depth).toBe(0);
  });

  it("rebuilds only when the reduced array changes identity", () => {
    let raw: BarOverlayRenderer[] = [() => undefined];
    const list = createOverlayList(() => raw, () => undefined);
    const first = list();
    expect(list()).toBe(first);
    raw = [...raw];
    expect(list()).not.toBe(first);
  });

  it("treats a missing reduction as no contributions", () => {
    const list = createOverlayList(() => undefined, () => undefined);
    expect(list()).toEqual([]);
  });

  it("latches a throwing contribution, reports it once, and keeps the others running", () => {
    const fault = vi.fn();
    let good = 0;
    const g = new FakeContext2D();
    // One stable array, as the core's reference-stable reduction hands out: the latch lives in the
    // wrapper, so a fresh array per read would rebuild the wrappers and clear it.
    const raw: BarOverlayRenderer[] = [
      () => {
        throw new Error("boom");
      },
      () => void (good += 1),
    ];
    const list = createOverlayList(() => raw, fault);
    for (let i = 0; i < 3; i += 1) for (const overlay of list()) overlay(asContext(g), box);
    expect(fault).toHaveBeenCalledTimes(1);
    expect(good).toBe(3);
    // The barrier restores the canvas state it saved even on the throwing pass.
    expect(g.depth).toBe(0);
  });
});
