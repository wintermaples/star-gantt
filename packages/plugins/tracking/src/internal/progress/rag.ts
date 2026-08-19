// docs/specs/plugins/tracking.md §3.2 — the two bar decorations this area contributes: the
// config-gated RAG recolor (`taskbars/style`, only under `progress.colorBars: true`) and the
// lettered RAG badge (`taskbars/overlays`, on by default — `progress.showRagOnBars !== false`).
// Meaning is never carried by color alone: the badge pairs each color with its letter (§9's
// accessibility rule, gantt-ui-ux "meaning never by color alone").
//
// The task-bars contribution types arrive via `import type` from `@stargantt/plugin-task-bars`.
import type { Task } from "@stargantt/plugin-data-store";
import type { BarBox, BarOverlayRenderer, BarStyle, BarStyleProvider } from "@stargantt/plugin-task-bars";
import type { RagStatus } from "../../types";

/** Theme token per RAG value. */
export const RAG_TOKENS: Record<RagStatus, string> = {
  red: "--sg-rag-red",
  amber: "--sg-rag-amber",
  green: "--sg-rag-green",
};

/** Fallback fills, used when `stargantt.theme` is not composed; each keeps the badge letter's
 *  default white (`--sg-rag-badge-fg` fallback) at or above 4.5:1 contrast. */
export const RAG_FALLBACKS: Record<RagStatus, string> = {
  red: "#c62828",
  amber: "#b45309",
  green: "#2e7d32",
};

/** The letter inside the badge — the non-color carrier of the classification. */
export const RAG_LETTERS: Record<RagStatus, string> = { red: "R", amber: "A", green: "G" };

export const RAG_BADGE_FG_TOKEN = "--sg-rag-badge-fg";
export const RAG_BADGE_FG_FALLBACK = "#ffffff";

export interface DecorDeps {
  ragOf: (task: Readonly<Task>) => RagStatus | undefined;
  /** Theme lookup, `undefined` when `stargantt.theme` is not composed. */
  themeGet: ((token: string) => string) | undefined;
}

export function ragColor(rag: RagStatus, themeGet: DecorDeps["themeGet"]): string {
  return (themeGet?.(RAG_TOKENS[rag]) ?? "") || RAG_FALLBACKS[rag];
}

/** The `taskbars/style` provider: recolors classified bars, declines (returns `undefined`) for
 *  the rest — only registered under `progress.colorBars: true`. */
export function makeRagStyleProvider(deps: DecorDeps): BarStyleProvider {
  return (task: Readonly<Task>): BarStyle | undefined => {
    const rag = deps.ragOf(task);
    return rag === undefined ? undefined : { color: ragColor(rag, deps.themeGet) };
  };
}

// Exported so the clearance test can assert the badge never overlaps the resolved start
// gutter (`arcs[0] + BADGE_RADIUS < bar.x - bar.gutterStart`) without hand-copying the radius.
export const BADGE_RADIUS = 5;
const MIN_BAR_HEIGHT = 12;

/**
 * The `taskbars/overlays` renderer: a filled circle centered 8 px left of the resolved start
 * gutter — outside any clearance `taskbars/endGutter` contributors reserve there — carrying the
 * RAG letter (colored by the `--sg-rag-badge-fg` theme token, white by default). Skipped for
 * unclassified tasks and bars under 12 px tall.
 */
export function makeRagBadgeRenderer(
  deps: DecorDeps & { taskOf: (id: BarBox["id"]) => Readonly<Task> | undefined },
): BarOverlayRenderer {
  return (g: CanvasRenderingContext2D, bar: Readonly<BarBox>): void => {
    if (bar.height < MIN_BAR_HEIGHT) return;
    const task = deps.taskOf(bar.id);
    if (task === undefined) return;
    const rag = deps.ragOf(task);
    if (rag === undefined) return;
    const cx = bar.x - bar.gutterStart - 8;
    const cy = bar.y + bar.height / 2;
    g.fillStyle = ragColor(rag, deps.themeGet);
    g.beginPath();
    g.arc(cx, cy, BADGE_RADIUS, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = (deps.themeGet?.(RAG_BADGE_FG_TOKEN) ?? "") || RAG_BADGE_FG_FALLBACK;
    g.font = "700 8px system-ui, sans-serif";
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.fillText(RAG_LETTERS[rag], cx, cy);
  };
}
