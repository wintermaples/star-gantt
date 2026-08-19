// docs/specs/plugins/scheduling.md §2.1 (`engine/links.ts`)
/**
 * The per-link time relations evaluated by the scheduler's passes, plus the elapsed
 * `DurationModel` (the working-hours variant is `engine.ts`'s `modelFor`).
 *
 * A link reads *source → target*; its `lag` is in milliseconds and may be negative, which
 * expresses a lead. Lag is always elapsed time: it is a gap between two instants, not work.
 */
import type { Link, Task } from "@stargantt/plugin-data-store";
import type { DurationModel, LatestTimes, LinkBound, Times } from "./types";

/** Elapsed duration in ms. `end` is exclusive, and duration is always derived rather than stored. */
export function durationOf(task: Readonly<Task>): number {
  return task.end - task.start;
}

/** A model whose start and end are a fixed number of elapsed milliseconds apart. */
export function elapsedModel(duration: number): DurationModel {
  return {
    endFor: (start) => start + duration,
    startFor: (end) => end - duration,
  };
}

/**
 * Forward pass: the bound one link imposes on its target, and which side of the target it bounds.
 *
 * FS: source.end + lag   ≤ target.start
 * SS: source.start + lag ≤ target.start
 * FF: source.end + lag   ≤ target.end
 * SF: source.start + lag ≤ target.end
 *
 * The two anchors are deliberately **not** converted into each other here. Expressing an end bound
 * as a start (by walking the target's duration backwards) makes the bound depend on the duration
 * model, and where the model the caller inverts with differs from the one it later places with,
 * the placement stops being reproducible.
 */
export function boundFor(link: Link, source: Readonly<Times>): LinkBound {
  const lag = link.lag ?? 0;
  switch (link.type) {
    case "FS":
      return { anchor: "start", time: source.end + lag };
    case "SS":
      return { anchor: "start", time: source.start + lag };
    case "FF":
      return { anchor: "end", time: source.end + lag };
    case "SF":
      return { anchor: "end", time: source.start + lag };
  }
}

/**
 * Back-clamp pass: the latest end the *source* of the link may take without pushing the successor
 * past the times it is already scheduled at.
 */
export function latestEndFor(link: Link, model: DurationModel, target: Readonly<Times>): number {
  const lag = link.lag ?? 0;
  switch (link.type) {
    case "FS":
      return target.start - lag;
    case "SS":
      return model.endFor(target.start - lag);
    case "FF":
      return target.end - lag;
    case "SF":
      return model.endFor(target.end - lag);
  }
}

/**
 * Backward pass: the latest finish `link.sourceId` may take without violating the successor's
 * latest times, in the elapsed terms the critical-path consumer uses.
 */
export function latestFinishFor(
  link: Link,
  sourceDuration: number,
  target: Readonly<LatestTimes>,
): number {
  const lag = link.lag ?? 0;
  switch (link.type) {
    case "FS":
      return target.latestStart - lag;
    case "SS":
      return target.latestStart - lag + sourceDuration;
    case "FF":
      return target.latestFinish - lag;
    case "SF":
      return target.latestFinish - lag + sourceDuration;
  }
}
