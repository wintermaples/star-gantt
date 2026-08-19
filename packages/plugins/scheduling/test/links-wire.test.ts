/**
 * `internal/links/wire` — the area's wiring, driven hostlessly against recording doubles.
 *
 * docs/specs/plugins/scheduling.md §5: the two layer claims (69 / 110), the `taskbars/endGutter`
 * reservation (17 px), the `renderer/hitTest` contribution, the port pass, the port-drag creation
 * path over the public `pointer/*` stream (§4.3), the link selection and deletion keys, the path
 * emphasis and its 0.35 dim, the drop-candidate ring, the `Alt+L` chord, the inspector
 * contribution and the three repaint subscriptions (§5.8).
 */
import { describe, expect, it } from "vitest";
import { mockStore } from "@stargantt/sdk";
import type { DataService, Link, LinkId, Task, TaskId } from "@stargantt/plugin-data-store";
import type { SelectionState } from "@stargantt/plugin-interaction";
import type { KeyBinding } from "@stargantt/plugin-a11y";
import type { EndGutterContribution } from "@stargantt/plugin-task-bars";
import type { HitTester, LayerContribution } from "@stargantt/plugin-view";
import type { SidePanelFieldContribution } from "@stargantt/plugin-interaction";
import { resolveConfig } from "../src/config";
import type { DependenciesConfig } from "../src/config";
import { resolveMessages } from "../src/internal/messages";
import type { SchedulingAreaDeps } from "../src/internal/areas";
import { wireLinks } from "../src/internal/links/wire";
import { PORT_CLEARANCE, PORT_RADIUS, portCentre } from "../src/internal/links/geometry";
import { PORT_RING_RADIUS } from "../src/internal/links/paint";
import { DIM_ALPHA } from "../src/internal/links/style";
import type { Rect } from "../src/internal/links/geometry";
import {
  barsDouble,
  focusDouble,
  fullViewport,
  pointerEvent,
  recordingCanvas,
  recordingContext,
  rect,
  serviceTable,
  stubData,
  stubLink,
  stubRows,
  stubTask,
  viewDouble,
} from "./links-doubles";
import type { RecordingCanvas, RecordingContext } from "./links-doubles";

const ROW_HEIGHT = 30;
const IDS = ["t0", "t1", "t2"];

/** Bar boxes: 100 px wide, 20 px tall, one per row, each 200 px right of the previous. */
function boxes(): Map<TaskId, Rect> {
  return new Map<TaskId, Rect>(IDS.map((id, row) => [id, rect(row * 200, row * ROW_HEIGHT + 5)]));
}

interface Harness {
  rec: RecordingContext;
  view: ReturnType<typeof viewDouble>;
  tasks: ReturnType<typeof mockStore<ReadonlyMap<TaskId, Readonly<Task>>>>;
  selection: ReturnType<typeof mockStore<SelectionState>>;
  focus: ReturnType<typeof focusDouble>;
  bars: ReturnType<typeof barsDouble>;
  /** Replaces the stored links and publishes the resulting data change. */
  setLinks(links: readonly Link[]): void;
  /** Draws one layer by contribution id and returns the recording canvas. */
  paint(layerId: string): RecordingCanvas;
  binding(key: string, index?: number): KeyBinding;
  bindings(key: string): KeyBinding[];
  hit: HitTester;
}

interface WireOptions {
  dependencies?: DependenciesConfig;
  links?: readonly Link[];
  /** Which ids have a bar of their own; defaults to every id with a box. */
  ownBars?: readonly TaskId[];
  /** Theme token values; anything absent resolves to "" and falls back. */
  tokens?: Record<string, string>;
  /** Omit the optional row model (§14). */
  withoutRows?: boolean;
  /** Omit the optional a11y focus service (§14). */
  withoutFocus?: boolean;
  /** Omit the optional selection service (§14). */
  withoutSelection?: boolean;
  tasks?: readonly Task[];
}

function wire(options: WireOptions = {}): Harness {
  const tasks = options.tasks ?? IDS.map((id) => stubTask(id));
  const links = options.links ?? [];
  // The store slice is rebuilt by `setLinks`, so a test can take a link away and then publish the
  // data change that makes the area notice.
  let slice = stubData(tasks, links);
  const tasksStore = mockStore<ReadonlyMap<TaskId, Readonly<Task>>>(
    new Map(tasks.map((t) => [t.id, t])),
  );
  const linksStore = mockStore<ReadonlyMap<LinkId, Readonly<Link>>>(
    new Map(links.map((l) => [l.id, l])),
  );
  const data = {
    getTask: (id: TaskId) => slice.getTask(id),
    query: () => slice.query(),
    tasks: tasksStore,
    links: linksStore,
  } as unknown as DataService;
  const setLinks = (next: readonly Link[]): void => {
    slice = stubData(tasks, next);
    linksStore.set(new Map(next.map((l) => [l.id, l])));
    tasksStore.set(new Map(tasks.map((t) => [t.id, t])));
  };

  const view = viewDouble(fullViewport());
  const boxMap = boxes();
  const bars = barsDouble(boxMap, options.ownBars ?? boxMap.keys());
  const selection = mockStore<SelectionState>({ taskIds: new Set<TaskId>() });
  const focus = focusDouble("t0");

  const table = serviceTable({
    data,
    view,
    bars,
    rows: options.withoutRows === true ? undefined : stubRows(IDS, ROW_HEIGHT),
    selection: options.withoutSelection === true ? undefined : selection,
    focus: options.withoutFocus === true ? undefined : focus,
    tokens: options.tokens ?? {},
  });
  const rec = recordingContext(table);

  const deps: SchedulingAreaDeps = {
    ctx: rec.ctx,
    config: resolveConfig({ dependencies: options.dependencies ?? {} }),
    messages: resolveMessages(undefined, () => undefined),
    data,
    scheduler: {} as SchedulingAreaDeps["scheduler"],
    calendars: {} as SchedulingAreaDeps["calendars"],
    reportError: () => undefined,
  };
  wireLinks(deps);
  // §14 (P4 review ruling) — every optional chart service is resolved at `lifecycle/ready` or per
  // use, never latched at setup; this harness's `services` table already has everything the test
  // configured (view/bars/rows/selection/focus per `WireOptions`), so firing the event once here,
  // exactly as the real core does after every plugin's `setup()` has run, brings the area's
  // lifecycle-deferred subscriptions (§5.4/§5.5 selection wiring, §5.8 rows/timeline repaint) up
  // to the same state a real host reaches once at boot.
  rec.fire("lifecycle/ready", undefined);

  const layers = rec.contributedTo<LayerContribution>("renderer/layers");
  const keys = (): KeyBinding[] => rec.contributedTo<KeyBinding>("keys/bindings");

  return {
    rec,
    view,
    tasks: tasksStore,
    selection,
    focus,
    bars,
    setLinks,
    paint(layerId: string): RecordingCanvas {
      const layer = layers.find((l) => l.id === layerId);
      expect(layer).toBeDefined();
      const canvas = recordingCanvas();
      layer!.draw(canvas.g, view.viewport.get());
      return canvas;
    },
    bindings: (key: string) => keys().filter((b) => b.key === key),
    binding(key: string, index = 0): KeyBinding {
      const found = keys().filter((b) => b.key === key)[index];
      expect(found).toBeDefined();
      return found!;
    },
    hit: rec.contributedTo<HitTester>("renderer/hitTest")[0]!,
  };
}

const LINE_LAYER = "stargantt.scheduling:links";
const PORT_LAYER = "stargantt.scheduling:ports";

/* ------------------------------------------------------------------ *
 * Layers, order claims, gutter (§5.1 / §5)
 * ------------------------------------------------------------------ */

describe("layer claims and contributions", () => {
  it("claims 69 for the lines and 110 for the ports, and contributes both layers", () => {
    const h = wire();
    expect(h.rec.orders).toEqual([
      { scope: "renderer/layers", key: LINE_LAYER, order: 69 },
      { scope: "renderer/layers", key: PORT_LAYER, order: 110 },
    ]);
    const layers = h.rec.contributedTo<LayerContribution>("renderer/layers");
    expect(layers.map((l) => [l.id, l.zIndex])).toEqual([
      [LINE_LAYER, 69],
      [PORT_LAYER, 110],
    ]);
  });

  it("keeps both layer claims registered even with link creation and lines off", () => {
    const h = wire({ dependencies: { allowLinkCreate: false, showLinks: false } });
    expect(h.rec.orders.map((o) => o.order)).toEqual([69, 110]);
    expect(h.rec.contributedTo<LayerContribution>("renderer/layers")).toHaveLength(2);
  });
});

describe("the taskbars/endGutter reservation (§5.1)", () => {
  it("reserves the 17 px port clearance at both ends while link creation is on", () => {
    const h = wire();
    const gutter = h.rec.contributedTo<EndGutterContribution>("taskbars/endGutter")[0]!;
    expect(gutter.end).toBe("both");
    expect(gutter.size).toBe(PORT_CLEARANCE);
    expect(gutter.size).toBe(17);
    expect(gutter.active()).toBe(true);
  });

  it("goes inactive with allowLinkCreate: false", () => {
    const h = wire({ dependencies: { allowLinkCreate: false } });
    const gutter = h.rec.contributedTo<EndGutterContribution>("taskbars/endGutter")[0]!;
    expect(gutter.active()).toBe(false);
  });
});

/* ------------------------------------------------------------------ *
 * Hit test (§5.1 / §5.3 / §5.4)
 * ------------------------------------------------------------------ */

describe("the renderer/hitTest contribution", () => {
  const link = stubLink("l0", "t0", "t1", "FS");
  const portOfT0 = portCentre(rect(0, 5), "end");

  it("answers a port hit with the task id and the crosshair cursor", () => {
    const h = wire({ links: [link] });
    expect(h.hit(portOfT0.x, portOfT0.y)).toEqual({
      kind: "port",
      id: "t0",
      cursor: "crosshair",
    });
  });

  it("answers anywhere inside the 24 px port target", () => {
    const h = wire({ links: [link] });
    expect(h.hit(portOfT0.x, portOfT0.y - 11)?.kind).toBe("port");
    expect(h.hit(portOfT0.x, portOfT0.y - 13)?.kind).not.toBe("port");
  });

  it("answers a link hit with the link id and the default cursor", () => {
    const h = wire({ links: [link] });
    expect(h.hit(150, 15)).toEqual({ kind: "link", id: "l0", cursor: "default" });
  });

  it("reports the pointer cursor for a link hit under linkEditing (§5.4)", () => {
    const h = wire({ links: [link], dependencies: { linkEditing: true } });
    expect(h.hit(150, 15)?.cursor).toBe("pointer");
  });

  it("answers no link hit with showLinks: false, while ports still answer (§5.3)", () => {
    const h = wire({ links: [link], dependencies: { showLinks: false } });
    expect(h.hit(150, 15)).toBeUndefined();
    expect(h.hit(portOfT0.x, portOfT0.y)?.kind).toBe("port");
  });

  it("answers no port hit with allowLinkCreate: false, while lines still answer (§5.1)", () => {
    const h = wire({ links: [link], dependencies: { allowLinkCreate: false } });
    // The start port of `t0` sits left of the bar, clear of the route, so nothing else can answer
    // for it: with link creation off the point lands on nothing at all.
    const startPort = portCentre(rect(0, 5), "start");
    expect(h.hit(startPort.x, startPort.y)).toBeUndefined();
    // With ports on, the same point is the port.
    expect(wire({ links: [link] }).hit(startPort.x, startPort.y)?.kind).toBe("port");
    // The line itself still answers, now routed from the bar edges (no inset).
    expect(h.hit(150, 15)?.kind).toBe("link");
  });

  it("answers nothing over empty space", () => {
    const h = wire({ links: [link] });
    expect(h.hit(600, 200)).toBeUndefined();
  });
});

/* ------------------------------------------------------------------ *
 * The port pass (§5.1) and its tokens (§5.3)
 * ------------------------------------------------------------------ */

describe("the port pass", () => {
  it("paints both ports of every visible own-bar row, in the fallback colour", () => {
    const canvas = wire().paint(PORT_LAYER);
    const discs = canvas.of("arc").filter((c) => c.args[2] === PORT_RADIUS);
    expect(discs).toHaveLength(IDS.length * 2);
    expect(new Set(canvas.fills)).toEqual(new Set(["#78716c"]));
  });

  it("uses the --sg-link-port token when the theme resolves one", () => {
    const canvas = wire({ tokens: { "--sg-link-port": "#123456" } }).paint(PORT_LAYER);
    expect(new Set(canvas.fills)).toEqual(new Set(["#123456"]));
  });

  it("paints no port for a row whose task has no bar of its own (a collapsed summary)", () => {
    const canvas = wire({ ownBars: ["t0", "t2"] }).paint(PORT_LAYER);
    expect(canvas.of("arc")).toHaveLength(4);
  });

  it("paints nothing at all with allowLinkCreate: false", () => {
    const canvas = wire({ dependencies: { allowLinkCreate: false } }).paint(PORT_LAYER);
    expect(canvas.calls).toEqual([]);
  });

  it("paints nothing without the optional row model (§14)", () => {
    const canvas = wire({ withoutRows: true }).paint(PORT_LAYER);
    expect(canvas.calls).toEqual([]);
  });
});

/* ------------------------------------------------------------------ *
 * The line pass (§5.3 / §5.5)
 * ------------------------------------------------------------------ */

describe("the line pass", () => {
  const link = stubLink("l0", "t0", "t1", "FS");

  it("strokes one line per visible link, in the fallback colour", () => {
    const canvas = wire({ links: [link] }).paint(LINE_LAYER);
    expect(canvas.of("stroke")).toHaveLength(1);
    expect(canvas.strokes).toEqual(["#78716c"]);
  });

  it("paints nothing with showLinks: false", () => {
    const canvas = wire({ links: [link], dependencies: { showLinks: false } }).paint(LINE_LAYER);
    expect(canvas.calls).toEqual([]);
  });

  it("uses the per-type colour over the shared token", () => {
    const canvas = wire({
      links: [link],
      dependencies: { typeColors: { FS: "#ff0000" } },
      tokens: { "--sg-link-line": "#111111" },
    }).paint(LINE_LAYER);
    expect(canvas.strokes).toEqual(["#ff0000"]);
  });

  it("draws a conflicting link dashed in the conflict colour (§5.5)", () => {
    const early = [
      stubTask("t0", { start: 0, end: 10 }),
      stubTask("t1", { start: 5, end: 10 }),
      stubTask("t2"),
    ];
    const canvas = wire({
      tasks: early,
      links: [link],
      dependencies: { highlightConflicts: true },
    }).paint(LINE_LAYER);
    expect(canvas.strokes).toEqual(["#dc2626"]);
    expect(canvas.of("setLineDash")[0]?.args[0]).toEqual([4, 3]);
  });

  it("draws a driving link thicker in the driving colour (§5.5)", () => {
    const onTime = [
      stubTask("t0", { start: 0, end: 10 }),
      stubTask("t1", { start: 10, end: 20 }),
      stubTask("t2"),
    ];
    const canvas = wire({
      tasks: onTime,
      links: [link],
      dependencies: { highlightDriving: true },
    }).paint(LINE_LAYER);
    expect(canvas.strokes).toEqual(["#44403c"]);
    expect(canvas.widths[0]).toBe(1.5 + 1.5);
  });

  it("culls a line outside the horizontal window only when cullLines is on (§5.3)", () => {
    const scrolled = wire({ links: [link], dependencies: { cullLines: true } });
    scrolled.view.viewport.set(fullViewport({ scrollLeft: 5000, width: 400 }));
    expect(scrolled.paint(LINE_LAYER).of("stroke")).toHaveLength(0);
    const uncull = wire({ links: [link] });
    uncull.view.viewport.set(fullViewport({ scrollLeft: 5000, width: 400 }));
    expect(uncull.paint(LINE_LAYER).of("stroke")).toHaveLength(1);
  });
});

describe("path emphasis and the 0.35 dim (§5.5)", () => {
  const links = [stubLink("l0", "t0", "t1", "FS"), stubLink("l1", "t1", "t2", "FS")];

  it("dims nothing while nothing is emphasized", () => {
    const h = wire({ links, dependencies: { highlightPaths: true } });
    const canvas = h.paint(LINE_LAYER);
    expect(canvas.alphas).toEqual([]);
    expect(canvas.of("stroke")).toHaveLength(2);
  });

  it("emphasizes the hovered line and dims the rest at 0.35", () => {
    const h = wire({ links, dependencies: { highlightPaths: true } });
    h.rec.fire("pointer/barHover", { hit: { kind: "link", id: "l0", cursor: "default" }, x: 0, y: 0 });
    expect(h.view.invalidated).toContain("main");
    const canvas = h.paint(LINE_LAYER);
    expect(canvas.alphas).toEqual([DIM_ALPHA]);
    expect(canvas.of("save")).toHaveLength(1);
    expect(canvas.of("restore")).toHaveLength(1);
    // The emphasized line is drawn last, at full opacity, in the emphasis colour.
    expect(canvas.strokes).toEqual(["#78716c", "#1d4ed8"]);
  });

  it("does not repaint when the hover did not change", () => {
    const h = wire({ links, dependencies: { highlightPaths: true } });
    h.rec.fire("pointer/barHover", { hit: { kind: "link", id: "l0", cursor: "default" }, x: 0, y: 0 });
    const before = h.view.invalidated.length;
    h.rec.fire("pointer/barHover", { hit: { kind: "link", id: "l0", cursor: "default" }, x: 0, y: 0 });
    expect(h.view.invalidated).toHaveLength(before);
  });

  it("emphasizes the whole dependency path of the task selection", () => {
    const h = wire({ links, dependencies: { highlightPaths: true } });
    h.selection.set({ taskIds: new Set<TaskId>(["t0"]) });
    const canvas = h.paint(LINE_LAYER);
    // Both links are on `t0`'s downstream path, so nothing is left to dim.
    expect(canvas.strokes).toEqual(["#1d4ed8", "#1d4ed8"]);
  });

  it("never dims a conflicting link", () => {
    const clash = [
      stubTask("t0", { start: 0, end: 10 }),
      stubTask("t1", { start: 5, end: 10 }),
      stubTask("t2", { start: 20, end: 30 }),
    ];
    const h = wire({
      tasks: clash,
      links,
      dependencies: { highlightPaths: true, highlightConflicts: true },
    });
    h.rec.fire("pointer/barHover", { hit: { kind: "link", id: "l1", cursor: "default" }, x: 0, y: 0 });
    const canvas = h.paint(LINE_LAYER);
    // `l0` conflicts and keeps full opacity; only `l1` is emphasized.
    expect(canvas.strokes).toEqual(["#dc2626", "#1d4ed8"]);
    expect(canvas.alphas).toEqual([DIM_ALPHA]);
  });

  it("drops the hover on a data change and recomputes the path from the live selection", () => {
    const h = wire({ links, dependencies: { highlightPaths: true } });
    h.rec.fire("pointer/barHover", { hit: { kind: "link", id: "l0", cursor: "default" }, x: 0, y: 0 });
    h.tasks.set(new Map());
    const canvas = h.paint(LINE_LAYER);
    expect(canvas.alphas).toEqual([]);
    expect(canvas.strokes).toEqual(["#78716c", "#78716c"]);
  });
});

/* ------------------------------------------------------------------ *
 * The port drag (§5.2 / §4.3 / §5.5)
 * ------------------------------------------------------------------ */

/** Presses the connector port at one end of `t0`'s bar. */
function pressPort(h: Harness): void {
  const c = portCentre(rect(0, 5), "end");
  h.rec.fire("pointer/barDown", {
    hit: { kind: "port", id: "t0", cursor: "crosshair" },
    ...pointerEvent(c.x, c.y),
  });
}

describe("port-drag link creation (§5.2)", () => {
  it("creates the link the release names, with the type derived from the two ends", () => {
    const h = wire();
    pressPort(h);
    h.rec.fire("pointer/barMove", { ...pointerEvent(150, 30) });
    h.rec.fire("pointer/barUp", { ...pointerEvent(210, 45, { type: "pointerup" }) });
    expect(h.rec.dispatched).toEqual([
      { key: "link/add", payload: { sourceId: "t0", targetId: "t1", type: "FS" } },
    ]);
  });

  it("fills the configured defaultLag on the pointer path", () => {
    const h = wire({ dependencies: { defaultLag: 3600_000 } });
    pressPort(h);
    h.rec.fire("pointer/barUp", { ...pointerEvent(210, 45, { type: "pointerup" }) });
    expect(h.rec.dispatched[0]?.payload).toEqual({
      sourceId: "t0",
      targetId: "t1",
      type: "FS",
      lag: 3600_000,
    });
  });

  it("repaints the overlay on press, move and release", () => {
    const h = wire();
    pressPort(h);
    expect(h.view.invalidated).toEqual(["overlay"]);
    h.rec.fire("pointer/barMove", { ...pointerEvent(150, 30) });
    h.rec.fire("pointer/barUp", { ...pointerEvent(210, 45, { type: "pointerup" }) });
    expect(h.view.invalidated.filter((l) => l === "overlay").length).toBeGreaterThanOrEqual(3);
  });

  it("abandons the drag on a pointercancel release, dispatching nothing (§4.3)", () => {
    const h = wire();
    pressPort(h);
    h.rec.fire("pointer/barUp", { ...pointerEvent(210, 45, { type: "pointercancel" }) });
    expect(h.rec.dispatched).toEqual([]);
  });

  it("ignores a release from a pointer that did not start the drag (§4.3)", () => {
    const h = wire();
    pressPort(h);
    h.rec.fire("pointer/barUp", { ...pointerEvent(210, 45, { type: "pointerup", pointerId: 9 }) });
    expect(h.rec.dispatched).toEqual([]);
  });

  it("creates nothing when the release lands back on the drag's own bar", () => {
    const h = wire();
    pressPort(h);
    h.rec.fire("pointer/barUp", { ...pointerEvent(50, 15, { type: "pointerup" }) });
    expect(h.rec.dispatched).toEqual([]);
  });

  it("creates nothing over a task the source already links to", () => {
    const h = wire({ links: [stubLink("l0", "t0", "t1", "FS")] });
    pressPort(h);
    h.rec.fire("pointer/barUp", { ...pointerEvent(210, 45, { type: "pointerup" }) });
    expect(h.rec.dispatched).toEqual([]);
  });

  it("starts no drag at all with allowLinkCreate: false", () => {
    const h = wire({ dependencies: { allowLinkCreate: false } });
    expect(h.rec.handlers.get("pointer/barDown")).toBeUndefined();
    expect(h.rec.dispatched).toEqual([]);
  });

  it("draws the rubber band while a drag is in flight", () => {
    const h = wire({ tokens: { "--sg-link-band": "#00aaaa" } });
    pressPort(h);
    h.rec.fire("pointer/barMove", { ...pointerEvent(150, 30) });
    const canvas = h.paint(PORT_LAYER);
    expect(canvas.strokes).toEqual(["#00aaaa"]);
    expect(canvas.of("lineTo").some((c) => c.args[0] === 150 && c.args[1] === 30)).toBe(true);
  });

  it("rings the drop candidate only when the release would be accepted (§5.5)", () => {
    const h = wire({ dependencies: { highlightDropTargets: true } });
    pressPort(h);
    h.rec.fire("pointer/barMove", { ...pointerEvent(210, 45) });
    const ringed = h.paint(PORT_LAYER);
    expect(ringed.of("arc").some((c) => c.args[2] === PORT_RING_RADIUS)).toBe(true);

    // Over the source's own bar, no ring: the drop would be refused.
    const own = wire({ dependencies: { highlightDropTargets: true } });
    pressPort(own);
    own.rec.fire("pointer/barMove", { ...pointerEvent(50, 15) });
    expect(own.paint(PORT_LAYER).of("arc").some((c) => c.args[2] === PORT_RING_RADIUS)).toBe(false);
  });

  it("draws no ring while highlightDropTargets is off", () => {
    const h = wire();
    pressPort(h);
    h.rec.fire("pointer/barMove", { ...pointerEvent(210, 45) });
    expect(h.paint(PORT_LAYER).of("arc").some((c) => c.args[2] === PORT_RING_RADIUS)).toBe(false);
  });

  it("Escape abandons an in-flight drag and dispatches nothing", () => {
    const h = wire();
    const escape = h.bindings("Escape");
    expect(escape).toHaveLength(1);
    expect(escape[0]!.when?.()).toBe(false);
    pressPort(h);
    expect(escape[0]!.when?.()).toBe(true);
    escape[0]!.run();
    expect(escape[0]!.when?.()).toBe(false);
    h.rec.fire("pointer/barUp", { ...pointerEvent(210, 45, { type: "pointerup" }) });
    expect(h.rec.dispatched).toEqual([]);
  });
});

/* ------------------------------------------------------------------ *
 * Keyboard link creation (§5.6)
 * ------------------------------------------------------------------ */

describe("the Alt+L chord (§5.6)", () => {
  it("marks on the first press and creates on the second, announcing both", () => {
    const h = wire();
    const chord = h.binding("Alt+L");
    chord.run();
    expect(h.rec.dispatched).toEqual([]);
    expect(h.focus.announced).toEqual(["t0 marked as link source"]);
    h.focus.state.set({ focused: "t1" });
    chord.run();
    expect(h.rec.dispatched).toEqual([
      { key: "link/add", payload: { sourceId: "t0", targetId: "t1", type: "FS" } },
    ]);
    expect(h.focus.announced[1]).toBe("Linked t0 to t1");
  });

  it("uses defaultLinkType and defaultLag, which the pointer path never consults", () => {
    const h = wire({ dependencies: { defaultLinkType: "SS", defaultLag: 5 } });
    const chord = h.binding("Alt+L");
    chord.run();
    h.focus.state.set({ focused: "t1" });
    chord.run();
    expect(h.rec.dispatched[0]?.payload).toEqual({
      sourceId: "t0",
      targetId: "t1",
      type: "SS",
      lag: 5,
    });
  });

  it("cancels when the second press lands on the same task", () => {
    const h = wire();
    const chord = h.binding("Alt+L");
    chord.run();
    chord.run();
    expect(h.rec.dispatched).toEqual([]);
    expect(h.focus.announced[1]).toBe("Link creation cancelled");
  });

  it("refuses and announces a pair that is already linked", () => {
    const h = wire({ links: [stubLink("l0", "t0", "t1", "FS")] });
    const chord = h.binding("Alt+L");
    chord.run();
    h.focus.state.set({ focused: "t1" });
    chord.run();
    expect(h.rec.dispatched).toEqual([]);
    expect(h.focus.announced[1]).toBe("t0 is already linked to t1");
  });

  it("clears the pending source silently on a data change", () => {
    const h = wire();
    const chord = h.binding("Alt+L");
    chord.run();
    h.tasks.set(new Map());
    h.focus.state.set({ focused: "t1" });
    chord.run();
    // The second press marks again instead of creating.
    expect(h.rec.dispatched).toEqual([]);
    expect(h.focus.announced[1]).toBe("t1 marked as link source");
  });

  it("does nothing without the optional focus service (§14)", () => {
    const h = wire({ withoutFocus: true });
    expect(() => {
      h.binding("Alt+L").run();
    }).not.toThrow();
    expect(h.rec.dispatched).toEqual([]);
  });

  it("contributes no chord at all with allowLinkCreate: false", () => {
    const h = wire({ dependencies: { allowLinkCreate: false } });
    expect(h.bindings("Alt+L")).toEqual([]);
    expect(h.bindings("Escape")).toEqual([]);
  });
});

/* ------------------------------------------------------------------ *
 * Link selection and deletion (§5.4)
 * ------------------------------------------------------------------ */

describe("link selection and deletion (§5.4)", () => {
  const links = [stubLink("l0", "t0", "t1", "FS")];
  const editing: DependenciesConfig = { linkEditing: true };

  it("contributes no Delete/Backspace binding while linkEditing is off", () => {
    const h = wire({ links });
    expect(h.bindings("Delete")).toEqual([]);
    expect(h.bindings("Backspace")).toEqual([]);
  });

  it("selects the pressed link and paints it in the band colour, 1.5 px thicker", () => {
    const h = wire({ links, dependencies: editing });
    h.rec.fire("pointer/barDown", {
      hit: { kind: "link", id: "l0", cursor: "pointer" },
      ...pointerEvent(150, 15),
    });
    const canvas = h.paint(LINE_LAYER);
    expect(canvas.strokes).toEqual(["#0f766e"]);
    expect(canvas.widths).toEqual([1.5 + 1.5]);
  });

  it("removes the selected link with one link/remove and announces it", () => {
    const h = wire({ links, dependencies: editing });
    const del = h.binding("Delete");
    expect(del.when?.()).toBe(false);
    h.rec.fire("pointer/barDown", {
      hit: { kind: "link", id: "l0", cursor: "pointer" },
      ...pointerEvent(150, 15),
    });
    expect(del.when?.()).toBe(true);
    del.run();
    expect(h.rec.dispatched).toEqual([{ key: "link/remove", payload: { ids: ["l0"] } }]);
    expect(h.focus.announced).toEqual(["Link removed"]);
    expect(del.when?.()).toBe(false);
  });

  it("Backspace removes it too", () => {
    const h = wire({ links, dependencies: editing });
    h.rec.fire("pointer/barDown", {
      hit: { kind: "link", id: "l0", cursor: "pointer" },
      ...pointerEvent(150, 15),
    });
    h.binding("Backspace").run();
    expect(h.rec.dispatched).toEqual([{ key: "link/remove", payload: { ids: ["l0"] } }]);
  });

  it("deselects on a press elsewhere, on a background press and on Escape", () => {
    const h = wire({ links, dependencies: editing });
    const select = (): void => {
      h.rec.fire("pointer/barDown", {
        hit: { kind: "link", id: "l0", cursor: "pointer" },
        ...pointerEvent(150, 15),
      });
    };
    const del = h.binding("Delete");

    select();
    h.rec.fire("pointer/barDown", {
      hit: { kind: "bar", id: "t1", cursor: "default" },
      ...pointerEvent(250, 45),
    });
    expect(del.when?.()).toBe(false);

    select();
    h.rec.fire("pointer/background", { ...pointerEvent(600, 200) });
    expect(del.when?.()).toBe(false);

    select();
    // The link-selection Escape is the second contribution: the drag's own is registered first.
    const escapes = h.bindings("Escape");
    const linkEscape = escapes.find((b) => b.when?.() === true)!;
    linkEscape.run();
    expect(del.when?.()).toBe(false);
  });

  it("is disarmed by a non-empty task selection, but not by an empty one", () => {
    const h = wire({ links, dependencies: editing });
    const del = h.binding("Delete");
    h.rec.fire("pointer/barDown", {
      hit: { kind: "link", id: "l0", cursor: "pointer" },
      ...pointerEvent(150, 15),
    });
    h.selection.set({ taskIds: new Set<TaskId>() });
    expect(del.when?.()).toBe(true);
    h.selection.set({ taskIds: new Set<TaskId>(["t1"]) });
    expect(del.when?.()).toBe(false);
  });

  it("keeps the selection across a data change that still holds the link", () => {
    const h = wire({ links, dependencies: editing });
    const del = h.binding("Delete");
    h.rec.fire("pointer/barDown", {
      hit: { kind: "link", id: "l0", cursor: "pointer" },
      ...pointerEvent(150, 15),
    });
    h.setLinks(links);
    expect(del.when?.()).toBe(true);
  });

  it("drops a selection whose link the store no longer holds", () => {
    const h = wire({ links, dependencies: editing });
    const del = h.binding("Delete");
    h.rec.fire("pointer/barDown", {
      hit: { kind: "link", id: "l0", cursor: "pointer" },
      ...pointerEvent(150, 15),
    });
    expect(del.when?.()).toBe(true);
    h.setLinks([]);
    expect(del.when?.()).toBe(false);
  });
});

/* ------------------------------------------------------------------ *
 * Inspector (§5.7) and repaint wiring (§5.8)
 * ------------------------------------------------------------------ */

describe("the dependency inspector contribution (§5.7)", () => {
  it("is absent by default", () => {
    const h = wire();
    expect(h.rec.contributedTo<SidePanelFieldContribution>("sidepanel/fields")).toEqual([]);
  });

  it("contributes one identified section with a mount function", () => {
    const h = wire({ dependencies: { inspector: true } });
    const sections = h.rec.contributedTo<SidePanelFieldContribution>("sidepanel/fields");
    expect(sections).toHaveLength(1);
    expect(sections[0]!.id).toBe("stargantt.scheduling.links");
    expect(typeof sections[0]!.mount).toBe("function");
  });
});

describe("repaint wiring (§5.8)", () => {
  it("invalidates both layers on a data change", () => {
    const h = wire({ links: [stubLink("l0", "t0", "t1", "FS")] });
    h.view.invalidated.length = 0;
    h.tasks.set(new Map());
    expect(new Set(h.view.invalidated)).toEqual(new Set(["main", "overlay"]));
  });

  it("owns every subscription it registers, and releasing them stops the repaints", () => {
    const h = wire();
    expect(h.rec.owned.length).toBeGreaterThan(0);
    h.rec.disposeAll();
    h.view.invalidated.length = 0;
    h.tasks.set(new Map());
    expect(h.view.invalidated).toEqual([]);
  });
});
