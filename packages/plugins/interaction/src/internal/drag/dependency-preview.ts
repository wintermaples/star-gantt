// docs/specs/plugins/interaction.md §6.2 "dependencyPreview" — while a date drag is under way, each
// direct successor of the dragged task is outlined at the position the drag's displacement would
// carry it to.
/**
 * Which tasks a dependency preview outlines. The displacement itself is the drag's own delta — the
 * preview is a first-order hint of where the successors would land, not a re-run of a scheduling
 * engine.
 */
import type { TaskId } from "@stargantt/plugin-data-store";

/** What the preview needs to know about one dependency link. */
export interface PreviewLink {
  sourceId: TaskId;
  targetId: TaskId;
}

/** The distinct direct successors of `id` — every task some link points to from it, minus itself. */
export function directSuccessors(links: Iterable<PreviewLink>, id: TaskId): TaskId[] {
  const out: TaskId[] = [];
  const seen = new Set<TaskId>();
  for (const link of links) {
    if (link.sourceId !== id) continue;
    if (link.targetId === id || seen.has(link.targetId)) continue;
    seen.add(link.targetId);
    out.push(link.targetId);
  }
  return out;
}
