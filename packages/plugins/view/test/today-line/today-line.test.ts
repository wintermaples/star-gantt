import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { normalizeViewConfig } from "../../src/config";
import { createTodayLineModule } from "../../src/internal/today-line/index";
import { boot, stubRenderModule, stubThemeService, stubTimelineService } from "./_boot";
import type { LayerContribution } from "../../src/internal/render/index";
import type { Disposable, PluginContext } from "@stargantt/core";

/**
 * A minimal recording `PluginContext`: captures which extension points were contributed to, every
 * `claimOrder` call, and every disposable handed to `ctx.own()`. Used to observe registrations that
 * a real boot stack offers no read-back API for.
 *
 * `createTodayLineModule` reads no service off `ctx` itself — `render`, `theme` and `scale` are
 * passed to it directly as arguments — so, unlike an ordinary plugin's `setup(ctx)`, this fake
 * needs no `ctx.use` stub at all.
 */
function recordingCtx(): {
  ctx: PluginContext;
  contributions: string[];
  claims: { scope: string; key: string; order: number }[];
  owned: Disposable[];
} {
  const contributions: string[] = [];
  const claims: { scope: string; key: string; order: number }[] = [];
  const owned: Disposable[] = [];
  const ctx = {
    contribute: (point: string) => void contributions.push(point),
    claimOrder: (scope: string, key: string, order: number) =>
      void claims.push({ scope, key, order }),
    own: (d: Disposable) => void owned.push(d),
  } as unknown as PluginContext;
  return { ctx, contributions, claims, owned };
}

const ONE_DAY_MS = 86_400_000;
// The origin is pinned at epoch 0 (see `boot`'s default), so "now" must stay close to the epoch
// for the drawn x to land inside the default 800px-wide viewport (day 15 ⇒ x = 600px, well within
// range). Noon UTC keeps the "not yet midnight" timer fixtures inside the same UTC day.
const NOON_UTC = Date.UTC(1970, 0, 15, 12, 0, 0);
const START_OF_DAY = Date.UTC(1970, 0, 15, 0, 0, 0);
// Far enough out that its x (day 20000 * 40px) lands well past the default 800px viewport.
const NOON_UTC_FAR_FUTURE = Date.UTC(2024, 0, 10, 12, 0, 0);
// Default `day` zoom level: 40px per day (per the shared boot helpers elsewhere in the repo).
const PX_PER_DAY = 40;

describe("today-line", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOON_UTC);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("draws a 1px vertical line at the start of the current UTC day", () => {
    const b = boot();
    b.paint();
    const g = b.main();
    const strokes = g.calls("stroke");
    expect(strokes.length).toBeGreaterThan(0);
    // origin pinned at epoch 0 ⇒ x = (START_OF_DAY / ONE_DAY_MS) * PX_PER_DAY.
    // +0.5: half-pixel alignment so a 1px stroke covers exactly one pixel.
    const expectedX = (START_OF_DAY / ONE_DAY_MS) * PX_PER_DAY + 0.5;
    const moves = g.calls("moveTo");
    expect(moves.length).toBeGreaterThan(0);
    const [lastMove] = moves.slice(-1);
    expect(lastMove?.args[0]).toBeCloseTo(expectedX, 5);
    expect(g.lineWidth).toBe(1);
  });

  it("draws nothing when the line falls outside the viewport", () => {
    vi.setSystemTime(NOON_UTC_FAR_FUTURE);
    const b = boot();
    b.paint();
    expect(b.main().calls("stroke").length).toBe(0);
  });

  it("falls back to #ea580c when the theme token is unset", () => {
    const b = boot();
    b.paint();
    // No `--sg-today-line` token is declared, so the theme stub reads "" for it — this exercises
    // the `theme.get(token) || FALLBACK` fallback branch.
    //
    // The stroke colour is read off the recorded `stroke` call rather than off the context
    // afterwards: a real 2d context's `restore()` puts `strokeStyle` back, so live state after a
    // save/restore-bracketed draw says nothing about what was painted.
    expect(b.main().calls("stroke").at(-1)?.stroke).toBe("#ea580c");
  });

  it("uses the theme token's value when it is set, not the fallback", () => {
    // Stub `getComputedStyle` so the theme stub actually resolves `--sg-today-line` to a real value
    // instead of hitting the `|| FALLBACK` branch. Without this, an implementation that hardcoded
    // #e23b3b and never consulted the theme service would pass every other test here. The harness
    // owns `globalThis.getComputedStyle`, so the token is declared through its token map rather
    // than by stubbing the global out from under it.
    const stubbed = "rgb(1, 2, 3)";
    const b = boot([], { tokens: { "--sg-today-line": stubbed } });
    b.paint();
    expect(b.main().calls("stroke").at(-1)?.stroke).toBe(stubbed);
  });

  it("contributes at zIndex 55 under the fixed id view:today-line, per the contract", () => {
    // Drives `createTodayLineModule` directly against a minimal fake `PluginContext`, sidestepping
    // the full boot stack: `renderer/layers` is a `collect` extension point with no public
    // read-back API once wired into a real renderer, so this is the most direct way to pin the
    // exact `LayerContribution` (id + zIndex) the module registers, and the matching `claimOrder`
    // call that arbitrates it.
    let captured: LayerContribution | undefined;
    const ctx = {
      contribute: (point: string, contribution: LayerContribution) => {
        if (point === "renderer/layers") captured = contribution;
      },
      claimOrder: () => {},
      own: () => {},
    } as unknown as PluginContext;

    createTodayLineModule(
      ctx,
      undefined,
      stubRenderModule([]),
      stubThemeService(({}) as HTMLElement),
      stubTimelineService(),
    );

    expect(captured?.id).toBe("view:today-line");
    expect(captured?.zIndex).toBe(55);
  });

  it("claims order 55 for view:today-line on the renderer/layers scope", () => {
    // The layer contribution and the claim carry the same key and number (the module's own
    // internal cross-check, per the contract); this pins the claim side of it, which — like the
    // contribution above — has no public read-back API once wired into a real renderer.
    const rec = recordingCtx();
    createTodayLineModule(
      rec.ctx,
      undefined,
      stubRenderModule([]),
      stubThemeService(({}) as HTMLElement),
      stubTimelineService(),
    );
    expect(rec.claims).toEqual([{ scope: "renderer/layers", key: "view:today-line", order: 55 }]);
  });

  it("contributes to renderer/layers only, never to renderer/hitTest", () => {
    // today-line boots cleanly with no other `renderer/hitTest` contributor in the stack, which
    // would be unreachable if the module itself silently contributed to that point too (a second
    // `first`-strategy contribution is legal and would not throw).
    const b = boot();
    b.paint();
    expect(b.gantt).toBeDefined();

    // Recording fake ctx: the module contributes exactly once, and only to `renderer/layers`.
    const rec = recordingCtx();
    createTodayLineModule(
      rec.ctx,
      undefined,
      stubRenderModule([]),
      stubThemeService(({}) as HTMLElement),
      stubTimelineService(),
    );
    expect(rec.contributions).toEqual(["renderer/layers"]);
  });

  it("registers a fixed number of owned disposables however often the timer re-arms", () => {
    // Regression: `armNextMidnight` used to `ctx.own()` a fresh disposable on every re-arm, so the
    // core's ownership list grew by one entry per elapsed day and never shrank.
    const rec = recordingCtx();
    const invalidated: string[] = [];
    createTodayLineModule(
      rec.ctx,
      undefined,
      stubRenderModule(invalidated),
      stubThemeService(({}) as HTMLElement),
      stubTimelineService(),
    );
    const afterSetup = rec.owned.length;
    expect(afterSetup).toBeGreaterThan(0);

    for (let day = 0; day < 5; day += 1) {
      vi.advanceTimersByTime(ONE_DAY_MS);
      expect(rec.owned.length).toBe(afterSetup);
    }

    // And the single registered disposable still cancels the currently armed timeout.
    const invalidations = invalidated.length;
    for (const d of rec.owned) d.dispose();
    vi.advanceTimersByTime(ONE_DAY_MS * 3);
    expect(invalidated.length).toBe(invalidations);
  });

  it("re-invalidates the main layer at the next UTC midnight and moves the line", () => {
    const b = boot();
    b.paint();
    // Spies on the render module's own handle, not the published `stargantt.view` service: the
    // module calls `render.invalidate("main")` on the exact object it was constructed with (see
    // `Booted.render`'s doc comment in `_boot.ts`).
    const invalidateSpy = vi.spyOn(b.render, "invalidate");

    const msUntilMidnight = START_OF_DAY + ONE_DAY_MS - NOON_UTC;
    vi.advanceTimersByTime(msUntilMidnight);

    expect(invalidateSpy).toHaveBeenCalledWith("main");

    b.paint();
    const g = b.main();
    const nextDayStart = START_OF_DAY + ONE_DAY_MS;
    const expectedX = (nextDayStart / ONE_DAY_MS) * PX_PER_DAY + 0.5;
    const moves = g.calls("moveTo");
    const [lastMove] = moves.slice(-1);
    expect(lastMove?.args[0]).toBeCloseTo(expectedX, 5);
  });

  it("re-arms for the following midnight after firing once", () => {
    const b = boot();
    b.paint();
    // Spies on the render module's own handle, not the published `stargantt.view` service: the
    // module calls `render.invalidate("main")` on the exact object it was constructed with (see
    // `Booted.render`'s doc comment in `_boot.ts`).
    const invalidateSpy = vi.spyOn(b.render, "invalidate");

    const msUntilFirstMidnight = START_OF_DAY + ONE_DAY_MS - NOON_UTC;
    vi.advanceTimersByTime(msUntilFirstMidnight);
    expect(invalidateSpy).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(ONE_DAY_MS);
    expect(invalidateSpy).toHaveBeenCalledTimes(2);
  });

  it("cancels the rollover timer on dispose", () => {
    const b = boot();
    b.paint();
    // Spies on the render module's own handle, not the published `stargantt.view` service: the
    // module calls `render.invalidate("main")` on the exact object it was constructed with (see
    // `Booted.render`'s doc comment in `_boot.ts`).
    const invalidateSpy = vi.spyOn(b.render, "invalidate");

    b.gantt.dispose();

    const msUntilMidnight = START_OF_DAY + ONE_DAY_MS - NOON_UTC;
    vi.advanceTimersByTime(msUntilMidnight + ONE_DAY_MS);
    expect(invalidateSpy).not.toHaveBeenCalled();
  });

  it("accepts an empty or omitted config, and the resulting undefined status date creates cleanly", () => {
    // Config normalization moved out of the module and into `normalizeViewConfig` (`config.ts`);
    // this is the current shape of the guarantee that an empty `TodayLineConfig` never throws —
    // an omitted or empty config resolves to no status date, and the module accepts that
    // resolved `undefined` cleanly.
    expect(normalizeViewConfig({}).todayLine).toEqual({ statusDateMs: undefined });
    expect(normalizeViewConfig({ todayLine: {} }).todayLine).toEqual({ statusDateMs: undefined });

    const rec = recordingCtx();
    expect(() =>
      createTodayLineModule(
        rec.ctx,
        undefined,
        stubRenderModule([]),
        stubThemeService(({}) as HTMLElement),
        stubTimelineService(),
      ),
    ).not.toThrow();
  });

  it("is never created when todayLine: false switches the pass off, per ViewConfig", () => {
    // `todayLine: false` replaces leaving the pass out of the composition entirely:
    // `normalizeViewConfig` maps it to `todayLine: undefined`, and the wiring then never calls
    // `createTodayLineModule` at all, so no layer is contributed and no rollover timer is armed.
    expect(normalizeViewConfig({ todayLine: false }).todayLine).toBeUndefined();

    const b = boot([], {}, { origin: 0 }, false);
    b.paint();
    expect(b.main().calls("stroke").length).toBe(0);

    // No timer was armed either: advancing well past several midnights invalidates nothing.
    // Spies on the render module's own handle, not the published `stargantt.view` service: the
    // module calls `render.invalidate("main")` on the exact object it was constructed with (see
    // `Booted.render`'s doc comment in `_boot.ts`).
    const invalidateSpy = vi.spyOn(b.render, "invalidate");
    vi.advanceTimersByTime(ONE_DAY_MS * 3);
    expect(invalidateSpy).not.toHaveBeenCalled();
  });

  describe("status-date line (default off)", () => {
    // Day 10 at 06:00 UTC — an instant deliberately off a day boundary, inside the 800px viewport.
    const STATUS_INSTANT = Date.UTC(1970, 0, 10, 6, 0, 0);
    const STATUS_X = (STATUS_INSTANT / ONE_DAY_MS) * PX_PER_DAY + 0.5;

    /** The strokes painted with a non-empty dash pattern, i.e. the status line's. */
    function dashedStrokes(b: ReturnType<typeof boot>) {
      return b.main().calls("stroke").filter((op) => op.dash.length > 0);
    }

    it("draws no second line and no dashed stroke by default", () => {
      const b = boot();
      b.paint();
      const strokes = b.main().calls("stroke");
      expect(strokes.length).toBe(1);
      expect(strokes[0]?.dash).toEqual([]);
    });

    it("draws a dashed 1px line at the exact configured instant (epoch ms), not day-snapped", () => {
      const b = boot([], {}, { origin: 0 }, { statusDate: STATUS_INSTANT });
      b.paint();
      const dashed = dashedStrokes(b);
      expect(dashed.length).toBe(1);
      expect(dashed[0]?.lineWidth).toBe(1);
      expect(dashed[0]?.dash).toEqual([4, 3]);
      // The moveTo preceding the dashed stroke carries the x; match via ops order.
      const ops = b.main().ops;
      const strokeIndex = ops.findIndex((o) => o.op === "stroke" && o.dash.length > 0);
      const move = ops.slice(0, strokeIndex).reverse().find((o) => o.op === "moveTo");
      expect(move?.args[0]).toBeCloseTo(STATUS_X, 5);
    });

    it("accepts a Date and a date-only ISO string (UTC midnight)", () => {
      for (const value of [new Date(STATUS_INSTANT), "1970-01-10T06:00:00Z"] as const) {
        const b = boot([], {}, { origin: 0 }, { statusDate: value });
        b.paint();
        expect(dashedStrokes(b).length).toBe(1);
      }
      const bIso = boot([], {}, { origin: 0 }, { statusDate: "1970-01-10" });
      bIso.paint();
      const ops = bIso.main().ops;
      const strokeIndex = ops.findIndex((o) => o.op === "stroke" && o.dash.length > 0);
      const move = ops.slice(0, strokeIndex).reverse().find((o) => o.op === "moveTo");
      expect(move?.args[0]).toBeCloseTo((Date.UTC(1970, 0, 10) / ONE_DAY_MS) * PX_PER_DAY + 0.5, 5);
    });

    it("silently ignores unusable values, per the extensible-but-empty TodayLineConfig", () => {
      const bad = [Number.NaN, Number.POSITIVE_INFINITY, new Date(Number.NaN), "not a date"];
      for (const value of bad) {
        const b = boot([], {}, { origin: 0 }, { statusDate: value as never });
        b.paint();
        expect(dashedStrokes(b).length).toBe(0);
        // The today line itself is unaffected.
        expect(b.main().calls("stroke").length).toBe(1);
      }
    });

    it("falls back to #2f6fd6 when --sg-status-line is unset, and honors the token when set", () => {
      const b = boot([], {}, { origin: 0 }, { statusDate: STATUS_INSTANT });
      b.paint();
      expect(dashedStrokes(b)[0]?.stroke).toBe("#2f6fd6");

      const themed = "rgb(9, 8, 7)";
      const b2 = boot([], { tokens: { "--sg-status-line": themed } }, { origin: 0 }, {
        statusDate: STATUS_INSTANT,
      });
      b2.paint();
      expect(dashedStrokes(b2)[0]?.stroke).toBe(themed);
    });

    it("paints the status line before the today line, so the solid line wins on overlap", () => {
      const b = boot([], {}, { origin: 0 }, { statusDate: STATUS_INSTANT });
      b.paint();
      const strokes = b.main().calls("stroke");
      expect(strokes.length).toBe(2);
      expect(strokes[0]?.dash).toEqual([4, 3]);
      expect(strokes[1]?.dash).toEqual([]);
    });

    it("skips the stroke when the status line falls outside the viewport", () => {
      const b = boot([], {}, { origin: 0 }, { statusDate: Date.UTC(2024, 0, 10) });
      b.paint();
      expect(dashedStrokes(b).length).toBe(0);
    });

    it("snapshots the status date at factory time: mutating the Date afterwards has no effect", () => {
      const d = new Date(STATUS_INSTANT);
      const b = boot([], {}, { origin: 0 }, { statusDate: d });
      // The factory has already run inside `boot`; a late mutation to an off-viewport instant
      // must not move (or hide) the line if the value was snapshotted.
      d.setTime(Date.UTC(2024, 0, 10));
      b.paint();
      expect(dashedStrokes(b).length).toBe(1);
    });
  });
});
