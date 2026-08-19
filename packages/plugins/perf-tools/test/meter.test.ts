import { describe, expect, it } from "vitest";
import { createFrameMeter, createStatsAccumulator } from "../src/internal/meter";

describe("createFrameMeter", () => {
  it("reports all-zero stats before any sample", () => {
    const meter = createFrameMeter(4, 16.7);
    expect(meter.stats()).toEqual({ fps: 0, avgMs: 0, maxMs: 0, lastMs: 0, frames: 0, overBudget: 0 });
  });

  it("summarizes the window: avg, max, last, fps and over-budget count", () => {
    const meter = createFrameMeter(8, 16.7);
    for (const dur of [10, 20, 30]) meter.sample(dur);
    const stats = meter.stats();
    expect(stats.frames).toBe(3);
    expect(stats.avgMs).toBeCloseTo(20);
    expect(stats.maxMs).toBe(30);
    expect(stats.lastMs).toBe(30);
    expect(stats.fps).toBeCloseTo(50);
    expect(stats.overBudget).toBe(2); // 20 and 30 exceed 16.7
  });

  it("evicts the oldest samples once the window is full (preallocated ring buffer)", () => {
    const meter = createFrameMeter(3, 16.7);
    for (const dur of [100, 1, 2, 3]) meter.sample(dur); // 100 falls out
    const stats = meter.stats();
    expect(stats.frames).toBe(3);
    expect(stats.maxMs).toBe(3);
    expect(stats.avgMs).toBeCloseTo(2);
  });

  it("yields the ring oldest-first, before and after rollover", () => {
    const meter = createFrameMeter(3, 16.7);
    meter.sample(1);
    meter.sample(2);
    let ring = meter.ring();
    expect([ring.at(0), ring.at(1)]).toEqual([1, 2]);
    meter.sample(3);
    meter.sample(4); // evicts 1
    ring = meter.ring();
    expect([ring.at(0), ring.at(1), ring.at(2)]).toEqual([2, 3, 4]);
  });

  it("ignores non-finite and negative samples", () => {
    const meter = createFrameMeter(4, 16.7);
    meter.sample(Number.NaN);
    meter.sample(-5);
    meter.sample(Number.POSITIVE_INFINITY);
    expect(meter.stats().frames).toBe(0);
  });
});

describe("createStatsAccumulator", () => {
  it("aggregates an unbounded run without a window", () => {
    const acc = createStatsAccumulator(16.7);
    for (const dur of [10, 20, 30, 40]) acc.add(dur);
    const stats = acc.stats();
    expect(stats.frames).toBe(4);
    expect(stats.avgMs).toBeCloseTo(25);
    expect(stats.maxMs).toBe(40);
    expect(stats.lastMs).toBe(40);
    expect(stats.overBudget).toBe(3);
    expect(stats.fps).toBeCloseTo(40);
  });
});
