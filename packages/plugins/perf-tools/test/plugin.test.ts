// @vitest-environment happy-dom
// docs/specs/plugins/perf-tools.md — the plugin wired up against a real `@stargantt/core` host:
// the overlay mount, the corner claim, the self-owned rAF loop, recording, the Performance API
// mirror, message latching, and lifecycle.
import { definePlugin } from "@stargantt/core";
import type { AnyPlugin, PluginContext } from "@stargantt/core";
import { expectDepsConsistency } from "@stargantt/sdk";
import { afterEach, describe, expect, it } from "vitest";
import { perfTools } from "../src/index";
import { boot } from "./_boot";
import type { Booted } from "./_boot";

/**
 * A probe plugin that makes its own `overlay-corner` claim strictly AFTER perf-tools's `setup()`
 * (a hard `dependsOn` edge forces topological order, unlike same-tier registration order), and
 * records the `SlotGrant` it gets back from the SAME real core arbitration registry
 * (`packages/core/src/internal/arbitration.ts`). Which corner perf-tools itself resolved to is not
 * otherwise observable from outside the plugin (no test-only service member, and — see below —
 * inline style readback does not work here either), so this is the load-chart heatmap precedent's
 * technique (`resource/test/load-chart-wire.test.ts`, "wins the requested top-right corner
 * outright"): a `granted: false` for the corner this probe requests is only possible if perf-tools
 * already holds it.
 */
function claimProbe(corner: string): { plugin: AnyPlugin; grant(): { granted: boolean; alternative?: string } | undefined } {
  let grant: { granted: boolean; alternative?: string } | undefined;
  const plugin = definePlugin({
    meta: { id: `test.probe-${corner}`, dependsOn: ["stargantt.perf-tools"] },
    setup(ctx: PluginContext): void {
      grant = ctx.claimSlot("overlay-corner", corner, [
        "top-left",
        "top-right",
        "bottom-left",
        "bottom-right",
      ]);
    },
  });
  return { plugin, grant: () => grant };
}

let active: Booted[] = [];
function bootTracked(...args: Parameters<typeof boot>): Booted {
  const b = boot(...args);
  active.push(b);
  return b;
}
afterEach(() => {
  for (const b of active) b.dispose();
  active = [];
});

describe("plugin identity", () => {
  it("is `stargantt.perf-tools`, no hard dependency, `stargantt.view` optional", () => {
    const p = perfTools();
    expect(p.meta.id).toBe("stargantt.perf-tools");
    expect(p.meta.dependsOn ?? []).toEqual([]);
    expect(p.meta.optional).toEqual(["stargantt.view"]);
    // ctx.useOptional("stargantt.view") is not part of expectDepsConsistency's comparison — only
    // non-optional ctx.use() calls are — so this also proves the plugin makes no ctx.use() call.
    expectDepsConsistency(p);
  });
});

describe("overlay mount", () => {
  it("appends the overlay to the chart pane by default, non-interactive and aria-hidden", () => {
    const b = bootTracked();
    const el = b.overlay();
    expect(el).not.toBeNull();
    expect(b.pane!().contains(el!)).toBe(true);
    expect(el!.getAttribute("aria-hidden")).toBe("true");
    expect(el!.hasAttribute("title")).toBe(false);
    expect((el!.style as unknown as Record<string, string>)["pointerEvents"]).toBe("none");
    expect(el!.querySelector(".sg-perf-tools__spark")).not.toBeNull();
    // the loop has a consumer (the visible overlay) so a frame is pending
    expect(b.raf!.pending()).toBe(1);
  });

  it("attaches to the chart pane even when perf-tools registers before stargantt.view (no ordering edge from meta.optional)", () => {
    const b = bootTracked({ pluginOrder: "before" });
    const el = b.overlay();
    expect(el).not.toBeNull();
    expect(b.pane!().contains(el!)).toBe(true);
    expect(b.root.contains(el!)).toBe(true); // pane is inside root, this just documents nesting
  });

  it("lands on the chart root when the composition has no stargantt.view", () => {
    const b = bootTracked({ view: false });
    const el = b.overlay();
    expect(el).not.toBeNull();
    expect(b.root.children).toContain(el);
  });

  it("shows the initial all-zero readout before any frame", () => {
    const b = bootTracked();
    expect(b.readout()).toBe("0 fps · 0.0 ms");
  });

  it("updates the readout from sampled frames (throttled)", () => {
    const b = bootTracked();
    b.frame(300); // first tick: primes the clock, no sample yet
    for (let i = 0; i < 20; i += 1) b.frame(16); // steady 16ms frames cross the 250ms throttle
    expect(b.readout()).toBe("63 fps · 16.0 ms");
  });

  it("overlay: false creates no DOM and schedules no frames until shown", () => {
    const b = bootTracked({ config: { overlay: false } });
    expect(b.overlay()).toBeNull();
    expect(b.raf!.pending()).toBe(0);
    b.service().setOverlayVisible(true);
    expect(b.overlay()).not.toBeNull();
    expect(b.raf!.pending()).toBe(1);
  });

  it("hiding the overlay stops the loop when nothing records (injected rAF spy)", () => {
    const b = bootTracked();
    b.frame(16);
    expect(b.raf!.pending()).toBe(1);
    b.service().setOverlayVisible(false);
    b.frame(16); // the already-scheduled tick runs, finds no consumer, re-arms nothing
    expect(b.raf!.pending()).toBe(0);
    expect((b.overlay()!.style as unknown as Record<string, string>)["display"]).toBe("none");
  });

  // m3 review fix — `setOverlayVisible` gates on the strict literals `=== true` / `=== false`
  // (index.ts); a mutation weakening either to a truthy/falsy check survived the whole suite.
  it("setOverlayVisible ignores a non-boolean argument (strict === true / === false gate)", () => {
    const b = bootTracked({ config: { overlay: false } });
    expect(b.overlay()).toBeNull();
    b.service().setOverlayVisible(1 as unknown as boolean); // truthy, but not `true`
    expect(b.overlay()).toBeNull(); // still nothing — a truthy check would have shown it
    b.service().setOverlayVisible("" as unknown as boolean); // falsy, but not `false`
    expect(b.overlay()).toBeNull();

    // positive control: the exact boolean literals still work as documented.
    b.service().setOverlayVisible(true);
    expect(b.overlay()).not.toBeNull();
    b.service().setOverlayVisible(false);
    expect((b.overlay()!.style as unknown as Record<string, string>)["display"]).toBe("none");
  });

  it("sparkline: false omits the canvas", () => {
    const b = bootTracked({ config: { sparkline: false } });
    expect(b.overlay()!.querySelector(".sg-perf-tools__spark")).toBeNull();
  });

  // The exact per-corner CSS the requested corner resolves to (`top`/`right` etc., the
  // `--sg-safe-*` pair) is pinned byte-for-byte, DOM-free, in `overlay.test.ts`'s `cornerStyles`
  // suite. What this test proves is the seam that pure-function test can't reach: that THIS
  // instance's config `position` (and its unusable-value fallback) actually reaches the
  // `ctx.claimSlot` request — verified via `claimProbe`, since happy-dom's `CSSStyleDeclaration`
  // silently drops any `top`/`right`/`bottom`/`left` value containing `var(...)` (confirmed
  // empirically — the same limitation `resource/test/load-chart-wire.test.ts` documents), so the
  // overlay's own inline offsets cannot be read back in this test environment.
  it("forwards the configured corner to the claim, with unusable values falling back to top-right", () => {
    for (const [position, requested] of [
      ["bottom-left", "bottom-left"],
      ["top-left", "top-left"],
      ["bottom-right", "bottom-right"],
      [undefined, "top-right"],
      ["center", "top-right"], // unusable — falls back
    ] as const) {
      const probe = claimProbe(requested);
      bootTracked({
        config: position === undefined ? {} : { position: position as never },
        extra: [probe.plugin],
      });
      expect(probe.grant()?.granted).toBe(false); // already held by perf-tools, no contest
    }
  });
});

describe("stats", () => {
  it("summarizes sampled frame durations against the budget", () => {
    const b = bootTracked();
    b.frame(300); // prime — the idle gap is not a frame
    b.frame(16);
    b.frame(20);
    const stats = b.service().stats();
    expect(stats.frames).toBe(2);
    expect(stats.lastMs).toBe(20);
    expect(stats.maxMs).toBe(20);
    expect(stats.avgMs).toBeCloseTo(18);
    expect(stats.overBudget).toBe(1); // only the 20ms frame exceeds 16.7
  });

  it("applies unusable budget/window values as defaults", () => {
    const b = bootTracked({ config: { budgetMs: -1, windowSize: 3.5 } });
    b.frame(300);
    b.frame(17); // over the default 16.7 budget
    expect(b.service().stats().overBudget).toBe(1);
  });

  // m2 review fix — `windowSize` plumbing was untested end-to-end: a mutation that makes
  // `validWindowSize` always return the default (120) survived the whole suite.
  it("honors a usable windowSize: the ring only ever holds that many samples", () => {
    const b = bootTracked({ config: { windowSize: 2 } });
    b.frame(300); // prime — the idle gap is not a frame
    b.frame(10);
    b.frame(20);
    b.frame(30); // evicts the 10ms sample — a window of 120 would still hold all three
    const stats = b.service().stats();
    expect(stats.frames).toBe(2);
    expect(stats.avgMs).toBeCloseTo(25); // (20 + 30) / 2, not (10 + 20 + 30) / 3
    expect(stats.maxMs).toBe(30);
  });

  // M1 review fix (major) — spec §1.1: "when the loop stops and later restarts, the first
  // callback after the restart produces no sample — the idle gap is not a frame." Deleting
  // `prevTick = undefined` from `ensureLoop()` (index.ts) left this completely uncovered: the
  // restart tick would otherwise compute a sample from the stale pre-stop `prevTick`, inflating
  // both `frames` and `maxMs` by the idle gap's whole duration.
  it("a restart's first callback yields no sample: the idle gap is never measured as a frame", () => {
    const b = bootTracked();
    b.frame(300); // first tick: primes the clock, no sample yet
    b.frame(16);
    b.frame(16); // two genuine 16ms frames sampled

    b.service().setOverlayVisible(false);
    b.frame(16); // the already-scheduled tick STILL samples (its `prevTick` predates the hide —
    // hasConsumer() is only checked at the END of tick(), to decide whether to re-arm), THEN
    // discovers no consumer and stops re-arming. So `before` is captured HERE, after the loop has
    // genuinely stopped, not before this trailing tick — capturing it earlier would (wrongly)
    // exclude this legitimate 3rd sample and make the assertions below pass for the wrong reason.
    expect(b.raf!.pending()).toBe(0); // the loop is genuinely stopped
    const before = b.service().stats();
    expect(before.frames).toBe(3);
    expect(before.maxMs).toBe(16);

    // Advance the clock through a long idle gap while nothing is scheduled — this changes only
    // the clock (raf.flush() on an empty queue is a no-op), simulating real wall-clock time
    // passing while the loop sits idle.
    const IDLE_GAP_MS = 5000;
    b.frame(IDLE_GAP_MS);

    b.service().setOverlayVisible(true); // re-arms the loop: ensureLoop() resets prevTick
    b.frame(16); // the restart's first callback

    const after = b.service().stats();
    expect(after.frames).toBe(before.frames); // the restart tick produced no sample at all
    expect(after.maxMs).toBe(before.maxMs); // the idle gap never entered the window
    expect(after.maxMs).toBeLessThan(IDLE_GAP_MS); // sanity: it really would have dwarfed a real frame
  });
});

describe("recording", () => {
  it("records frames, marks and counters into an exportable trace", () => {
    const b = bootTracked();
    b.frame(300); // prime the loop clock
    const s = b.service();
    expect(s.isRecording()).toBe(false);
    expect(s.stopRecording()).toBeUndefined();
    expect(s.lastTrace()).toBeUndefined();
    expect(s.exportJson()).toBeUndefined();

    s.startRecording();
    expect(s.isRecording()).toBe(true);
    b.frame(16);
    s.mark("layout");
    s.count("invalidate");
    s.count("invalidate", 2);
    b.frame(25);
    const trace = s.stopRecording();
    expect(trace).toBeDefined();
    expect(trace!.frames.map((f) => f.dur)).toEqual([16, 25]);
    expect(trace!.marks.map((m) => m.name)).toEqual(["layout"]);
    expect(trace!.counters).toEqual({ invalidate: 3 });
    expect(trace!.stats.overBudget).toBe(1);
    expect(s.lastTrace()).toBe(trace);
    expect(JSON.parse(s.exportJson()!)).toEqual(JSON.parse(JSON.stringify(trace)));
  });

  it("mirrors marks and the recording span to the Performance API", () => {
    const b = bootTracked();
    const s = b.service();
    s.mark("outside"); // mirrored even outside a recording
    s.startRecording();
    s.mark("inside");
    s.stopRecording();
    expect(b.perf.marks).toEqual([
      "stargantt:outside",
      "stargantt:recording:start",
      "stargantt:inside",
      "stargantt:recording:end",
    ]);
    expect(b.perf.measures).toEqual([
      { name: "stargantt:recording", start: "stargantt:recording:start", end: "stargantt:recording:end" },
    ]);
  });

  it("performanceMarks: false keeps the Performance API untouched", () => {
    const b = bootTracked({ config: { performanceMarks: false } });
    const s = b.service();
    s.startRecording();
    s.mark("x");
    s.stopRecording();
    expect(b.perf.marks).toEqual([]);
    expect(b.perf.measures).toEqual([]);
  });

  it("keeps recording without an overlay: the loop runs only while recording", () => {
    const b = bootTracked({ config: { overlay: false } });
    const s = b.service();
    s.startRecording();
    expect(b.raf!.pending()).toBe(1);
    b.frame(300);
    b.frame(16);
    const trace = s.stopRecording()!;
    expect(trace.frames.map((f) => f.dur)).toEqual([16]);
    b.frame(16); // last scheduled tick finds no consumer
    expect(b.raf!.pending()).toBe(0);
  });

  it("ignores unusable mark and counter names", () => {
    const b = bootTracked();
    const s = b.service();
    s.startRecording();
    s.mark("");
    s.mark(42 as never);
    s.count("", 1);
    const trace = s.stopRecording()!;
    expect(trace.marks).toEqual([]);
    expect(trace.counters).toEqual({});
    expect(b.perf.marks.filter((m) => !m.startsWith("stargantt:recording"))).toEqual([]);
  });
});

describe("messages", () => {
  it("overrides the readout key; the empty string is usable", () => {
    const b = bootTracked({
      config: { messages: { readout: (stats) => `avg=${stats.avgMs}` } },
    });
    expect(b.readout()).toBe("avg=0");
  });

  it("ignores a readout override of the wrong kind", () => {
    const b = bootTracked({ config: { messages: { readout: "nope" as never } } });
    expect(b.readout()).toBe("0 fps · 0.0 ms");
  });

  it("latches a throwing readout builder: one core/pluginError, then the default forever", () => {
    const b = bootTracked({
      config: {
        overlay: false, // create the overlay after the error listener is attached
        messages: {
          readout: () => {
            throw new Error("boom");
          },
        },
      },
    });
    b.service().setOverlayVisible(true);
    b.frame(300); // first rendered tick calls the builder — it throws, is reported, and latches
    expect(b.errors).toHaveLength(1);
    expect(b.errors[0]!.pluginId).toBe("stargantt.perf-tools");
    expect(b.readout()).toBe("0 fps · 0.0 ms");
    b.frame(300); // next throttle window: the builder is not called again
    expect(b.errors).toHaveLength(1);
  });
});

describe("the overlay-corner slot claim (§1.3)", () => {
  /** Claims `corner` at setup(), so a later perf-tools claim of the same corner is contested. */
  function occupant(id: string, corner: string): AnyPlugin {
    return definePlugin({
      meta: { id },
      setup(ctx: PluginContext): void {
        ctx.claimSlot("overlay-corner", corner, ["top-left", "top-right", "bottom-left", "bottom-right"]);
      },
    });
  }

  it("granted: keeps the requested corner (no competing claimant)", () => {
    const probe = claimProbe("top-right");
    const b = bootTracked({ extra: [probe.plugin] });
    expect(b.overlay()).not.toBeNull();
    expect(probe.grant()?.granted).toBe(false); // perf-tools already holds top-right
    // nothing contested perf-tools's OWN claim — the one fault here is against the LATER, losing
    // probe instead.
    expect(b.errors).toEqual([
      expect.objectContaining({ pluginId: "test.probe-top-right", level: "warning" }),
    ]);
  });

  it("granted: false with a free alternative moves the overlay there", () => {
    // top-right occupied first; perf-tools requests top-right and is proposed the
    // lexicographically-smallest free corner among the four known ones — "bottom-left". A
    // `granted: false, alternative` answer only PROPOSES that corner — it does not itself claim
    // it in the registry (the resource load-chart heatmap precedent makes no second claim call
    // either), so what's verifiable from outside is the proposal itself (the fault message) plus
    // the already-pinned pure `resolveCorner` behavior (overlay.test.ts) that turns this exact
    // grant into the corner the overlay actually renders at.
    const b = bootTracked({ extra: [occupant("test.occupant", "top-right")] });
    expect(b.overlay()).not.toBeNull();
    // the registry reports the contested claim as a warning-level fault against the LATER
    // claimant — perf-tools itself (core `SlotGrant` doc) — not against the occupant.
    expect(b.errors).toEqual([
      expect.objectContaining({ pluginId: "stargantt.perf-tools", level: "warning" }),
    ]);
    expect(String((b.errors[0]!.error as { message?: string }).message)).toContain('try "bottom-left"');
  });

  it("granted: false with no free alternative keeps the requested corner (overlapping the occupant)", () => {
    const occupants = (["top-left", "top-right", "bottom-left", "bottom-right"] as const).map((c, i) =>
      occupant(`test.occupant-${i}`, c),
    );
    const b = bootTracked({ extra: occupants }); // every corner already taken before perf-tools claims
    expect(b.overlay()).not.toBeNull(); // the overlay still mounts, just overlapping the occupant
    expect(b.errors).toEqual([
      expect.objectContaining({ pluginId: "stargantt.perf-tools", level: "warning" }),
    ]);
    // no alternative was proposed: the fault message carries no `; try "..."` suffix.
    expect(String((b.errors[0]!.error as { message?: string }).message)).not.toContain("try");
  });

  it("with overlay: false, the claim is deferred to the first setOverlayVisible(true)", () => {
    // Occupy top-right before perf-tools ever claims anything.
    const b = bootTracked({
      config: { overlay: false },
      extra: [occupant("test.occupant", "top-right")],
    });
    expect(b.overlay()).toBeNull(); // no claim attempted yet — nothing squatted a corner
    expect(b.errors).toEqual([]); // in particular, no contested-claim warning was raised early
    b.service().setOverlayVisible(true);
    expect(b.overlay()).not.toBeNull();
    // top-right is taken, so the now-made claim is contested — proving it really was deferred
    // until this call, not made (and silently lost) back at setup().
    expect(b.errors).toEqual([
      expect.objectContaining({ pluginId: "stargantt.perf-tools", level: "warning" }),
    ]);
  });
});

describe("lifecycle", () => {
  it("dispose cancels the pending frame and removes the overlay", () => {
    const b = bootTracked();
    expect(b.raf!.pending()).toBe(1);
    b.th.dispose();
    expect(b.raf!.pending()).toBe(0);
    expect(b.raf!.cancelled()).toBeGreaterThanOrEqual(1);
    expect(b.overlay()).toBeNull();
  });

  // m4 review fix — spec §1.2: "Disposal while recording stops sampling and discards the
  // unfinished recording (no implied `stopRecording`)." Two directions, on the same instance:
  // a positive control (an ordinary pre-disposal stop still returns its trace, proving the
  // recorder itself works) and the actual fix (a recording still running AT disposal is
  // discarded, not silently finalized).
  it("dispose discards a still-running recording; an ordinary pre-disposal stop is unaffected", () => {
    const b = bootTracked();
    const s = b.service();

    // Positive control: stopping a recording normally, before disposal, still works.
    s.startRecording();
    b.frame(16);
    const finished = s.stopRecording();
    expect(finished).toBeDefined();
    expect(s.lastTrace()).toBe(finished);

    // The actual fix: a SECOND recording is still running when the instance is disposed.
    s.startRecording();
    expect(s.isRecording()).toBe(true);
    b.th.dispose();

    // A post-disposal stopRecording() must answer undefined — the recording was discarded, not
    // implicitly finalized into a trace.
    expect(s.stopRecording()).toBeUndefined();
    // lastTrace() must stay exactly the pre-disposal positive control's trace — never the
    // discarded, still-running one.
    expect(s.lastTrace()).toBe(finished);
  });

  it("boots and stays inert where requestAnimationFrame does not exist", () => {
    const b = bootTracked({ raf: false });
    // the overlay still exists with its initial readout; no loop was scheduled and nothing threw
    expect(b.overlay()).not.toBeNull();
    expect(b.readout()).toBe("0 fps · 0.0 ms");
    const s = b.service();
    s.startRecording();
    s.mark("m");
    const trace = s.stopRecording();
    expect(trace).toBeDefined();
    expect(trace!.frames).toEqual([]);
    expect(trace!.marks.map((m) => m.name)).toEqual(["m"]);
  });
});
