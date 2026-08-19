/**
 * Shared test harness for `internal/capture/`: a trimmed fake-DOM + fake-canvas double, and a
 * `boot()` helper that boots the real `stargantt.export` plugin through `@stargantt/sdk`'s
 * `createTestHost` with mock `stargantt.data` / `stargantt.view` / `stargantt.timeline` /
 * `stargantt.theme` services.
 *
 * There is no shared test-doubles package (the `packages/plugins/view/test/_utils` /
 * `packages/sdk/test/_dom.ts` precedent: each package keeps its own trimmed copy). Only the
 * recording surface `internal/capture/` and `service.test.ts` actually exercise is included here —
 * no event doubles, no observers, nothing interaction-related, since this plugin paints through
 * `ViewService.renderTo` and never touches the DOM itself.
 *
 * This file belongs to `test/capture/` only; `test/print/` (owned by a different work area) keeps
 * its own copy.
 */
import { definePlugin } from "@stargantt/core";
import type { AnyPlugin } from "@stargantt/core";
import { createTestHost, mockStore } from "@stargantt/sdk";
import type { Viewport } from "@stargantt/plugin-view";
import { exportPlugin } from "../../src/index";
import type { ExportConfig, ExportService } from "../../src/index";

/* ------------------------------------------------------------------ *
 * Fake DOM: elements, canvases, recording 2d context
 * ------------------------------------------------------------------ */

export interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** One recorded 2d-context call: the method, its numeric arguments and the fill style in force. */
export interface Op {
  op: string;
  args: number[];
  fill: string;
}

/** One recorded `drawImage` call, with the destination box normalized across argument forms. */
export interface DrawnImage {
  src: unknown;
  args: number[];
  dx: number;
  dy: number;
  dw: number;
  dh: number;
}

/** A recording 2d context: nothing is rasterized, every call is logged with the state in force. */
export class FakeContext2D {
  fillStyle = "";
  strokeStyle = "";
  font = "";
  textAlign = "";
  textBaseline = "";
  lineWidth = 1;
  globalAlpha = 1;

  /** `[a, b, c, d, e, f]`, as `setTransform` takes them. */
  transform: [number, number, number, number, number, number] = [1, 0, 0, 1, 0, 0];
  private stack: (typeof this.transform)[] = [];

  readonly ops: Op[] = [];
  readonly drawn: DrawnImage[] = [];

  /** Horizontal scale factor of the current transform — what `g.scale(ratio, ratio)` leaves behind. */
  get scaleX(): number {
    return this.transform[0];
  }
  /** Horizontal translation of the current transform, in device px — what `g.translate(x, 0)` leaves. */
  get tx(): number {
    return this.transform[4];
  }

  private record(op: string, ...args: number[]): void {
    this.ops.push({ op, args, fill: String(this.fillStyle) });
  }

  save(): void {
    this.stack.push([...this.transform] as typeof this.transform);
    this.record("save");
  }
  restore(): void {
    const t = this.stack.pop();
    if (t !== undefined) this.transform = t;
    this.record("restore");
  }
  setTransform(a: number, b: number, c: number, d: number, e: number, f: number): void {
    this.transform = [a, b, c, d, e, f];
    this.record("setTransform", a, b, c, d, e, f);
  }
  scale(x: number, y: number): void {
    const [a, b, c, d, e, f] = this.transform;
    this.transform = [a * x, b * x, c * y, d * y, e, f];
    this.record("scale", x, y);
  }
  translate(x: number, y: number): void {
    const [a, b, c, d, e, f] = this.transform;
    this.transform = [a, b, c, d, e + a * x + c * y, f + b * x + d * y];
    this.record("translate", x, y);
  }

  clearRect(x: number, y: number, w: number, h: number): void {
    this.record("clearRect", x, y, w, h);
  }
  fillRect(x: number, y: number, w: number, h: number): void {
    this.record("fillRect", x, y, w, h);
  }
  strokeRect(x: number, y: number, w: number, h: number): void {
    this.record("strokeRect", x, y, w, h);
  }
  beginPath(): void {
    this.record("beginPath");
  }
  moveTo(x: number, y: number): void {
    this.record("moveTo", x, y);
  }
  lineTo(x: number, y: number): void {
    this.record("lineTo", x, y);
  }
  fill(): void {
    this.record("fill");
  }
  stroke(): void {
    this.record("stroke");
  }
  clip(): void {
    this.record("clip");
  }
  fillText(text: string, x: number, y: number): void {
    this.record("fillText", x, y);
  }
  measureText(text: string): { width: number } {
    return { width: text.length * 6 };
  }
  setLineDash(_segments: number[]): void {
    this.record("setLineDash");
  }
  getLineDash(): number[] {
    return [];
  }
  drawImage(src: unknown, ...args: number[]): void {
    const short = args.length <= 4;
    this.drawn.push({
      src,
      args,
      dx: (short ? args[0] : args[4]) ?? 0,
      dy: (short ? args[1] : args[5]) ?? 0,
      dw: (short ? args[2] : args[6]) ?? 0,
      dh: (short ? args[3] : args[7]) ?? 0,
    });
    this.record("drawImage", ...args);
  }
  getImageData(_x: number, _y: number, w: number, h: number): ImageData {
    return { data: new Uint8ClampedArray(w * h * 4).fill(255), width: w, height: h, colorSpace: "srgb" } as ImageData;
  }

  /* --- test helpers --- */

  calls(op: string): Op[] {
    return this.ops.filter((o) => o.op === op);
  }
  opNames(): string[] {
    return this.ops.map((o) => o.op);
  }
}

/** Knobs for the canvases a `FakeDocument` hands out. */
export interface CanvasOptions {
  /** `false` removes `toBlob`, exercising the `toDataURL` fallback path. */
  toBlob?: boolean;
  /** `null` makes `toBlob` report an encoding failure. */
  blob?: Blob | null;
  dataUrl?: string;
  /** `null` makes `getContext("2d")` fail. */
  context?: FakeContext2D | null;
}

export class FakeElement {
  children: FakeElement[] = [];
  parentNode: FakeElement | null = null;
  readonly attributes = new Map<string, string>();
  rect: Rect = { left: 0, top: 0, width: 0, height: 0 };

  constructor(
    readonly tagName: string,
    readonly ownerDocument: FakeDocument,
  ) {}

  get clientWidth(): number {
    return this.rect.width;
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, String(value));
  }
  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  appendChild<T extends FakeElement>(child: T): T {
    child.parentNode?.children.splice(child.parentNode.children.indexOf(child), 1);
    child.parentNode = this;
    this.children.push(child);
    return child;
  }

  getBoundingClientRect(): Rect & { right: number; bottom: number } {
    const { left, top, width, height } = this.rect;
    return { left, top, width, height, right: left + width, bottom: top + height };
  }

  /**
   * `querySelectorAll("canvas[data-layer]")` — the one selector shape `layerCanvases` (§1.1) needs.
   * No general CSS selector support: a broader query is not something this package's tests need.
   */
  querySelectorAll(selector: string): FakeElement[] {
    const m = /^([a-zA-Z][\w-]*)?\[([\w-]+)\]$/.exec(selector.trim());
    if (m === null) throw new Error(`unsupported fake selector: ${selector}`);
    const tag = m[1]?.toUpperCase();
    const attr = m[2] as string;
    const out: FakeElement[] = [];
    const walk = (el: FakeElement): void => {
      for (const child of el.children) {
        if ((tag === undefined || child.tagName === tag) && child.attributes.has(attr)) out.push(child);
        walk(child);
      }
    };
    walk(this);
    return out;
  }
}

export class FakeCanvas extends FakeElement {
  width = 0;
  height = 0;
  context: FakeContext2D | null = new FakeContext2D();
  dataUrl = "data:image/png;base64,AAAA";
  blob: Blob | null = new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" });
  readonly toDataURLTypes: (string | undefined)[] = [];
  readonly toBlobTypes: (string | undefined)[] = [];
  /** The `quality` argument of every `toBlob` call, in order (`undefined` when omitted). */
  readonly toBlobQualities: (number | undefined)[] = [];
  toBlob: ((cb: (b: Blob | null) => void, type?: string, quality?: number) => void) | undefined;

  constructor(tagName: string, ownerDocument: FakeDocument) {
    super(tagName, ownerDocument);
    this.toBlob = (cb, type, quality): void => {
      this.toBlobTypes.push(type);
      this.toBlobQualities.push(quality);
      queueMicrotask(() => cb(this.blob));
    };
  }

  getContext(id: string): FakeContext2D | null {
    return id === "2d" ? this.context : null;
  }
  toDataURL(type?: string): string {
    this.toDataURLTypes.push(type);
    return this.dataUrl;
  }
}

export class FakeDocument {
  defaultRect: Rect = { left: 0, top: 0, width: 0, height: 0 };
  canvasOptions: CanvasOptions = {};
  /** `undefined` by default, matching a headless environment with no window/`URL`. */
  defaultView: unknown;

  readonly created: FakeElement[] = [];

  createElement(tag: string): FakeElement {
    const el = tag === "canvas" ? this.createCanvas() : new FakeElement(tag.toUpperCase(), this);
    el.rect = { ...this.defaultRect };
    this.created.push(el);
    return el;
  }

  createdCanvases(): FakeCanvas[] {
    return this.created.filter((el): el is FakeCanvas => el instanceof FakeCanvas);
  }

  private createCanvas(): FakeCanvas {
    const c = new FakeCanvas("CANVAS", this);
    const o = this.canvasOptions;
    if (o.toBlob === false) c.toBlob = undefined;
    if (o.blob !== undefined) c.blob = o.blob;
    if (o.dataUrl !== undefined) c.dataUrl = o.dataUrl;
    if (o.context !== undefined) c.context = o.context;
    return c;
  }
}

/* --- casts --- */

export function asElement(el: FakeElement): HTMLElement {
  return el as unknown as HTMLElement;
}
export function asCanvas(el: FakeElement): HTMLCanvasElement {
  return el as unknown as HTMLCanvasElement;
}
export function asDocument(doc: FakeDocument): Document {
  return doc as unknown as Document;
}
export function asContext(g: FakeContext2D): CanvasRenderingContext2D {
  return g as unknown as CanvasRenderingContext2D;
}

/* ------------------------------------------------------------------ *
 * `makeRoot` / `fills` — shared by capture.test.ts and compose.test.ts
 * ------------------------------------------------------------------ */

/**
 * A root with the view plugin's layer canvases already attached, as a real chart pane carries them.
 */
export function makeRoot(
  doc: FakeDocument,
  layers: readonly { layer: string; width: number; height: number }[],
  // The layer's own on-screen CSS width (`getBoundingClientRect().width`), which is what
  // `recoverRatio` derives the export ratio from. Defaults to the backing-store width, i.e. an
  // un-scaled (1x) layer, when the caller has no narrower/DPR-scaled pane to model.
  cssWidth?: (l: { layer: string; width: number; height: number }) => number,
): FakeElement {
  const root = new FakeElement("DIV", doc);
  const pane = root.appendChild(new FakeElement("DIV", doc));
  for (const l of layers) {
    const c = new FakeCanvas("CANVAS", doc);
    c.setAttribute("data-layer", l.layer);
    c.width = l.width;
    c.height = l.height;
    c.rect = { left: 0, top: 0, width: cssWidth?.(l) ?? l.width, height: l.height };
    pane.appendChild(c);
  }
  return root;
}

/**
 * The `fillRect` calls of a recording context, in the shape these suites assert on: the fill style
 * in force plus the destination box.
 */
export function fills(
  g: FakeContext2D,
): { style: string; x: number; y: number; w: number; h: number }[] {
  return g.calls("fillRect").map((o) => ({
    style: o.fill,
    x: o.args[0] ?? 0,
    y: o.args[1] ?? 0,
    w: o.args[2] ?? 0,
    h: o.args[3] ?? 0,
  }));
}

/* ------------------------------------------------------------------ *
 * `boot` — the whole `stargantt.export` plugin over mock services (service.test.ts)
 * ------------------------------------------------------------------ */

export interface LayerSpec {
  layer: string;
  width: number;
  height: number;
}

export interface TaskSpec {
  start: number;
  end: number;
}

/** One stand-in `renderer/layers` contribution: what the mock `renderTo` composites. */
export type LayerDraw = (g: CanvasRenderingContext2D, vp: Readonly<Viewport>) => void;

export interface BootOptions {
  viewport?: Partial<Viewport>;
  layers?: readonly LayerSpec[];
  /** The layer draws the mock `renderTo` runs, in z order. Defaults to one full-tile fill. */
  layerDraws?: readonly LayerDraw[];
  /** Extra plugins registered after `exportPlugin`. */
  extra?: AnyPlugin[];
  /** Config handed to the `exportPlugin` factory. */
  config?: ExportConfig;
  /** Tasks the `stargantt.data` mock reports; drives `range: "full"`. */
  tasks?: readonly TaskSpec[];
  /** Content px per ms for the timeline mock; `x = t * pxPerMs`. */
  pxPerMs?: number;
  /**
   * `RowsService.totalHeight()` of the rows mock, which is what §1.1's all-rows coverage reads.
   * `false` omits `stargantt.rows` from the mock services entirely (no rows service reachable).
   */
  totalHeight?: number | false;
}

export interface Booted {
  doc: FakeDocument;
  root: FakeElement;
  service: ExportService;
  /** Every `view.invalidate` call. */
  invalidated: string[];
  /** Every `view.scrollTo` target; §1.1 "Tiled composition" requires this to stay empty. */
  scrolls: number[];
  /** Every virtual viewport `renderTo` was called with, in order. */
  renders: Viewport[];
  viewport: Viewport;
  dispose(): void;
}

/**
 * Boots the real `stargantt.export` plugin (from `../../src/index`) through
 * `@stargantt/sdk`'s `createTestHost`, with mock `stargantt.data` / `stargantt.view` /
 * `stargantt.timeline` / `stargantt.theme` (and, unless `totalHeight: false`, `stargantt.rows`)
 * services — same plugin ids and service keys as the real providers, so `exportPlugin`'s
 * `dependsOn` / `optional` resolve without booting the real view/data-store/tree-grid plugins.
 */
export function boot(options: BootOptions = {}): Booted {
  const doc = new FakeDocument();
  const layers = options.layers ?? [
    { layer: "background", width: 800, height: 600 },
    { layer: "main", width: 800, height: 600 },
    { layer: "overlay", width: 800, height: 600 },
  ];
  const vp: Viewport = {
    scrollTop: 0,
    scrollLeft: 0,
    width: 800,
    height: 600,
    ...options.viewport,
  };
  // Layer canvases are CSS-sized to the chart's own viewport, exactly as the real render module
  // sizes them; their backing-store width divided by this is the ratio `recoverRatio` is meant to
  // find.
  const root = makeRoot(doc, layers, () => vp.width);
  const invalidated: string[] = [];
  const scrolls: number[] = [];
  const renders: Viewport[] = [];
  const draws: readonly LayerDraw[] = options.layerDraws ?? [
    (g, v) => g.fillRect(0, 0, v.width, v.height),
  ];

  const viewMock = {
    invalidate: (layer: string) => void invalidated.push(layer),
    refreshInsets: () => {},
    direction: () => "ltr" as const,
    reducedMotion: () => false,
    textWidth: (_g: unknown, text: string) => text.length * 6,
    bidiIsolate: (text: string) => text,
    firstPaintMs: () => undefined,
    batchRead: (fn: () => void) => fn(),
    batchWrite: (fn: () => void) => fn(),
    predictedViewport: () => undefined,
    chartPaneElement: () => asElement(doc.createElement("div")),
    wheelSpeedFactor: () => 1,
    scrollTo: (target: { scrollLeft?: number; scrollTop?: number }) => {
      if (typeof target.scrollLeft === "number") scrolls.push(target.scrollLeft);
    },
    // §1.1 "Tiled composition" — the off-screen composite, bracketing each layer in its own
    // save/restore pair exactly like the real view module, which is what the SVG path's per-layer
    // split relies on.
    renderTo: (g: CanvasRenderingContext2D, viewport: Readonly<Viewport>) => {
      renders.push({ ...viewport });
      for (const draw of draws) {
        g.save();
        try {
          draw(g, viewport);
        } catch {
          // Fault isolation, like the real render module's own composite.
        }
        g.restore();
      }
    },
    viewport: mockStore<Readonly<Viewport>>({ ...vp }),
    viewMode: mockStore("split"),
  };

  const pxPerMs = options.pxPerMs ?? 1;
  const timelineMock = {
    tToX: (t: number) => t * pxPerMs,
    xToT: (x: number) => x / pxPerMs,
    pxPerMs,
    setZoomLevel: () => {},
    setOrigin: () => {},
    requestOriginExtension: () => {},
    releaseOriginExtension: () => {},
    levelMetrics: () => [],
    firstDayOfWeek: () => 1,
    unitBoundaries: () => [],
    formatDate: () => "",
    gridCellAt: (t: number) => ({ start: t, end: t + 86_400_000 }),
    zoomLevel: mockStore({ id: "day", pxPerDay: 24, scales: [] }),
  };

  const themeMock = {
    get: () => "",
    audit: () => [],
    setPreset: () => {},
    preset: () => null,
    presets: () => [],
    setColorScheme: () => {},
    colorScheme: () => "auto" as const,
    refresh: () => {},
    tokens: mockStore({}),
  };

  const byId = new Map<number, TaskSpec>();
  (options.tasks ?? []).forEach((t, i) => byId.set(i, t));
  const dataMock = { query: () => ({ byId }) };

  const services: Record<string, unknown> = {
    "stargantt.data": dataMock,
    "stargantt.view": viewMock,
    "stargantt.timeline": timelineMock,
    "stargantt.theme": themeMock,
  };
  const totalHeight = options.totalHeight ?? 0;
  if (options.totalHeight !== false) {
    services["stargantt.rows"] = { totalHeight: () => totalHeight };
  }

  // The declared hard-dependency providers are present as empty plugins so the host's
  // `dependsOn` resolution succeeds; the services themselves come from the mocks above (the
  // tree-grid `test/plugin.test.ts` precedent).
  const provider = (id: string): AnyPlugin => definePlugin({ meta: { id }, setup: () => {} });

  const testHost = createTestHost({
    element: asElement(root),
    plugins: [
      provider("stargantt.data-store"),
      provider("stargantt.view"),
      exportPlugin(options.config),
      ...(options.extra ?? []),
    ],
    services,
  });

  const service = testHost.host.service("stargantt.export");

  return {
    doc,
    root,
    service,
    invalidated,
    scrolls,
    renders,
    viewport: vp,
    dispose: () => testHost.dispose(),
  };
}
