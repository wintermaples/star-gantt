/**
 * Hostless unit tests for the invalidate/paint clock: one pass per frame, the timer fallback, the
 * dirty claim and cancellation on disposal.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFrameLoop } from "../../src/internal/render/frame";
import type { CanvasLayer } from "../../src/internal/render/index";
import { installDom } from "../_utils/index";

let dom: ReturnType<typeof installDom> | null = null;

afterEach(() => {
  dom?.restore();
  dom = null;
  vi.useRealTimers();
});

describe("createFrameLoop", () => {
  it("coalesces many invalidations into a single frame", () => {
    dom = installDom();
    const run = vi.fn();
    const loop = createFrameLoop(run);

    loop.invalidate("main");
    loop.invalidate("main");
    loop.invalidate("overlay");
    loop.invalidateAll();

    expect(run).not.toHaveBeenCalled();
    expect(dom.pendingFrames()).toBe(1);
    expect(dom.flushFrames()).toBe(1);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("schedules the next pass again once the frame callback has run", () => {
    dom = installDom();
    const loop = createFrameLoop(() => {});
    loop.invalidate("main");
    dom.flushFrames();
    loop.invalidate("main");
    expect(dom.pendingFrames()).toBe(1);
  });

  it("starts with all three layers dirty, and claiming clears the flag", () => {
    dom = installDom();
    const loop = createFrameLoop(() => {});
    for (const name of ["background", "main", "overlay"] as CanvasLayer[]) {
      expect(loop.claimDirty(name)).toBe(true);
      expect(loop.claimDirty(name)).toBe(false);
    }
  });

  it("marks only the invalidated layer dirty", () => {
    dom = installDom();
    const loop = createFrameLoop(() => {});
    for (const name of ["background", "main", "overlay"] as CanvasLayer[]) loop.claimDirty(name);

    loop.invalidate("overlay");
    expect(loop.claimDirty("background")).toBe(false);
    expect(loop.claimDirty("main")).toBe(false);
    expect(loop.claimDirty("overlay")).toBe(true);
  });

  it("ignores an unknown layer name entirely — no dirt, no frame", () => {
    dom = installDom();
    const loop = createFrameLoop(() => {});
    for (const name of ["background", "main", "overlay"] as CanvasLayer[]) loop.claimDirty(name);

    loop.invalidate("side" as CanvasLayer);
    expect(dom.pendingFrames()).toBe(0);
    expect(loop.claimDirty("main")).toBe(false);
  });

  it("schedules a pass that dirties nothing, for hover-only frames", () => {
    dom = installDom();
    const run = vi.fn();
    const loop = createFrameLoop(run);
    for (const name of ["background", "main", "overlay"] as CanvasLayer[]) loop.claimDirty(name);

    loop.schedule();
    dom.flushFrames();
    expect(run).toHaveBeenCalledTimes(1);
    expect(loop.claimDirty("main")).toBe(false);
  });

  it("falls back to a ~frame timer where there is no requestAnimationFrame", () => {
    vi.useFakeTimers();
    dom = installDom({ raf: false });
    const run = vi.fn();
    const loop = createFrameLoop(run);

    loop.invalidate("main");
    loop.invalidate("overlay");
    expect(run).not.toHaveBeenCalled();

    vi.advanceTimersByTime(16);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("flush() runs the pass on the calling stack, without a frame", () => {
    dom = installDom();
    const run = vi.fn();
    const loop = createFrameLoop(run);

    loop.invalidateAll();
    loop.flush();

    expect(run).toHaveBeenCalledTimes(1);
  });

  it("flush() cancels the pass it just covered, so the run does not happen twice", () => {
    dom = installDom();
    const claimed: boolean[] = [];
    const loop = createFrameLoop(() => claimed.push(loop.claimDirty("main")));

    loop.invalidateAll();
    loop.flush();
    expect(claimed).toEqual([true]);

    // The whole pass — not only the dirty-gated compositing — must not run a second time for the
    // same state: the rest of it (overlay sync, hover, scrollbars, prefetch) is not dirty-gated.
    expect(dom.pendingFrames()).toBe(0);
    expect(dom.flushFrames()).toBe(0);
    expect(claimed).toEqual([true]);
  });

  it("flush() cancels the pending timer fallback too", () => {
    vi.useFakeTimers();
    dom = installDom({ raf: false });
    const run = vi.fn();
    const loop = createFrameLoop(run);

    loop.invalidateAll();
    loop.flush();
    vi.advanceTimersByTime(100);

    expect(run).toHaveBeenCalledTimes(1);
  });

  it("schedules again after a flush", () => {
    dom = installDom();
    const run = vi.fn();
    const loop = createFrameLoop(run);
    loop.flush();

    loop.invalidate("main");

    expect(dom.pendingFrames()).toBe(1);
    expect(dom.flushFrames()).toBe(1);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("flush() from inside the pass is ignored — no nested run", () => {
    dom = installDom();
    let depth = 0;
    let maxDepth = 0;
    const run = vi.fn(() => {
      depth += 1;
      maxDepth = Math.max(maxDepth, depth);
      loop.flush();
      depth -= 1;
    });
    const loop = createFrameLoop(run);

    loop.flush();

    expect(run).toHaveBeenCalledTimes(1);
    expect(maxDepth).toBe(1);
  });

  it("flush() runs without requestAnimationFrame too", () => {
    vi.useFakeTimers();
    dom = installDom({ raf: false });
    const run = vi.fn();
    const loop = createFrameLoop(run);

    loop.invalidateAll();
    loop.flush();

    expect(run).toHaveBeenCalledTimes(1);
  });

  it("flush() after disposal is a no-op", () => {
    dom = installDom();
    const run = vi.fn();
    const loop = createFrameLoop(run);
    loop.invalidateAll();
    loop.dispose();

    loop.flush();

    expect(run).not.toHaveBeenCalled();
  });

  it("cancels a pending frame on disposal", () => {
    dom = installDom();
    const run = vi.fn();
    const loop = createFrameLoop(run);
    loop.invalidate("main");
    loop.dispose();

    expect(dom.cancelledFrames()).toBe(1);
    expect(dom.flushFrames()).toBe(0);
    expect(run).not.toHaveBeenCalled();
  });

  it("cancels a pending timer fallback on disposal", () => {
    vi.useFakeTimers();
    dom = installDom({ raf: false });
    const run = vi.fn();
    const loop = createFrameLoop(run);
    loop.invalidate("main");
    loop.dispose();

    vi.advanceTimersByTime(100);
    expect(run).not.toHaveBeenCalled();
  });
});
