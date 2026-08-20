/**
 * Shared print-test harness: a recording canvas-2D double over happy-dom, plus a real host booted
 * around `exportPlugin` with mock `stargantt.data` / `view` / `timeline` / `theme` services.
 *
 * There is no shared test-utils package (the SDK sits at the bottom of the dependency graph and
 * nothing may sit below it), so each package brings its own doubles. Here the DOM itself is real
 * — happy-dom — and only the canvas is faked, which is the one part happy-dom does not implement:
 * `getContext("2d")` answers `null` there, so the print pipeline would degrade instead of drawing.
 * Test files that need this harness declare `// @vitest-environment happy-dom` themselves.
 */
import { definePlugin } from "@stargantt/core";
import type { AnyPlugin } from "@stargantt/core";
import { createTestHost } from "@stargantt/sdk";
import type { TestHost } from "@stargantt/sdk";
import { exportPlugin } from "../../src/index";
import type { ExportConfig } from "../../src/config";
import type { ExportService, PrintOptions } from "../../src/types";

export const DAY = 86_400_000;

/* ------------------------------------------------------------------ *
 * The canvas double
 * ------------------------------------------------------------------ */

/** One recorded drawing call, with the styles in force when it ran. */
export interface DrawCall {
  op: string;
  args: readonly number[];
  fill: string;
  stroke: string;
}

/** One recorded text call. */
export interface TextCall {
  text: string;
  x: number;
  y: number;
  fill: string;
  font: string;
}

/** A recording `CanvasRenderingContext2D` implementing exactly what the print path touches. */
export class FakeContext2D {
  fillStyle: string | CanvasGradient | CanvasPattern = "#000000";
  strokeStyle: string | CanvasGradient | CanvasPattern = "#000000";
  lineWidth = 1;
  font = "10px sans-serif";
  textAlign = "start";
  textBaseline = "alphabetic";
  readonly calls: DrawCall[] = [];
  readonly texts: TextCall[] = [];

  constructor(readonly canvas: HTMLCanvasElement) {}

  private record(op: string, args: readonly number[]): void {
    this.calls.push({ op, args, fill: String(this.fillStyle), stroke: String(this.strokeStyle) });
  }

  /** Every recorded call of one operation. */
  op(name: string): DrawCall[] {
    return this.calls.filter((c) => c.op === name);
  }

  fillRect(x: number, y: number, w: number, h: number): void {
    this.record("fillRect", [x, y, w, h]);
  }
  strokeRect(x: number, y: number, w: number, h: number): void {
    this.record("strokeRect", [x, y, w, h]);
  }
  clearRect(x: number, y: number, w: number, h: number): void {
    this.record("clearRect", [x, y, w, h]);
  }
  beginPath(): void {
    this.record("beginPath", []);
  }
  rect(x: number, y: number, w: number, h: number): void {
    this.record("rect", [x, y, w, h]);
  }
  clip(): void {
    this.record("clip", []);
  }
  moveTo(x: number, y: number): void {
    this.record("moveTo", [x, y]);
  }
  lineTo(x: number, y: number): void {
    this.record("lineTo", [x, y]);
  }
  stroke(): void {
    this.record("stroke", []);
  }
  fill(): void {
    this.record("fill", []);
  }
  save(): void {
    this.record("save", []);
  }
  restore(): void {
    this.record("restore", []);
  }
  translate(x: number, y: number): void {
    this.record("translate", [x, y]);
  }
  scale(x: number, y: number): void {
    this.record("scale", [x, y]);
  }
  fillText(text: string, x: number, y: number): void {
    this.texts.push({ text, x, y, fill: String(this.fillStyle), font: this.font });
    this.record("fillText", [x, y]);
  }
  strokeText(text: string, x: number, y: number): void {
    this.texts.push({ text, x, y, fill: String(this.strokeStyle), font: this.font });
    this.record("strokeText", [x, y]);
  }
  measureText(text: string): { width: number } {
    // A stable 6 px per character, so legend/label layout is deterministic across platforms.
    return { width: text.length * 6 };
  }
  /** A size-correct, deterministic opaque-white readback — the lossless PDF path reads real pixels. */
  getImageData(_x: number, _y: number, w: number, h: number): ImageData {
    const data = new Uint8ClampedArray(Math.max(0, w) * Math.max(0, h) * 4).fill(255);
    return { data, width: w, height: h, colorSpace: "srgb" } as unknown as ImageData;
  }
}

const contextOf = new WeakMap<HTMLCanvasElement, FakeContext2D>();
let created: FakeContext2D[] = [];
let contextAvailable = true;
let readbackAllowed = true;

/** Makes every later `getContext("2d")` answer `null` (the "no 2D context" environment). */
export function denyCanvasContext(): void {
  contextAvailable = false;
}

/** Makes every later `getImageData` throw (the "refuses pixel readback" environment). */
export function denyPixelReadback(): void {
  readbackAllowed = false;
}

/** Every context handed out since the last `boot()`, in creation order. */
export function createdContexts(): readonly FakeContext2D[] {
  return created;
}

/** All `fillText`/`strokeText` strings drawn on the canvases the export created, in order. */
export function drawnTexts(): string[] {
  return created.flatMap((c) => c.texts.map((t) => t.text));
}

function installFakeCanvas(): void {
  if (typeof HTMLCanvasElement === "undefined") return;
  const proto = HTMLCanvasElement.prototype as unknown as {
    getContext: (id: string) => unknown;
  };
  proto.getContext = function (this: HTMLCanvasElement, id: string): unknown {
    if (id !== "2d" || !contextAvailable) return null;
    let ctx = contextOf.get(this);
    if (ctx === undefined) {
      ctx = new FakeContext2D(this);
      if (!readbackAllowed) {
        ctx.getImageData = (): ImageData => {
          throw new Error("readback refused");
        };
      }
      contextOf.set(this, ctx);
      created.push(ctx);
    }
    return ctx;
  };
}

installFakeCanvas();

/* ------------------------------------------------------------------ *
 * The booted host
 * ------------------------------------------------------------------ */

export interface TaskSpec {
  id: string;
  name: string;
  start: number;
  end: number;
  progress?: number;
}

/** The viewport shape the view service publishes (structural: the mock provides just this). */
export interface Vp {
  scrollLeft: number;
  scrollTop: number;
  width: number;
  height: number;
}

export interface BootOptions {
  config?: ExportConfig;
  /** Shorthand for `config.print`. */
  print?: PrintOptions;
  tasks?: readonly TaskSpec[];
  viewport?: Partial<Vp>;
  /** Content px per ms; `x = t * pxPerMs`. Default 1 px per day: compact spans for the tests. */
  pxPerMs?: number;
  /** `false` composes without `stargantt.rows` (viewport row band). */
  rows?: boolean;
  /** Task ids reported critical; presence of the set composes the criticality query. */
  critical?: ReadonlySet<string>;
  /** The colour scheme `stargantt.theme` starts in. Default `"auto"`. */
  theme?: "light" | "dark" | "auto";
}

/** Spy surface for the `stargantt.theme` mock, so tests can assert the §1.3 scheme pin/restore. */
export interface ThemeSpy {
  current: "light" | "dark" | "auto";
  /** Every scheme passed to `setColorScheme`, in call order. */
  calls: ("light" | "dark" | "auto")[];
  /** `colorScheme()` as observed each time `renderTo` ran. */
  schemeDuringRenders: ("light" | "dark" | "auto")[];
}

export interface Booted {
  testHost: TestHost;
  root: HTMLElement;
  chartPane: HTMLElement;
  service: ExportService;
  renders: Vp[];
  errors: { pluginId: string; error: unknown }[];
  tasks: readonly TaskSpec[];
  /** `query()` call count, to verify one store snapshot per export. */
  queryCalls: { count: number };
  themeSpy: ThemeSpy;
  dispose(): void;
}

export function sampleTasks(): TaskSpec[] {
  return [
    { id: "a", name: "Design", start: 0, end: 10 * DAY, progress: 0.5 },
    { id: "b", name: "Build", start: 10 * DAY, end: 30 * DAY, progress: 0.25 },
    { id: "c", name: "Ship", start: 30 * DAY, end: 40 * DAY },
  ];
}

const UNIT_MS = { day: DAY, week: 7 * DAY, month: 30 * DAY, year: 365 * DAY } as const;
const ROW_H = 24;

export function boot(options: BootOptions = {}): Booted {
  created = [];
  contextAvailable = true;
  readbackAllowed = true;

  const doc = document;
  const root = doc.createElement("div");
  const chartPane = doc.createElement("div");
  chartPane.className = "sg-pane sg-pane--chart";
  root.appendChild(chartPane);
  doc.body.appendChild(root);

  const vp: Vp = { scrollTop: 0, scrollLeft: 0, width: 800, height: 600, ...options.viewport };
  const renders: Vp[] = [];
  const errors: { pluginId: string; error: unknown }[] = [];
  const tasks = options.tasks ?? sampleTasks();
  const pxPerMs = options.pxPerMs ?? 1 / DAY;
  const themeSpy: ThemeSpy = {
    current: options.theme ?? "auto",
    calls: [],
    schemeDuringRenders: [],
  };

  const byId = new Map(tasks.map((t) => [t.id, t]));
  const queryCalls = { count: 0 };

  const services: Record<string, unknown> = {
    "stargantt.data": {
      query: () => {
        queryCalls.count++;
        return { byId };
      },
    },
    "stargantt.view": {
      viewport: { get: () => ({ ...vp }) },
      chartPaneElement: () => chartPane,
      renderTo: (g: { fillRect(x: number, y: number, w: number, h: number): void }, viewport: Vp) => {
        renders.push({ ...viewport });
        themeSpy.schemeDuringRenders.push(themeSpy.current);
        g.fillRect(0, 0, viewport.width, viewport.height);
      },
    },
    "stargantt.timeline": {
      tToX: (t: number) => t * pxPerMs,
      xToT: (x: number) => x / pxPerMs,
      unitBoundaries: (unit: keyof typeof UNIT_MS, from: number, to: number) => {
        const step = UNIT_MS[unit];
        const out: number[] = [];
        for (let t = Math.ceil(from / step) * step; t < to; t += step) out.push(t);
        return out;
      },
    },
    "stargantt.theme": {
      colorScheme: () => themeSpy.current,
      setColorScheme: (scheme: "light" | "dark" | "auto") => {
        themeSpy.calls.push(scheme);
        themeSpy.current = scheme;
      },
    },
  };

  if (options.rows !== false) {
    services["stargantt.rows"] = {
      rowCount: () => tasks.length,
      taskIdAt: (row: number) => tasks[row]?.id,
      rowOf: (id: string) => tasks.findIndex((t) => t.id === id),
      rowHeight: () => ROW_H,
      resolvedHeightOf: () => ROW_H,
      yOf: (row: number) => row * ROW_H,
      rowAtY: (y: number) => Math.max(0, Math.floor(y / ROW_H)),
      totalHeight: () => tasks.length * ROW_H,
      isExpanded: () => true,
      rows: { get: () => ({ rows: [] }) },
    };
  }
  const critical = options.critical;
  if (critical !== undefined) {
    services["stargantt.critical-path"] = {
      criticalityOf: (id: string) => (critical.has(id) ? "critical" : undefined),
    };
  }

  const collector = definePlugin({
    meta: { id: "test.collector" },
    setup(ctx) {
      ctx.on("core/pluginError", (e) => void errors.push(e));
    },
  });
  // The two hard dependencies are declared by plugin id, so the ids must be registered even though
  // the mock provider is what actually publishes their services.
  const idStub = (id: string): AnyPlugin => definePlugin({ meta: { id }, setup: () => {} });

  const config: ExportConfig = {
    ...options.config,
    ...(options.print === undefined ? {} : { print: options.print }),
  };

  const testHost = createTestHost({
    element: root,
    services,
    plugins: [
      collector,
      idStub("stargantt.data-store"),
      idStub("stargantt.view"),
      exportPlugin(config),
    ],
  });

  return {
    testHost,
    root,
    chartPane,
    service: testHost.host.service("stargantt.export"),
    renders,
    errors,
    tasks,
    queryCalls,
    themeSpy,
    dispose: () => {
      testHost.dispose();
      root.remove();
    },
  };
}

/** The preview's dialog box inside the chart pane, or `undefined` when none is mounted. */
export function previewBox(chartPane: HTMLElement): HTMLElement | undefined {
  return chartPane.querySelector<HTMLElement>(".sg-print-preview") ?? undefined;
}

/** Every `<style>` element the preview installed, joined. */
export function printStyleText(): string {
  return Array.from(document.querySelectorAll("style"))
    .map((s) => s.textContent ?? "")
    .join("\n");
}

export type { ExportConfig, PrintOptions };
