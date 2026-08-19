// docs/specs/plugins/scheduling.md §8 — schedule diagnostics.
/**
 * Entry point of the diagnostics area: the DCMA-style orphan/lead audit and the corner-slot findings
 * panel. The earlier `stargantt.schedule-diagnostics` service is deliberately not provided here — the
 * detection rules reach users only through this opt-in panel (§1.4).
 *
 * The `overlay-corner` slot claim (`top-left`, all four corners as candidates) lives here, not in
 * `index.ts` (§3.2's `overlay-corner` claim row).
 */
import { createFrameScheduler } from "@stargantt/sdk";
import type { TaskId } from "@stargantt/plugin-data-store";
import type { ViewService } from "@stargantt/plugin-view";
import type { SchedulingAreaDeps } from "../areas";
import { diagnose, EMPTY_REPORT, lagInDays } from "./diagnose";
import type { DiagnosticsReport } from "./types";
import { createPanel, DIAGNOSTICS_CORNERS, isDiagnosticsCorner } from "./panel";
import type { DiagnosticsCorner, Panel, PanelSection } from "./panel";

const SLOT_GROUP = "overlay-corner";
const REQUESTED_CORNER: DiagnosticsCorner = "top-left";

/**
 * The corner a `claimSlot("overlay-corner", "top-left", …)` grant resolves to: the requested corner
 * when granted, the proposed alternative when it names one of the four known corners, `"top-left"`
 * otherwise (no free slot left — the same corner the request itself named, so the panel still
 * renders predictably rather than picking an arbitrary fallback). Mirrors
 * `@stargantt/plugin-interaction`'s `resolveCorner` (the filter toolbar's precedent) exactly.
 */
export function resolveCorner(grant: { granted: boolean; alternative?: string }): DiagnosticsCorner {
  return grant.granted || !isDiagnosticsCorner(grant.alternative)
    ? REQUESTED_CORNER
    : grant.alternative;
}

/** Wires the diagnostics area. */
export function wireDiagnostics(deps: SchedulingAreaDeps): void {
  const { ctx, config, data, messages } = deps;
  if (config.diagnostics?.panel !== true) return; // §11.5: only `panel: true` mounts anything.

  /* --- §8 the lazily recomputed report ------------------------------------------------- */

  let cached: DiagnosticsReport | undefined;
  function report(): DiagnosticsReport {
    if (cached === undefined) {
      const view = data.query();
      cached = view.byId.size === 0 ? EMPTY_REPORT : diagnose(view);
    }
    return cached;
  }

  let panel: Panel | undefined;
  // The cache reset is synchronous, but the panel's DOM refresh is coalesced to once per animation
  // frame (§8, `sdk/frame`'s rAF coalescing) so a burst of data churn — e.g. an auto-schedule
  // cascade of transactions — rebuilds the findings list once, not per event.
  const refresh = createFrameScheduler(() => panel?.refresh());
  ctx.own(refresh);
  ctx.own(
    data.tasks.subscribe(() => {
      cached = undefined;
      refresh.schedule();
    }),
  );

  /* --- §3.2 the corner-slot claim -------------------------------------------------------- */

  // Claimed at setup(), not deferred to `lifecycle/ready` — the claim itself touches no DOM (only
  // the panel mount below needs `stargantt.view`'s pane element), and claiming here keeps the
  // corner-slot arbitration's registration-order determinism tied to plugin registration order
  // rather than to `lifecycle/ready` LISTENER order (the filter-toolbar precedent's own
  // reasoning for the same choice).
  const grant = ctx.claimSlot(SLOT_GROUP, REQUESTED_CORNER, DIAGNOSTICS_CORNERS);
  const corner = resolveCorner(grant);

  // §8 message helper. No extra throw-guarding needed here: `resolveMessages` (§12,
  // `internal/messages.ts`, read-only — this area only consumes `deps.messages`) already wraps every
  // override builder in `sdk/dom`'s latched fault barrier, so a call below either runs the host's
  // builder safely or has already fallen back to the built-in default for the rest of this chart's
  // life.
  const taskName = (id: TaskId): string => data.getTask(id)?.name ?? String(id);

  function sections(): PanelSection[] {
    const current = report();
    const out: PanelSection[] = [];
    if (current.orphans.length > 0) {
      out.push({
        heading: messages.orphanHeading(current.orphans.length),
        items: current.orphans.map((issue) => taskName(issue.taskId)),
      });
    }
    if (current.leads.length > 0) {
      out.push({
        heading: messages.leadHeading(current.leads.length),
        items: current.leads.map((issue) =>
          messages.leadItem(taskName(issue.sourceId), taskName(issue.targetId), lagInDays(issue.lag)),
        ),
      });
    }
    return out;
  }

  ctx.on("lifecycle/ready", () => {
    if (panel !== undefined) return;
    // §14 (amended, M5) — `view` is optional with inert degradation: in a composition without
    // `stargantt.view` there is no chart pane to host the panel, and the plugin stays SILENTLY
    // inert — no `core/pluginError`, which is reserved for foreign-code faults, not for a
    // composition simply not including a chart provider (the same rule every area follows).
    const view: ViewService | undefined = ctx.useOptional("stargantt.view");
    if (view === undefined) return;
    const pane = view.chartPaneElement();

    const created = createPanel(
      pane,
      { panelLabel: messages.panelLabel, noIssues: messages.noIssues, corner },
      {
        buttonText: () => messages.button(report().issues.length),
        sections,
      },
    );
    panel = created;
    pane.appendChild(created.root);
    ctx.own({ dispose: () => created.root.remove() });

    // Close the findings list on an outside press. The document-level listener is the plugin's own
    // resource, registered exactly once through `ctx.own()`.
    const doc = pane.ownerDocument;
    const onDocPointerDown = (event: Event): void => {
      if (!created.contains(event.target)) created.close();
    };
    doc.addEventListener("pointerdown", onDocPointerDown);
    ctx.own({ dispose: () => doc.removeEventListener("pointerdown", onDocPointerDown) });
  });
}
