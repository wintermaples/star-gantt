// docs/specs/plugins/tracking.md §2.6/§2.16 — the progress-trend panel: a small canvas polyline of
// `percentComplete` over the recorded snapshots, plus an accessible per-snapshot text list built
// with `messages.trendLine`, and Close. Hostless: built off a host element and callbacks.
//
// Built on `sdk/dialog`'s `createDialog` and this area's own `line.ts`
// (`LinePoint`/`strokePolyline`) instead of a private copy.
import { createDialog } from "@stargantt/sdk";
import type { ProgressSnapshot } from "../../types";
import type { TrackingMessages } from "../messages";
import type { LinePoint } from "./line";
import { strokePolyline } from "./line";

export interface TrendCallbacks {
  close(): void;
  /** Theme lookup, `undefined` without `stargantt.theme` composed. */
  themeGet?: ((token: string) => string) | undefined;
}

export interface TrendPanel {
  root: HTMLElement;
  /** Moves focus into the panel (the dialog's own first-focusable rule). */
  focus(): void;
  /** Removes the panel DOM and with it every listener it attached. Idempotent. */
  dispose(): void;
}

export const TREND_WIDTH = 320;
export const TREND_HEIGHT = 120;

const TREND_LINE_TOKEN = "--sg-progress-line";
const TREND_LINE_FALLBACK = "#d81b60";

/**
 * Maps snapshots to canvas polyline points: x spreads the snapshot dates across the width (a
 * single snapshot sits at the left edge), y maps 0–100% to bottom–top with a 4 px margin.
 */
export function trendPolyline(snapshots: readonly ProgressSnapshot[], width: number, height: number): LinePoint[] {
  if (snapshots.length === 0) return [];
  const first = (snapshots[0] as ProgressSnapshot).date;
  const last = (snapshots[snapshots.length - 1] as ProgressSnapshot).date;
  const span = Math.max(1, last - first);
  const margin = 4;
  return snapshots.map((s) => ({
    x: margin + ((s.date - first) / span) * (width - 2 * margin),
    y: margin + (1 - s.percentComplete / 100) * (height - 2 * margin),
  }));
}

/** Builds and mounts the progress-trend panel over `host` (the gantt root, per §2.16). */
export function createTrendPanel(
  host: HTMLElement,
  snapshots: readonly ProgressSnapshot[],
  messages: TrackingMessages,
  cb: TrendCallbacks,
): TrendPanel {
  const dialog = createDialog({
    host,
    className: "sg-progress-trend",
    label: messages.trendTitle,
    minWidth: "344px",
    top: 24,
    maxHeight: "80%",
    resizable: true,
    onClose: () => cb.close(),
  });
  const doc = dialog.root.ownerDocument;
  const body = dialog.body;

  if (snapshots.length === 0) {
    const empty = doc.createElement("div");
    empty.textContent = messages.trendEmpty;
    body.appendChild(empty);
  } else {
    const canvas = doc.createElement("canvas") as HTMLCanvasElement;
    canvas.width = TREND_WIDTH;
    canvas.height = TREND_HEIGHT;
    canvas.setAttribute("role", "img");
    canvas.setAttribute("aria-label", snapshots.map((s) => messages.trendLine(s)).join("; "));
    const g = typeof canvas.getContext === "function" ? canvas.getContext("2d") : null;
    if (g !== null && g !== undefined) {
      g.strokeStyle = (cb.themeGet?.(TREND_LINE_TOKEN) ?? "") || TREND_LINE_FALLBACK;
      g.lineWidth = 1.5;
      strokePolyline(g, trendPolyline(snapshots, TREND_WIDTH, TREND_HEIGHT));
    }
    body.appendChild(canvas);
    // The same data as text — the canvas alone would make the trend color/vision dependent.
    const list = doc.createElement("ul");
    list.setAttribute("style", "margin:8px 0 0;padding-left:16px;max-height:160px;overflow-y:auto;");
    for (const s of snapshots) {
      const item = doc.createElement("li");
      item.textContent = messages.trendLine(s);
      list.appendChild(item);
    }
    body.appendChild(list);
  }

  const close = doc.createElement("button");
  close.textContent = messages.trendClose;
  close.setAttribute("type", "button");
  close.setAttribute("style", "min-height:24px;min-width:64px;padding:4px 12px;cursor:pointer;font:inherit;");
  // The button lives inside the dialog's own subtree, so `dialog.dispose()` (which unmounts that
  // whole subtree) releases this listener too — nothing accumulates in the plugin context per
  // open/close cycle (§2.16), the same reasoning the bulk panel relies on.
  close.addEventListener("click", () => cb.close());
  dialog.footer.appendChild(close);

  return {
    root: dialog.root,
    focus: () => dialog.focus(),
    dispose: () => dialog.dispose(),
  };
}
