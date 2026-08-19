/**
 * `@stargantt/plugin-perf-tools` — plugin id `stargantt.perf-tools`
 * (docs/specs/plugins/perf-tools.md).
 *
 * An opt-in developer tooling plugin: a floating frame-time overlay (FPS, average frame duration
 * and a sparkline of recent frames against the frame budget) plus a start/stop trace recorder
 * whose JSON-serializable traces — frame durations, named instant marks and named counters — can
 * be handed to external tools, optionally mirrored to the browser's Performance API under the
 * `stargantt:` prefix.
 *
 * The plugin owns a `requestAnimationFrame` loop that runs only while the overlay is visible or a
 * recording is active; with neither, it performs no per-frame work. It renders nothing into the
 * chart itself and its overlay is `pointer-events: none`, so no other plugin's behavior changes.
 */
import { definePlugin } from "@stargantt/core";
import type { Plugin, PluginContext } from "@stargantt/core";
// Type-only: `@stargantt/plugin-view` (a `devDependency`, no cycle back — the type-only
// exemption). This carries the view plugin's `declare module "@stargantt/core"`
// augmentation into this program, which is what makes `"stargantt.view"` a valid key of
// `keyof Services` below — erased at emit, no runtime dependency added.
import type { ViewService } from "@stargantt/plugin-view";
import { resolveCatalog } from "@stargantt/sdk";
import { createFrameMeter } from "./internal/meter";
import { createOverlay, OVERLAY_CORNERS, isOverlayCorner, resolveCorner } from "./internal/overlay";
import type { Overlay } from "./internal/overlay";
import { createPerfMirror, createTraceRecorder } from "./internal/trace";
import type {
  FrameStats,
  OverlayCorner,
  PerfToolsConfig,
  PerfToolsMessages,
  PerfToolsService,
  PerfTrace,
} from "./types";

export type {
  FrameStats,
  OverlayCorner,
  PerfToolsConfig,
  PerfToolsMessages,
  PerfToolsService,
  PerfTrace,
  PerfTraceFrame,
  PerfTraceMark,
} from "./types";

const PLUGIN_ID = "stargantt.perf-tools";
const SLOT_GROUP = "overlay-corner";

const DEFAULT_BUDGET_MS = 16.7;
const DEFAULT_WINDOW_SIZE = 120;

function defaultReadout(stats: FrameStats): string {
  return `${Math.round(stats.fps)} fps · ${stats.avgMs.toFixed(1)} ms`;
}

const DEFAULT_MESSAGES: PerfToolsMessages = { readout: defaultReadout };

/* ------------------------------------------------------------------ *
 * Config normalization
 * ------------------------------------------------------------------ */

function validFlag(value: unknown): boolean {
  return value !== false; // anything but the literal `false` keeps the default `true`
}

function validPosition(value: unknown): OverlayCorner {
  return isOverlayCorner(value) ? value : "top-right";
}

function validBudget(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : DEFAULT_BUDGET_MS;
}

function validWindowSize(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 2 && value <= 10_000
    ? value
    : DEFAULT_WINDOW_SIZE;
}

/* ------------------------------------------------------------------ *
 * The self-owned rAF loop
 * ------------------------------------------------------------------ */

interface FrameScheduler {
  request(cb: () => void): number;
  cancel(id: number): void;
}

/** The environment's rAF pair, or `undefined` where there is none (the loop then never starts). */
function resolveScheduler(): FrameScheduler | undefined {
  const g = globalThis as {
    requestAnimationFrame?: (cb: FrameRequestCallback) => number;
    cancelAnimationFrame?: (id: number) => void;
  };
  if (typeof g.requestAnimationFrame !== "function") return undefined;
  return {
    request: (cb) => g.requestAnimationFrame!(cb),
    cancel: (id) => g.cancelAnimationFrame?.(id),
  };
}

/** A monotonic-enough clock: `performance.now()` where present, else `Date.now()`. */
function now(): number {
  const perf = (globalThis as { performance?: { now?: () => number } }).performance;
  return typeof perf?.now === "function" ? perf.now() : Date.now();
}

/**
 * The one `ctx.useOptional("stargantt.view")` call this plugin makes — a VISIBLE, literal
 * member-expression call (never aliased, bound or cast on the `ctx.useOptional` expression
 * itself), so `tools/lint-deps.mjs`'s static scanner sees it exactly like any other service
 * lookup. `meta.optional` already lists `stargantt.view`, so this call is legal and lint-clean as
 * written.
 *
 * `"stargantt.view"` is a declared key of `keyof Services` here (see the type-only import above),
 * so this is a genuine `Services`-typed lookup — no structural shim, no cast.
 */
function lookupView(ctx: PluginContext): ViewService | undefined {
  return ctx.useOptional("stargantt.view");
}

/**
 * Creates the perf-tools plugin: a frame-time overlay (FPS readout and frame-duration sparkline
 * against the frame budget) and a trace recorder exporting frame timings, marks and counters as
 * JSON and, optionally, as Performance API entries — plus the `stargantt.perf-tools` service
 * exposing all of it to code.
 */
export function perfTools(config: PerfToolsConfig = {}): Plugin<void> {
  return definePlugin({
    meta: {
      id: PLUGIN_ID,
      // docs/specs/plugins/perf-tools.md § Dependencies — no hard dependency; `stargantt.view` is
      // optional (L2, `chartPaneElement()` as the overlay parent) and resolved late (below), never
      // latched at setup().
      optional: ["stargantt.view"],
    },
    setup(ctx: PluginContext): void {
      // docs/specs/plugins/perf-tools.md § Config — resolved once.
      const messages = resolveCatalog(DEFAULT_MESSAGES, config.messages, (messageKey, cause) => {
        // §2 — the readout builder is config-supplied foreign code invoked on a loop; a supplied
        // override is wrapped in the latched builder barrier by `resolveCatalog` itself. Error-
        // level (no `level` field): the corpus reserves `level: "warning"` for the arbitration
        // registry's own reports (§1.3's `claimSlot`), not for a broken host callback.
        ctx.emit("core/pluginError", { pluginId: PLUGIN_ID, error: { messageKey, cause } });
      });
      const budgetMs = validBudget(config.budgetMs);
      const windowSize = validWindowSize(config.windowSize);
      const requestedPosition = validPosition(config.position);
      const sparkline = validFlag(config.sparkline);
      const overlayOn = validFlag(config.overlay);

      const meter = createFrameMeter(windowSize, budgetMs);
      const recorder = createTraceRecorder(budgetMs);
      const mirror = createPerfMirror(
        validFlag(config.performanceMarks),
        (globalThis as { performance?: unknown }).performance,
      );

      /* --- the corner claim (§1.3): at setup() when the overlay resolves true, else deferred to
       * the first setOverlayVisible(true) — an overlay that never exists squats no corner. */
      let resolvedCorner: OverlayCorner | undefined;
      function claimCorner(): OverlayCorner {
        if (resolvedCorner === undefined) {
          const grant = ctx.claimSlot(SLOT_GROUP, requestedPosition, OVERLAY_CORNERS);
          resolvedCorner = resolveCorner(grant, requestedPosition);
        }
        return resolvedCorner;
      }
      if (overlayOn) claimCorner();

      /* --- the overlay, created lazily on first show ------------------ */
      let overlay: Overlay | undefined;
      // docs/specs/plugins/perf-tools.md § Dependencies — `stargantt.view` is resolved per use,
      // never latched at setup(): the overlay mounts once, on whichever parent resolves at mount
      // time (inside the `lifecycle/ready` handler below, or at the first `setOverlayVisible`).
      function overlayParent(): Element {
        return lookupView(ctx)?.chartPaneElement() ?? ctx.root;
      }
      function ensureOverlay(): Overlay {
        if (overlay === undefined) {
          overlay = createOverlay({
            doc: ctx.root.ownerDocument as Document,
            corner: claimCorner(),
            sparkline,
            budgetMs,
            readout: messages.readout,
          });
          overlayParent().appendChild(overlay.element);
        }
        return overlay;
      }

      /* --- the frame loop: runs only with a consumer (§ Purpose) ------ */
      const scheduler = resolveScheduler();
      let pendingFrame: number | undefined;
      let prevTick: number | undefined;

      function hasConsumer(): boolean {
        return recorder.isRecording() || (overlay !== undefined && overlay.isVisible());
      }

      // Lazy stats provider, hoisted to an instance-level const (m5 review fix): the window scan
      // and its summary allocation happen only when the overlay's throttled readout actually
      // updates (`Overlay.render` calls this only inside its throttle window), and hoisting it
      // means `tick()` — the hot per-frame path — allocates no new closure every call either.
      const provideStats = (): FrameStats => meter.stats();

      function tick(): void {
        pendingFrame = undefined;
        const t = now();
        if (prevTick !== undefined) {
          const dur = t - prevTick;
          meter.sample(dur);
          recorder.frame(t, dur);
        }
        prevTick = t;
        overlay?.render(t, provideStats, meter.ring());
        if (hasConsumer() && scheduler !== undefined) pendingFrame = scheduler.request(tick);
      }

      function ensureLoop(): void {
        if (scheduler === undefined || pendingFrame !== undefined || !hasConsumer()) return;
        prevTick = undefined; // an idle gap is not a frame (§1.1)
        pendingFrame = scheduler.request(tick);
      }

      // docs/specs/plugins/perf-tools.md § Dependencies — the initial overlay creation (and its
      // one-shot parent lookup) is deferred to `lifecycle/ready`, by which point every plugin has
      // run `setup()`; this plugin's tier carries no ordering guarantee at all (no `dependsOn`).
      if (overlayOn) {
        ctx.on("lifecycle/ready", () => {
          const created = ensureOverlay();
          // paint the initial (all-zero, or already-sampled) readout once, even with no rAF
          created.render(now(), provideStats, meter.ring());
          ensureLoop();
        });
      }

      /* --- the service (§1) -------------------------------------------- */
      let lastTrace: PerfTrace | undefined;
      const service: PerfToolsService = {
        stats: () => meter.stats(),
        setOverlayVisible(visible: boolean): void {
          if (visible === true) {
            ensureOverlay().setVisible(true);
            ensureLoop();
          } else if (visible === false) {
            overlay?.setVisible(false);
          }
        },
        startRecording(): void {
          if (recorder.isRecording()) return;
          recorder.start(now());
          mirror.recordingStarted();
          ensureLoop();
        },
        stopRecording(): PerfTrace | undefined {
          const trace = recorder.stop(now());
          if (trace === undefined) return undefined;
          mirror.recordingStopped();
          lastTrace = trace;
          return trace;
        },
        isRecording: () => recorder.isRecording(),
        lastTrace: () => lastTrace,
        exportJson: () => (lastTrace === undefined ? undefined : JSON.stringify(lastTrace)),
        mark(name: string): void {
          if (typeof name !== "string" || name === "") return;
          recorder.mark(now(), name);
          mirror.mark(name);
        },
        count(name: string, delta = 1): void {
          if (typeof name !== "string" || name === "") return;
          recorder.count(name, delta);
        },
      };
      ctx.provide("stargantt.perf-tools", service);

      // docs/specs/plugins/perf-tools.md § Dependencies — one disposable, owned once; the loop
      // re-arms by swapping `pendingFrame`, never by registering another disposable. Disposal
      // while recording stops sampling and discards the unfinished recording (no implied
      // `stopRecording`).
      ctx.own({
        dispose: (): void => {
          if (pendingFrame !== undefined) scheduler?.cancel(pendingFrame);
          pendingFrame = undefined;
          overlay?.element.remove();
          // m4 review fix — §1.2: disposal while recording stops sampling and discards the
          // unfinished recording; a post-disposal `stopRecording()` must answer `undefined` and
          // `lastTrace()` must stay whatever it already was (never the discarded recording).
          recorder.discard();
        },
      });
    },
  });
}
