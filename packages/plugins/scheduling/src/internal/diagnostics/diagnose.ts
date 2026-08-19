// docs/specs/plugins/scheduling.md §8 — the DCMA-style orphan/lead audit: one O(tasks + links) sweep
// over the store's read-only view. Hostless and pure — testable without booting a host. Omits the
// `analyzedTaskCount` / `linkCount` fields (not part of this report shape —
// nothing in scheduling.md §8 or the panel reads them) and uses `@stargantt/sdk`'s `MS_DAY` rather
// than a bundled toolkit's.
import type { ReadonlyDataView } from "@stargantt/plugin-data-store";
import { MS_DAY } from "@stargantt/sdk";
import type { DiagnosticsReport, LeadIssue, OrphanTaskIssue } from "./types";

/** The report of an empty store. */
export const EMPTY_REPORT: DiagnosticsReport = {
  issues: [],
  orphans: [],
  leads: [],
};

/**
 * Runs the two checks over one data view (§8).
 *
 * Orphans: a non-summary task with no incoming and no outgoing link (summaries are neither reported
 * nor counted; milestones participate; a link counts as a connection regardless of its quality),
 * ordered by start ascending with store insertion order breaking ties. Leads: a link whose `lag` is
 * a finite number strictly below 0 — a missing or non-finite lag counts as 0 and is never reported
 * — in store link order (derived from the per-task `out` lists in task insertion order).
 */
export function diagnose(view: ReadonlyDataView): DiagnosticsReport {
  // (start, issue) pairs collected in one pass — the start is known right here, so the sort's
  // comparator never has to look tasks up again.
  const orphanPairs: { start: number; issue: OrphanTaskIssue }[] = [];
  const leads: LeadIssue[] = [];

  for (const task of view.byId.values()) {
    if (task.type === "summary") continue;
    const links = view.linksByTask.get(task.id);
    if (links === undefined || (links.in.length === 0 && links.out.length === 0)) {
      orphanPairs.push({ start: task.start, issue: { kind: "orphanTask", taskId: task.id } });
    }
  }
  // Stable sort by start; ties keep the byId (insertion) order the loop produced.
  orphanPairs.sort((a, b) => a.start - b.start);
  const orphans = orphanPairs.map((pair) => pair.issue);

  for (const id of view.byId.keys()) {
    const out = view.linksByTask.get(id)?.out;
    if (out === undefined) continue;
    for (const link of out) {
      const lag = link.lag;
      if (typeof lag === "number" && Number.isFinite(lag) && lag < 0) {
        leads.push({
          kind: "lead",
          linkId: link.id,
          sourceId: link.sourceId,
          targetId: link.targetId,
          lag,
        });
      }
    }
  }

  return {
    issues: [...orphans, ...leads],
    orphans,
    leads,
  };
}

/** A lag in ms as days, rounded to at most two decimals (e.g. `-1.5`) — the panel's `leadItem`. */
export function lagInDays(lagMs: number): number {
  return Math.round((lagMs / MS_DAY) * 100) / 100;
}
