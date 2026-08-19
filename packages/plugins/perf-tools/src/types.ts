/**
 * Public shapes of `@stargantt/plugin-perf-tools`, kept in one place so the internal modules can
 * share them without importing the plugin entry — and so the package's single `declare module
 * "@stargantt/core"` site (architecture.md ch. 1.4) lives here, kept apart from `index.ts` as its
 * own `types.ts` companion (docs/specs/plugins/perf-tools.md, Internal modules table).
 */
// docs/specs/plugins/perf-tools.md §1

/** A rolling-window summary of recent frame durations. All fields are `0` before any sample. */
export interface FrameStats {
  /** Frames per second implied by the window's average frame duration. */
  fps: number;
  /** Mean frame duration over the window, in milliseconds. */
  avgMs: number;
  /** Longest frame duration in the window, in milliseconds. */
  maxMs: number;
  /** Most recent frame duration, in milliseconds. */
  lastMs: number;
  /** How many samples the window currently holds. */
  frames: number;
  /** How many of the window's samples exceeded the configured frame budget. */
  overBudget: number;
}

/** One recorded animation frame: its timestamp and its duration in milliseconds. */
export interface PerfTraceFrame {
  t: number;
  dur: number;
}

/** One named instant recorded through `PerfToolsService.mark`. */
export interface PerfTraceMark {
  t: number;
  name: string;
}

/**
 * One completed recording: every frame duration, instant mark and counter captured between
 * `startRecording()` and `stopRecording()`, plus aggregate statistics over the whole run. The
 * object is JSON-serializable in a single `JSON.stringify` call.
 */
export interface PerfTrace {
  /** When the recording started, on the same clock as every `t` inside. */
  startedAt: number;
  /** When the recording stopped. */
  endedAt: number;
  /** The frame budget in force, in milliseconds. */
  budgetMs: number;
  /** The recorded frames, oldest first (capped at 100 000 entries; later frames are dropped). */
  frames: PerfTraceFrame[];
  /**
   * The recorded instant marks, oldest first (capped at the same 100 000 entries as `frames`, but
   * with the opposite eviction: the oldest mark is dropped for each new one past the cap).
   */
  marks: PerfTraceMark[];
  /** The final value of every named counter incremented during the recording. */
  counters: Record<string, number>;
  /** Aggregate frame statistics over the whole recording (not the rolling window). */
  stats: FrameStats;
}

// docs/specs/plugins/perf-tools.md §1
/**
 * Programmatic access to the perf-tools measurements: the live rolling frame statistics, the
 * start/stop trace recorder with JSON export, instant marks, named counters, and control over the
 * overlay's visibility.
 */
export interface PerfToolsService {
  /** The current rolling-window frame statistics; all-zero before any frame was sampled. */
  stats(): FrameStats;
  /** Shows or hides the frame-time overlay at runtime. */
  setOverlayVisible(visible: boolean): void;
  /** Starts a trace recording. Does nothing while a recording is already running. */
  startRecording(): void;
  /**
   * Stops the running recording and returns its trace, which also becomes `lastTrace()`. Returns
   * `undefined` when no recording is running.
   */
  stopRecording(): PerfTrace | undefined;
  /** Whether a recording is currently running. */
  isRecording(): boolean;
  /** The most recently completed trace, or `undefined` before the first one. */
  lastTrace(): PerfTrace | undefined;
  /** `JSON.stringify` of `lastTrace()`, or `undefined` before the first completed recording. */
  exportJson(): string | undefined;
  /**
   * Records a named instant: appended to the running recording (if any) and, when Performance API
   * mirroring is enabled, emitted as `performance.mark("stargantt:" + name)` even outside a
   * recording. A name that is not a non-empty string is ignored.
   */
  mark(name: string): void;
  /**
   * Increments a named counter of the running recording by `delta` (default `1`). Does nothing
   * outside a recording, for a non-finite delta, or for a name that is not a non-empty string.
   */
  count(name: string, delta?: number): void;
}

/** The four corners the overlay's `overlay-corner` slot claim can land in. */
export type OverlayCorner = "top-left" | "top-right" | "bottom-left" | "bottom-right";

// docs/specs/plugins/perf-tools.md § Messages
/**
 * The user-visible strings of the perf-tools overlay. Override any subset through
 * `PerfToolsConfig.messages`; the rest keep their built-in English defaults.
 */
export interface PerfToolsMessages {
  /**
   * Builds the overlay's readout line from the current frame statistics. Default:
   * `` `${Math.round(stats.fps)} fps · ${stats.avgMs.toFixed(1)} ms` ``.
   */
  readout: (stats: FrameStats) => string;
}

// docs/specs/plugins/perf-tools.md § Config
/**
 * Options for the perf-tools plugin. Every field is optional; omitting the whole config is the
 * same as passing `{}`, and an unusable value silently falls back to its default.
 */
export interface PerfToolsConfig {
  /**
   * Whether the overlay exists and is initially visible. Defaults to `true`. `false` creates no
   * DOM (and claims no corner) until `setOverlayVisible(true)`.
   */
  overlay?: boolean;
  /** Whether the overlay includes the frame-duration sparkline. Defaults to `true`. */
  sparkline?: boolean;
  /** The chart-pane corner the overlay floats in, with a 12px margin. Defaults to `"top-right"`. */
  position?: OverlayCorner;
  /**
   * The frame budget in milliseconds: frames longer than this count as over budget and the
   * sparkline's guide line sits at this duration. Defaults to `16.7`.
   */
  budgetMs?: number;
  /** How many recent frames the rolling window and the sparkline hold. Defaults to `120`. */
  windowSize?: number;
  /**
   * Whether marks and recordings are mirrored to the Performance API
   * (`performance.mark` / `performance.measure`) under the `stargantt:` prefix. Defaults to
   * `true`; silently inert where the API is unavailable.
   */
  performanceMarks?: boolean;
  /** Replaces any subset of the overlay's user-visible strings. */
  messages?: Partial<PerfToolsMessages>;
}

declare module "@stargantt/core" {
  interface Services {
    "stargantt.perf-tools": PerfToolsService;
  }
}
