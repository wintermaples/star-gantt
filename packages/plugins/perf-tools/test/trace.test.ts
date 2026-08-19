import { describe, expect, it } from "vitest";
import { PERF_PREFIX, TRACE_FRAME_CAP, createPerfMirror, createTraceRecorder } from "../src/internal/trace";

describe("createTraceRecorder", () => {
  it("captures frames, marks and counters between start and stop", () => {
    const rec = createTraceRecorder(16.7);
    rec.start(1000);
    rec.frame(1016, 16);
    rec.frame(1041, 25);
    rec.mark(1020, "layout");
    rec.count("invalidate", 1);
    rec.count("invalidate", 2);
    const trace = rec.stop(1050);
    expect(trace).toBeDefined();
    expect(trace!.startedAt).toBe(1000);
    expect(trace!.endedAt).toBe(1050);
    expect(trace!.budgetMs).toBe(16.7);
    expect(trace!.frames).toEqual([
      { t: 1016, dur: 16 },
      { t: 1041, dur: 25 },
    ]);
    expect(trace!.marks).toEqual([{ t: 1020, name: "layout" }]);
    expect(trace!.counters).toEqual({ invalidate: 3 });
    expect(trace!.stats.frames).toBe(2);
    expect(trace!.stats.overBudget).toBe(1);
    expect(rec.isRecording()).toBe(false);
  });

  it("is a no-op outside a recording, and stop without start returns undefined", () => {
    const rec = createTraceRecorder(16.7);
    rec.frame(1, 10);
    rec.mark(1, "x");
    rec.count("x", 1);
    expect(rec.stop(2)).toBeUndefined();
    rec.start(10);
    const trace = rec.stop(11);
    expect(trace!.frames).toEqual([]);
    expect(trace!.marks).toEqual([]);
    expect(trace!.counters).toEqual({});
  });

  it("start while recording keeps the running recording (a no-op, §1.2)", () => {
    const rec = createTraceRecorder(16.7);
    rec.start(100);
    rec.frame(110, 10);
    rec.start(999); // ignored
    const trace = rec.stop(200);
    expect(trace!.startedAt).toBe(100);
    expect(trace!.frames).toHaveLength(1);
  });

  it("caps stored frames at 100k, dropping the newest, while stats keep aggregating", () => {
    const rec = createTraceRecorder(16.7);
    rec.start(0);
    for (let i = 0; i < TRACE_FRAME_CAP + 5; i += 1) rec.frame(i, 10);
    const trace = rec.stop(1);
    expect(trace!.frames).toHaveLength(TRACE_FRAME_CAP);
    expect(trace!.frames.at(-1)!.t).toBe(TRACE_FRAME_CAP - 1); // the last 5 (drop-newest) never landed
    expect(trace!.stats.frames).toBe(TRACE_FRAME_CAP + 5); // counters/aggregate stats still accumulate
  });

  it("caps stored marks at the same ceiling as frames, dropping the OLDEST — the opposite eviction direction", () => {
    const rec = createTraceRecorder(16.7);
    rec.start(0);
    for (let i = 0; i < TRACE_FRAME_CAP + 5; i += 1) rec.mark(i, `m${i}`);
    const trace = rec.stop(1);
    expect(trace!.marks).toHaveLength(TRACE_FRAME_CAP);
    // The oldest 5 marks (m0..m4) were evicted; the most recent survive — proving the eviction
    // direction is the opposite of `frames`' drop-newest cap above.
    expect(trace!.marks[0]!.name).toBe("m5");
    expect(trace!.marks.at(-1)!.name).toBe(`m${TRACE_FRAME_CAP + 4}`);
  });

  it("ignores non-finite counter deltas and non-finite/negative frame durations", () => {
    const rec = createTraceRecorder(16.7);
    rec.start(0);
    rec.count("a", Number.NaN);
    rec.frame(1, Number.NaN);
    rec.frame(2, -1);
    const trace = rec.stop(3);
    expect(trace!.counters).toEqual({});
    expect(trace!.frames).toEqual([]);
  });

  it("mark/count are no-ops outside a recording", () => {
    const rec = createTraceRecorder(16.7);
    rec.mark(1, "x");
    rec.count("c", 1);
    rec.start(2);
    const trace = rec.stop(3);
    expect(trace!.marks).toEqual([]);
    expect(trace!.counters).toEqual({});
  });

  it("produces a JSON-round-trippable trace", () => {
    const rec = createTraceRecorder(16.7);
    rec.start(0);
    rec.frame(1, 10);
    rec.mark(2, "m");
    rec.count("c", 4);
    const trace = rec.stop(5)!;
    expect(JSON.parse(JSON.stringify(trace))).toEqual(trace);
  });
});

describe("createPerfMirror", () => {
  function recordingPerf(): { perf: unknown; marks: string[]; measures: string[][] } {
    const marks: string[] = [];
    const measures: string[][] = [];
    return {
      marks,
      measures,
      perf: {
        mark: (name: string) => void marks.push(name),
        measure: (...args: string[]) => void measures.push(args),
      },
    };
  }

  it("prefixes marks and emits the recording measure pair", () => {
    const { perf, marks, measures } = recordingPerf();
    const mirror = createPerfMirror(true, perf);
    mirror.mark("layout");
    mirror.recordingStarted();
    mirror.recordingStopped();
    expect(marks).toEqual([`${PERF_PREFIX}layout`, `${PERF_PREFIX}recording:start`, `${PERF_PREFIX}recording:end`]);
    expect(measures).toEqual([[`${PERF_PREFIX}recording`, `${PERF_PREFIX}recording:start`, `${PERF_PREFIX}recording:end`]]);
  });

  it("is inert when disabled or when the API is missing", () => {
    const { perf, marks } = recordingPerf();
    createPerfMirror(false, perf).mark("x");
    expect(marks).toEqual([]);
    // no API at all — nothing throws
    createPerfMirror(true, undefined).mark("x");
    createPerfMirror(true, {}).recordingStopped();
  });

  it("swallows a throwing Performance API call", () => {
    const mirror = createPerfMirror(true, {
      mark: () => {
        throw new Error("boom");
      },
      measure: () => {
        throw new Error("boom");
      },
    });
    expect(() => {
      mirror.mark("x");
      mirror.recordingStarted();
      mirror.recordingStopped();
    }).not.toThrow();
  });
});
