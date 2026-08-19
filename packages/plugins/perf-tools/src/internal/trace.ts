// docs/specs/plugins/perf-tools.md §1.2, §3 — recording and Performance API mirroring.
/**
 * The start/stop trace recorder and the optional Performance API mirror. Hostless: the caller
 * supplies timestamps and the (already guarded) decision of whether mirroring is on.
 */
import type { PerfTrace } from "../types";
import { createStatsAccumulator } from "./meter";
import type { StatsAccumulator } from "./meter";

// docs/specs/plugins/perf-tools.md §1.2 — the frame cap bounding a forgotten recorder's memory;
// counters and the aggregate stats keep accumulating past it. `marks` shares the same ceiling but
// with the opposite eviction (below).
export const TRACE_FRAME_CAP = 100_000;

export interface TraceRecorder {
  isRecording(): boolean;
  /** Starts a recording; a no-op while one is already running. */
  start(now: number): void;
  /** Ends the recording and returns the trace; `undefined` when none is running. */
  stop(now: number): PerfTrace | undefined;
  /** Records one frame while recording; a no-op otherwise. */
  frame(t: number, durationMs: number): void;
  /** Appends an instant mark while recording; a no-op otherwise. */
  mark(t: number, name: string): void;
  /** Increments a named counter while recording; a no-op otherwise. */
  count(name: string, delta: number): void;
  /**
   * Ends a running recording WITHOUT producing a trace — `lastTrace()` at the service layer is
   * therefore untouched, unlike `stop()`. §1.2: "Disposal while recording stops sampling and
   * discards the unfinished recording (no implied `stopRecording`)." A no-op when not recording.
   */
  discard(): void;
}

/** Creates the trace recorder. `budgetMs` seeds every trace's `budgetMs` field and its stats. */
export function createTraceRecorder(budgetMs: number): TraceRecorder {
  let recording = false;
  let startedAt = 0;
  let frames: { t: number; dur: number }[] = [];
  let marks: { t: number; name: string }[] = [];
  let counters: Record<string, number> = Object.create(null) as Record<string, number>;
  let acc: StatsAccumulator | undefined;

  return {
    isRecording: () => recording,
    start(now: number): void {
      if (recording) return;
      recording = true;
      startedAt = now;
      frames = [];
      marks = [];
      counters = Object.create(null) as Record<string, number>;
      acc = createStatsAccumulator(budgetMs);
    },
    stop(now: number): PerfTrace | undefined {
      if (!recording || acc === undefined) return undefined;
      recording = false;
      const trace: PerfTrace = {
        startedAt,
        endedAt: now,
        budgetMs,
        frames,
        marks,
        // spread onto a plain-prototype object so `JSON.stringify` round-trips predictably
        counters: { ...counters },
        stats: acc.stats(),
      };
      acc = undefined;
      return trace;
    },
    frame(t: number, durationMs: number): void {
      if (!recording || acc === undefined) return;
      if (!Number.isFinite(durationMs) || durationMs < 0) return;
      acc.add(durationMs);
      if (frames.length < TRACE_FRAME_CAP) frames.push({ t, dur: durationMs });
    },
    mark(t: number, name: string): void {
      if (!recording) return;
      // §1.2 — `marks` is capped at the same 100 000-entry cap `frames` uses, but with
      // the opposite eviction policy: the oldest mark is dropped to make room, so a long
      // recording's `marks` array always reflects the most recent marks.
      if (marks.length >= TRACE_FRAME_CAP) marks.shift();
      marks.push({ t, name });
    },
    count(name: string, delta: number): void {
      if (!recording || !Number.isFinite(delta)) return;
      counters[name] = (counters[name] ?? 0) + delta;
    },
    discard(): void {
      if (!recording) return;
      recording = false;
      acc = undefined;
      frames = [];
      marks = [];
      counters = Object.create(null) as Record<string, number>;
    },
  };
}

/* ------------------------------------------------------------------ *
 * Performance API mirror (docs/specs/plugins/perf-tools.md §3)
 * ------------------------------------------------------------------ */

/** The `stargantt:` namespace every mirrored entry lives under. */
export const PERF_PREFIX = "stargantt:";
const REC_START = `${PERF_PREFIX}recording:start`;
const REC_END = `${PERF_PREFIX}recording:end`;
const REC_MEASURE = `${PERF_PREFIX}recording`;

interface PerformanceLike {
  mark?: (name: string) => unknown;
  measure?: (name: string, startMark?: string, endMark?: string) => unknown;
}

export interface PerfMirror {
  mark(name: string): void;
  recordingStarted(): void;
  recordingStopped(): void;
}

const NOOP_MIRROR: PerfMirror = {
  mark: () => undefined,
  recordingStarted: () => undefined,
  recordingStopped: () => undefined,
};

/**
 * Builds the Performance API mirror, or a no-op one when mirroring is off or the API is missing.
 * Every call is individually wrapped; a throwing call is silently skipped — the environment is
 * unusable for that call and the tool must never break the host over telemetry. Entries are never
 * read back (§3).
 */
export function createPerfMirror(enabled: boolean, perf: unknown): PerfMirror {
  if (!enabled || typeof perf !== "object" || perf === null) return NOOP_MIRROR;
  const p = perf as PerformanceLike;
  if (typeof p.mark !== "function") return NOOP_MIRROR;
  const mark = (name: string): void => {
    try {
      p.mark?.(name);
    } catch {
      /* silently skipped */
    }
  };
  return {
    mark: (name: string) => mark(PERF_PREFIX + name),
    recordingStarted: () => mark(REC_START),
    recordingStopped: (): void => {
      mark(REC_END);
      if (typeof p.measure !== "function") return;
      try {
        p.measure(REC_MEASURE, REC_START, REC_END);
      } catch {
        /* silently skipped */
      }
    },
  };
}
