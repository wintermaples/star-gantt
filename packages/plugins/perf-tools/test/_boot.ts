// @vitest-environment happy-dom
/**
 * Shared boot helper for the perf-tools plugin suite: a real `@stargantt/core` host (via
 * `@stargantt/sdk`'s `createTestHost`) plus a deterministic clock/Performance-API double and a
 * manually-driven `requestAnimationFrame` queue.
 *
 * No spec defines an injection seam for `requestAnimationFrame` or `performance` (the plugin
 * reads `globalThis` directly by design — docs/specs/plugins/perf-tools.md § Purpose), so both
 * are stubbed on the global per test run here, restored by
 * `dispose()`.
 */
import { definePlugin } from "@stargantt/core";
import type { AnyPlugin, PluginContext } from "@stargantt/core";
import type { ViewService } from "@stargantt/plugin-view";
import { createTestHost } from "@stargantt/sdk";
import type { TestHost } from "@stargantt/sdk";
import { perfTools } from "../src/index";
import type { PerfToolsConfig, PerfToolsService } from "../src/index";

/* ------------------------------------------------------------------ *
 * Deterministic clock + recording Performance API double
 * ------------------------------------------------------------------ */

export interface FakePerformance {
  marks: string[];
  measures: { name: string; start: string | undefined; end: string | undefined }[];
}

function installClock(start = 0): { time: { value: number }; perf: FakePerformance; restore(): void } {
  const g = globalThis as { performance?: unknown };
  const had = "performance" in g;
  const saved = g.performance;
  const time = { value: start };
  const perf: FakePerformance = { marks: [], measures: [] };
  g.performance = {
    now: () => time.value,
    mark: (name: string) => void perf.marks.push(name),
    measure: (name: string, startMark?: string, endMark?: string) =>
      void perf.measures.push({ name, start: startMark, end: endMark }),
  };
  return {
    time,
    perf,
    restore(): void {
      if (had) g.performance = saved;
      else delete g.performance;
    },
  };
}

/* ------------------------------------------------------------------ *
 * A manually-driven requestAnimationFrame queue
 * ------------------------------------------------------------------ */

export interface FakeRaf {
  /** Runs every queued callback once (a single flush = one "frame"). */
  flush(): void;
  /** Number of callbacks currently queued (0 means the loop is stopped). */
  pending(): number;
  /** Cumulative `cancelAnimationFrame` calls, for dispose-cancels-the-pending-frame assertions. */
  cancelled(): number;
  restore(): void;
}

/**
 * Removes `requestAnimationFrame`/`cancelAnimationFrame` from the global entirely — happy-dom
 * supplies its own (timer-backed) implementation by default, so simulating "no rAF in this
 * environment" (§ Purpose: "Without requestAnimationFrame the loop never starts") needs an
 * explicit deletion, not merely skipping the stub above.
 */
function removeRaf(): { restore(): void } {
  const g = globalThis as {
    requestAnimationFrame?: unknown;
    cancelAnimationFrame?: unknown;
  };
  const hadReq = "requestAnimationFrame" in g;
  const savedReq = g.requestAnimationFrame;
  const hadCancel = "cancelAnimationFrame" in g;
  const savedCancel = g.cancelAnimationFrame;
  delete g.requestAnimationFrame;
  delete g.cancelAnimationFrame;
  return {
    restore(): void {
      if (hadReq) g.requestAnimationFrame = savedReq;
      if (hadCancel) g.cancelAnimationFrame = savedCancel;
    },
  };
}

function installRaf(): FakeRaf {
  const g = globalThis as {
    requestAnimationFrame?: (cb: FrameRequestCallback) => number;
    cancelAnimationFrame?: (id: number) => void;
  };
  const hadReq = "requestAnimationFrame" in g;
  const savedReq = g.requestAnimationFrame;
  const hadCancel = "cancelAnimationFrame" in g;
  const savedCancel = g.cancelAnimationFrame;

  let nextId = 1;
  let queue = new Map<number, FrameRequestCallback>();
  let cancelledCount = 0;

  g.requestAnimationFrame = (cb: FrameRequestCallback): number => {
    const id = nextId++;
    queue.set(id, cb);
    return id;
  };
  g.cancelAnimationFrame = (id: number): void => {
    if (queue.delete(id)) cancelledCount += 1;
  };

  return {
    flush(): void {
      const current = queue;
      queue = new Map();
      for (const cb of current.values()) cb(0);
    },
    pending: () => queue.size,
    cancelled: () => cancelledCount,
    restore(): void {
      if (hadReq) g.requestAnimationFrame = savedReq!;
      else delete g.requestAnimationFrame;
      if (hadCancel) g.cancelAnimationFrame = savedCancel!;
      else delete g.cancelAnimationFrame;
    },
  };
}

/* ------------------------------------------------------------------ *
 * A minimal `stargantt.view` stand-in (chart pane host for the overlay)
 * ------------------------------------------------------------------ */

export function fakeView(): { plugin: AnyPlugin; pane(): HTMLElement } {
  let pane: HTMLElement | undefined;
  const plugin = definePlugin({
    meta: { id: "stargantt.view" },
    setup(ctx: PluginContext): void {
      pane = ctx.root.ownerDocument!.createElement("div");
      pane.className = "sg-pane sg-pane--chart";
      ctx.root.appendChild(pane);
      const service: Pick<ViewService, "chartPaneElement"> = {
        chartPaneElement: () => pane!,
      };
      ctx.provide("stargantt.view", service as unknown as ViewService);
      ctx.own({ dispose: () => pane?.remove() });
    },
  });
  return { plugin, pane: () => pane! };
}

/* ------------------------------------------------------------------ *
 * Boot
 * ------------------------------------------------------------------ */

export interface BootOptions {
  config?: PerfToolsConfig;
  /** `false` boots without the view stand-in (overlay then lands on the chart root). */
  view?: boolean;
  /** `false` removes `requestAnimationFrame` from the environment entirely. */
  raf?: boolean;
  clockStart?: number;
  /**
   * Registration order of perf-tools relative to the view stand-in (default `"after"`, i.e. the
   * view plugin registers first). `"before"` registers perf-tools first — exercising "no
   * ordering edge from `meta.optional`" (docs/specs/plugins/perf-tools.md § Dependencies), since
   * the two share a tier and are otherwise ordered by registration index.
   */
  pluginOrder?: "before" | "after";
  /** Extra plugins registered alongside perf-tools (e.g. corner-claiming competitors). */
  extra?: AnyPlugin[];
}

export interface Booted {
  raf: FakeRaf | undefined;
  perf: FakePerformance;
  root: HTMLElement;
  pane: (() => HTMLElement) | undefined;
  th: TestHost;
  service(): PerfToolsService;
  overlay(): HTMLElement | null;
  readout(): string;
  /** Advances the clock, then runs one queued frame batch. */
  frame(ms: number): void;
  errors: { pluginId: string; error: unknown }[];
  dispose(): void;
}

export function boot(options: BootOptions = {}): Booted {
  const noRaf = options.raf === false ? removeRaf() : undefined;
  const raf = options.raf === false ? undefined : installRaf();
  const clock = installClock(options.clockStart ?? 0);

  const withView = options.view !== false;
  const view = withView ? fakeView() : undefined;
  const perfPlugin = perfTools(options.config);
  // A plugin whose OWN setup() subscribes to `core/pluginError`, registered FIRST (lowest
  // `regIndex`, so it runs first among every tier-0 plugin) — a `GanttInstance.on()` call made
  // after `Gantt.create()` returns is too late to see a fault emitted DURING another plugin's
  // `setup()` (e.g. the `overlay-corner` slot-contention warning), since `start()` runs every
  // `setup()` to completion, synchronously, before handing back the instance.
  const errors: { pluginId: string; error: unknown }[] = [];
  const errorRecorder = definePlugin({
    meta: { id: "test.error-recorder" },
    setup(ctx: PluginContext): void {
      ctx.on("core/pluginError", (e) => void errors.push(e));
    },
  });
  // `extra` (typically corner-claiming competitors) registers — and so runs `setup()` — BEFORE
  // perf-tools, same tier, registration order, ONLY in the default ("after") branch: a competitor
  // must occupy its corner before perf-tools's own claim runs for the contested-slot scenarios to
  // be meaningful, which is what every corner-claim test below relies on (none of them pass
  // `pluginOrder: "before"`). `pluginOrder: "before"` puts perf-tools first instead — it exists to
  // exercise the OPPOSITE ordering for the `stargantt.view` mount seam, not for corner
  // contention, so `extra` still lands after perf-tools in that branch.
  const plugins: AnyPlugin[] =
    options.pluginOrder === "before"
      ? [errorRecorder, perfPlugin, ...(view !== undefined ? [view.plugin] : []), ...(options.extra ?? [])]
      : [
          errorRecorder,
          ...(view !== undefined ? [view.plugin] : []),
          ...(options.extra ?? []),
          perfPlugin,
        ];

  const root = document.createElement("div");
  const th = createTestHost({ plugins, element: root });

  const overlay = (): HTMLElement | null => root.querySelector(".sg-perf-tools");
  let disposed = false;
  return {
    raf,
    perf: clock.perf,
    root,
    pane: view?.pane,
    th,
    errors,
    overlay,
    readout(): string {
      return overlay()?.querySelector(".sg-perf-tools__readout")?.textContent ?? "";
    },
    service: () => th.host.service("stargantt.perf-tools"),
    frame(ms: number): void {
      clock.time.value += ms;
      raf?.flush();
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      th.dispose();
      clock.restore();
      raf?.restore();
      noRaf?.restore();
    },
  };
}
