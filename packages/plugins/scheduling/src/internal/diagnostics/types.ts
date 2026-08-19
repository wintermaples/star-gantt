// docs/specs/plugins/scheduling.md §8 — internal report shapes.
/**
 * These are deliberately NOT public API (§1.4: the report/service types are not public
 * API — the abolished `stargantt.schedule-diagnostics` service carried them; the panel is the only
 * consumer). Kept in their own module purely for `diagnose.ts` / `panel.ts` to share without a
 * cycle, mirroring the earlier implementation's own `types.ts`.
 */
import type { LinkId, TaskId } from "@stargantt/plugin-data-store";

/** A task that has neither an incoming nor an outgoing dependency link. */
export interface OrphanTaskIssue {
  kind: "orphanTask";
  taskId: TaskId;
}

/**
 * A dependency link with a negative lag (a lead), discouraged by scheduling best practice because
 * it makes a successor start before its predecessor's driving point.
 */
export interface LeadIssue {
  kind: "lead";
  linkId: LinkId;
  sourceId: TaskId;
  targetId: TaskId;
  /** The link's lag in milliseconds; always negative here. */
  lag: number;
}

export type DiagnosticIssue = OrphanTaskIssue | LeadIssue;

/** The full result of one diagnostic pass. */
export interface DiagnosticsReport {
  /** Every finding: all orphan-task issues first, then all lead issues. */
  issues: readonly DiagnosticIssue[];
  /** The orphan-task findings, ordered by task start (ties by store insertion order). */
  orphans: readonly OrphanTaskIssue[];
  /** The lead findings, in store link order. */
  leads: readonly LeadIssue[];
}
