// docs/specs/plugins/tree-grid.md § Extension points — the one `taskbars/overlays` contribution
// drawing the enabled bar visuals. Overlays are decoration only: this feature contributes no
// `renderer/hitTest` entry.
import type { BarBox, BarOverlayRenderer } from "../upward";
import type { TaskFieldValues } from "../../types";

// docs/specs/plugins/tree-grid.md § Config — the token consumer pattern `theme.get(token) ||
// FALLBACK`; the fallbacks are the documented light values so a composition without a resolvable
// token still renders the visuals.
const WARNING_TOKEN = "--sg-taskfields-warning";
const WARNING_FALLBACK = "#d32f2f";
const AVATAR_TOKEN = "--sg-taskfields-avatar";
const AVATAR_FALLBACK = "#5b6b7b";

const MIN_GLYPH_BAR_HEIGHT = 8;
const MIN_GLYPH_BAR_WIDTH = 14;
const WARNING_SIZE = 10;
const MAX_AVATARS = 3;

export interface OverlayDeps {
  showStatus: boolean;
  showDeadline: boolean;
  showAvatars: boolean;
  fieldsOf(id: BarBox["id"]): Readonly<TaskFieldValues>;
  /** Names of the task's assignees, in assignment order. */
  assigneeNamesOf(id: BarBox["id"]): readonly string[];
  /** `theme.get`, always available since `theme` is a hard dependency here. */
  themeGet: (token: string) => string;
  now(): number;
}

function color(deps: OverlayDeps, token: string, fallback: string): string {
  return (deps.themeGet(token) ?? "") || fallback;
}

/** Draws the status glyph inside the bar's left end (shape carries the meaning, not the color). */
function drawStatus(
  g: CanvasRenderingContext2D,
  bar: Readonly<BarBox>,
  status: NonNullable<TaskFieldValues["status"]>,
): void {
  if (status === "not-started") return;
  if (bar.height < MIN_GLYPH_BAR_HEIGHT || bar.width < MIN_GLYPH_BAR_WIDTH) return;
  const s = Math.min(bar.height - 4, 10);
  const x = bar.x + 4;
  const cy = bar.y + bar.height / 2;
  g.save();
  g.strokeStyle = "#ffffff";
  g.fillStyle = "#ffffff";
  g.lineWidth = 1.5;
  g.beginPath();
  if (status === "done") {
    // Check mark.
    g.moveTo(x, cy);
    g.lineTo(x + s * 0.35, cy + s * 0.35);
    g.lineTo(x + s, cy - s * 0.45);
    g.stroke();
  } else if (status === "in-progress") {
    // Right-pointing triangle.
    g.moveTo(x, cy - s / 2);
    g.lineTo(x + s * 0.8, cy);
    g.lineTo(x, cy + s / 2);
    g.closePath();
    g.fill();
  } else {
    // on-hold: two pause bars.
    g.fillRect(x, cy - s / 2, s * 0.3, s);
    g.fillRect(x + s * 0.5, cy - s / 2, s * 0.3, s);
  }
  g.restore();
}

/**
 * Draws the overdue warning triangle immediately right of the bar's resolved end gutter. Returns
 * its right edge x.
 */
function drawWarning(g: CanvasRenderingContext2D, bar: Readonly<BarBox>, fill: string): number {
  const x = bar.x + bar.width + bar.gutterEnd + 3;
  const cy = bar.y + bar.height / 2;
  const h = WARNING_SIZE;
  g.save();
  g.fillStyle = fill;
  g.beginPath();
  g.moveTo(x, cy + h / 2);
  g.lineTo(x + h, cy + h / 2);
  g.lineTo(x + h / 2, cy - h / 2);
  g.closePath();
  g.fill();
  // The exclamation mark inside the triangle.
  g.fillStyle = "#ffffff";
  g.fillRect(x + h / 2 - 0.5, cy - h * 0.15, 1, h * 0.4);
  g.fillRect(x + h / 2 - 0.5, cy + h * 0.32, 1, 1);
  g.restore();
  return x + h;
}

/** Draws up to three assignee-initial circles (plus a `+n` circle) starting at `startX`. */
function drawAvatars(
  g: CanvasRenderingContext2D,
  bar: Readonly<BarBox>,
  names: readonly string[],
  startX: number,
  fill: string,
): void {
  const r = Math.min(Math.max(bar.height / 2 - 1, 5), 8);
  const cy = bar.y + bar.height / 2;
  const shown = names.slice(0, MAX_AVATARS);
  const labels = shown.map((n) => (n.trim().charAt(0) || "?").toUpperCase());
  if (names.length > MAX_AVATARS) labels.push(`+${names.length - MAX_AVATARS}`);
  g.save();
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.font = `${Math.max(r, 7)}px sans-serif`;
  let cx = startX + r + 2;
  for (const label of labels) {
    g.fillStyle = fill;
    g.beginPath();
    g.arc(cx, cy, r, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = "#ffffff";
    g.fillText(label, cx, cy);
    cx += r * 2 + 3;
  }
  g.restore();
}

/** The single overlay renderer contributed to `taskbars/overlays`. */
export function makeOverlayRenderer(deps: OverlayDeps): BarOverlayRenderer {
  return (g, bar) => {
    const fields = deps.fieldsOf(bar.id);
    if (deps.showStatus && fields.status !== undefined) drawStatus(g, bar, fields.status);
    // The avatar row's own start is right of the bar's resolved end gutter; when the warning
    // triangle also draws, its returned right edge already includes the gutter.
    let rightX = bar.x + bar.width + bar.gutterEnd;
    const overdue =
      deps.showDeadline &&
      fields.deadline !== undefined &&
      fields.deadline < deps.now() &&
      fields.status !== "done";
    if (overdue) rightX = drawWarning(g, bar, color(deps, WARNING_TOKEN, WARNING_FALLBACK));
    if (deps.showAvatars) {
      const names = deps.assigneeNamesOf(bar.id);
      if (names.length > 0) {
        drawAvatars(g, bar, names, rightX, color(deps, AVATAR_TOKEN, AVATAR_FALLBACK));
      }
    }
  };
}
