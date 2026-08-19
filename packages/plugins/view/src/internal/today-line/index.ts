// docs/specs/plugins/view.md
/**
 * The today-line module of `stargantt.view`.
 *
 * Draws a single vertical line across the chart body marking the start of the current day (in
 * UTC), moves it to the next day when the date rolls over, and — when a status date is configured
 * — a second, dashed line at that instant. The colors come from CSS custom properties, so the
 * lines follow light/dark theming the same way every other painted color does.
 *
 * It publishes no service and emits no event — the module does one thing: contribute a single
 * drawing pass to `renderer/layers`.
 */
import type { Disposable, PluginContext } from "@stargantt/core";
import { MS_DAY, alignHalfPixel, startOfUtcDay } from "@stargantt/sdk";
import type { LayerContribution, RenderModule, Viewport } from "../render/index";
import type { ThemeService } from "../theme/index";
import type { TimelineService } from "../timeline/index";

/* ------------------------------------------------------------------ *
 * Constants
 * ------------------------------------------------------------------ */

/** Identifies this module's contribution to `renderer/layers`, and its `claimOrder` key. */
const LAYER_ID = "view:today-line";

// docs/specs/plugins/view.md — `zIndex: 55` is the claimOrder value: above the background grid and
// below the task-bars layer (which paints at 60), so the today line sits under a bar crossing it.
const LAYER_Z_INDEX = 55;

// docs/specs/plugins/view.md
// the consumer pattern is `theme.get(token) || FALLBACK`, and the fallback is the token's own
// light-mode value (docs/specs/plugins/view.md) so an unstyled host still sees a today line.
const TOKEN = "--sg-today-line";
const FALLBACK_COLOR = "#ea580c";

// docs/specs/plugins/view.md — the status line's own token and its
// light-mode fallback (consumer pattern). A blue hue, deliberately distinct from the today
// line's red, and the dash pattern below distinguishes the two lines beyond color alone.
const STATUS_TOKEN = "--sg-status-line";
const STATUS_FALLBACK_COLOR = "#2f6fd6";
const STATUS_DASH: readonly number[] = [4, 3];

/* ------------------------------------------------------------------ *
 * Plugin
 * ------------------------------------------------------------------ */

/** Creates the today-line module: one contributed pass over the main canvas. */
export function createTodayLineModule(
  ctx: PluginContext,
  statusDateMs: number | undefined,
  render: RenderModule,
  theme: ThemeService,
  scale: TimelineService,
): void {

  /* --- §3 `renderer/layers` contribution ------------------------------ */

  // docs/specs/plugins/view.md — the current UTC day's start,
  // recomputed only when the rollover timer fires (or at setup), not on every paint: `draw` runs
  // once per animation frame, and neither `Date.now()` nor the `Date` object `startOfUtcDay`
  // built from it needs reallocating that often for a value that changes once every 24 hours.
  let todayStart = startOfUtcDay(Date.now());

  function strokeVertical(
    g: CanvasRenderingContext2D,
    vp: Readonly<Viewport>,
    t: number,
    color: string,
    dash: readonly number[],
  ): void {
    const x = alignHalfPixel(scale.tToX(t) - vp.scrollLeft);
    if (x < 0 || x > vp.width) return;
    g.save();
    g.strokeStyle = color;
    g.lineWidth = 1;
    g.setLineDash(dash as number[]);
    g.beginPath();
    g.moveTo(x, 0);
    g.lineTo(x, vp.height);
    g.stroke();
    g.restore();
  }

  function draw(g: CanvasRenderingContext2D, vp: Readonly<Viewport>): void {
    // Self-correction for a throttled tab, a suspended machine or an adjusted clock: the rollover
    // timer may fire late (or the arming instant may predate a clock jump), so a stale cached day
    // is repaired here with one comparison per frame — no `Date` allocation on the common path.
    if (Date.now() >= todayStart + MS_DAY) todayStart = startOfUtcDay(Date.now());
    // docs/specs/plugins/view.md — the status line paints first, so
    // where the two coincide the solid today line is the one on top.
    if (statusDateMs !== undefined) {
      // consumer pattern, status line's own token.
      strokeVertical(g, vp, statusDateMs, theme.get(STATUS_TOKEN) || STATUS_FALLBACK_COLOR, STATUS_DASH);
    }
    // docs/specs/plugins/view.md — consumer pattern.
    strokeVertical(g, vp, todayStart, theme.get(TOKEN) || FALLBACK_COLOR, []);
  }

  // docs/specs/plugins/view.md — the order is arbitrated in code rather than by a table in a
  // document; the claim and the contribution carry the same key and the same number.
  ctx.claimOrder("renderer/layers", LAYER_ID, LAYER_Z_INDEX);
  const layer: LayerContribution = { id: LAYER_ID, zIndex: LAYER_Z_INDEX, draw };
  ctx.contribute("renderer/layers", layer);

  // No `renderer/hitTest` contribution: the line is pure decoration (§2).

  /* --- §3 date-rollover timer, ctx.own-registered --------------------- */

  // docs/specs/plugins/view.md
  // §1.1/§1.7 — armed for the next UTC midnight and re-armed on every fire, so the line never
  // shows a stale day once the timer has fired. Not a `setInterval`: the interval between two
  // UTC midnights is always exactly 86 400 000 ms in UTC (no DST to account for), but re-deriving
  // "next midnight" from `Date.now()` on every fire keeps the schedule correct even if the host
  // clock is adjusted or the tab was suspended.
  // A single owned disposable clears whichever timeout is currently armed: re-arming only swaps
  // `timeoutId`, so the core's ownership list stays a fixed size no matter how many days elapse.
  let timeoutId: ReturnType<typeof globalThis.setTimeout> | undefined;
  const disposable: Disposable = {
    dispose: () => {
      if (timeoutId !== undefined) globalThis.clearTimeout(timeoutId);
      timeoutId = undefined;
    },
  };
  ctx.own(disposable);

  function armNextMidnight(): void {
    const now = Date.now();
    const next = startOfUtcDay(now) + MS_DAY;
    const delay = next - now;
    timeoutId = globalThis.setTimeout(() => {
      timeoutId = undefined;
      todayStart = startOfUtcDay(Date.now());
      render.invalidate("main");
      armNextMidnight();
    }, delay);
  }
  armNextMidnight();
}
