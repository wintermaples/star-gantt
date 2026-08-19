// docs/specs/plugins/scheduling.md §7.3 — bar recoloring (`taskbars/style`) and the color-independent
// outline + negative-float warning glyph (`taskbars/overlays`). Hostless: every canvas and lookup is
// injected. Split out of an earlier combined `internal/paint.ts` / `index.ts`, per this package's
// §13 file plan (the style provider + outline/glyph overlay, split out of the combined index/paint
// files).
import type { BarOverlayRenderer, BarStyleProvider } from "@stargantt/plugin-task-bars";
import type { CriticalPathAnalysis, Criticality } from "./analysis";
import type { ColorResolver } from "./colors";

export function classColor(colors: ColorResolver, cls: Criticality): string {
  switch (cls) {
    case "critical":
      return colors.critical();
    case "nearCritical":
      return colors.nearCritical();
    case "negativeFloat":
      return colors.negativeFloat();
    default: {
      const never: never = cls;
      return never;
    }
  }
}

/** `taskbars/style` provider: recolors classified bars; declines every other task (§7.3). */
export function createStyleProvider(
  analysis: () => CriticalPathAnalysis,
  colors: ColorResolver,
): BarStyleProvider {
  return (task) => {
    const cls = analysis().classes.get(task.id);
    return cls === undefined ? undefined : { color: classColor(colors, cls) };
  };
}

/**
 * `taskbars/overlays` renderer: a 2px inset outline in the class color around every classified bar
 * — the color-independent shape cue — plus the warning triangle on negative-float bars (§7.3).
 */
export function createBarOverlay(
  analysis: () => CriticalPathAnalysis,
  colors: ColorResolver,
): BarOverlayRenderer {
  return (g, bar) => {
    const cls = analysis().classes.get(bar.id);
    if (cls === undefined) return;
    const color = classColor(colors, cls);

    g.strokeStyle = color;
    g.lineWidth = 2;
    g.strokeRect(bar.x + 1, bar.y + 1, bar.width - 2, bar.height - 2);

    if (cls !== "negativeFloat") return;
    // Warning glyph: a filled triangle with a bang cut-out, over a white halo so it reads on any
    // fill; sized to the bar and pinned at the bar's left inside edge.
    const size = Math.min(bar.height - 4, 14);
    if (size < 8) return;
    const cx = bar.x + 4 + size / 2;
    const top = bar.y + (bar.height - size) / 2;
    g.beginPath();
    g.moveTo(cx, top - 1.5);
    g.lineTo(cx + size / 2 + 1.5, top + size + 1.5);
    g.lineTo(cx - size / 2 - 1.5, top + size + 1.5);
    g.closePath();
    g.fillStyle = "#ffffff";
    g.fill();
    g.beginPath();
    g.moveTo(cx, top);
    g.lineTo(cx + size / 2, top + size);
    g.lineTo(cx - size / 2, top + size);
    g.closePath();
    g.fillStyle = color;
    g.fill();
    g.fillStyle = "#ffffff";
    g.fillRect(cx - 1, top + size * 0.3, 2, size * 0.4);
    g.fillRect(cx - 1, top + size * 0.78, 2, 2);
  };
}
