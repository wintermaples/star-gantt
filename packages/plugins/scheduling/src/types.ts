// docs/specs/plugins/scheduling.md §1 / §3.1 / §9 / §10
/**
 * The plugin's single declaration-merging site: the service it provides, the one event it emits,
 * the two extension points it defines, and its two commands.
 *
 * Every shape referenced here is declared in the headless engine (`engine/`) so the engine subtree
 * stays free of any import outside `@stargantt/plugin-data-store`, `@stargantt/sdk` and its own
 * files (§13); this file only publishes them to the core's key spaces, and `index.ts` re-exports
 * them as the package's public surface.
 */
import type { ExtensionPointDecl } from "@stargantt/core";
import type { LinkId, TaskId } from "@stargantt/plugin-data-store";
import type { TaskScheduleMode } from "./engine/modes";
import type { SchedulerService } from "./engine/service";
import type {
  ConstraintBoundsContribution,
  PropagationRuleContribution,
} from "./engine/types";
import type { CalendarsService } from "./internal/calendars/service";
import type { CriticalPathService } from "./internal/critical-path/service";

declare module "@stargantt/core" {
  interface Services {
    "stargantt.scheduler": SchedulerService;
    "stargantt.calendars": CalendarsService;
    "stargantt.critical-path": CriticalPathService;
  }

  interface Events {
    // §2.7 — the surviving hook event of the official catalog.
    /**
     * Emitted when a `link/add` was refused for closing a dependency cycle: the transaction is
     * cancelled in the will phase and this fires once, synchronously, after the cancellation.
     * `chain` names the existing links that, together with the refused edge, would form the cycle,
     * in walk order.
     */
    "schedule/cycleRejected": { chain: readonly LinkId[] };
  }

  interface ExtensionPoints {
    // §3.1 — custom constraint type → time bounds. Strategy "first" over declining contributions.
    "schedule/constraintBounds": ExtensionPointDecl<
      ConstraintBoundsContribution,
      ConstraintBoundsContribution
    >;
    // §3.1 — per-task propagation-rule override. Strategy "first" over declining contributions.
    "schedule/propagationRule": ExtensionPointDecl<
      PropagationRuleContribution,
      PropagationRuleContribution
    >;
  }

  interface Commands {
    // §2.6 / §9
    /**
     * Repositions the incomplete part of the work at or after `statusDate`, based on each task's
     * recorded progress: unstarted tasks that start earlier move bodily to the status date, and
     * in-progress tasks keep their start while their end is pushed out so the remaining share of
     * their duration fits after it. Completed, manually scheduled and summary tasks never move.
     * All resulting changes — including the downstream moves automatic propagation appends — form
     * one transaction, i.e. one undo step. A non-finite `statusDate` is ignored; so is a run that
     * would move nothing.
     */
    "schedule/reschedule": { statusDate: number };
    // §2.4 / §9
    /**
     * Switches one task between automatic and manual scheduling via one undoable `task/update`.
     * Manual tasks keep their dates against every engine pass; `"auto"` returns the task to normal
     * propagation. Ignored (no error) for an unknown id, an unusable `mode` value, or a task
     * already in the requested mode.
     */
    "schedule/setTaskMode": { id: TaskId; mode: TaskScheduleMode };
  }
}
