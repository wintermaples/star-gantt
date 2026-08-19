// docs/specs/plugins/scheduling.md §6 — working calendars.
/**
 * Entry point of the calendars area: `CalendarsService` and `regionCalendar` (§1.2), the order-8
 * non-working shading layer (§6.2) and the working-calendar editor (§6.3).
 *
 * What this area already finds in place: the registry store the service publishes as `state`
 * (`deps.calendars`, seeded from `calendars.calendars` at setup), the §2.2 calendar resolution the
 * engine passes already run through, and the `snap/workingTime` provider reading the same registry
 * — so filling in the mutators (registry.ts) and wiring the service, layer and editor here is what
 * makes all three live.
 *
 * §1.2 / §11 (review ruling, B2) — `stargantt.calendars` is provided UNCONDITIONALLY, exactly
 * like `stargantt.critical-path` (§1.3): an empty registry answers every query the same way an
 * absent-calendars composition did. Only the shading layer and the editor stay gated behind the
 * `calendars` nest's presence; `src/index.ts` therefore calls `wireCalendars` unconditionally too.
 *
 * §14 (amended, P4 review ruling) — `meta.optional` does not order startup (the core tiers plugins
 * by `dependsOn` alone), so this plugin's `setup()` can run before `stargantt.view` has provided
 * anything. `stargantt.view` / `stargantt.timeline` / `stargantt.theme` (repaint, the time↔x
 * mapping, the shade token) and `stargantt.selection` (the editor's "assign" section) are therefore
 * resolved PER USE — never latched into a setup-time variable — so this area stays inert (no
 * repaint, no shading, no "assign" section) only for as long as the absent service stays absent,
 * and starts working the moment it is actually composed, in any registration order.
 */
import { createEditor } from "./editor";
import { createCalendarsService } from "./service";
import { createShadingLayer, SHADING_LAYER_KEY, SHADING_LAYER_ORDER } from "./shading";
import type { Editor } from "./editor";
import type { CalendarsService } from "./service";
import type { SchedulingAreaDeps } from "../areas";
import type { CalendarId, TaskId } from "@stargantt/plugin-data-store";
import type { SelectionService } from "@stargantt/plugin-interaction";
import type { ThemeService, TimelineService, ViewService } from "@stargantt/plugin-view";

const LAYER_SCOPE = "renderer/layers";

/** Wires the calendars area. Called unconditionally (§11 / B2) — the service is always provided. */
export function wireCalendars(deps: SchedulingAreaDeps): void {
  const { ctx, data, calendars: registry } = deps;
  const nest = deps.config.calendars;
  const editorSections = nest?.editor;
  const shadeCalendarConfig = nest?.shadeCalendar;

  // §14 — resolved per use, never latched: a setup-time `const view = ctx.useOptional(...)` would
  // permanently see `undefined` in any real composition where `stargantt.view` has not run its own
  // `setup()` yet (the common case — `meta.optional` does not order startup).
  const viewService = (): ViewService | undefined => ctx.useOptional("stargantt.view");
  const timelineService = (): TimelineService | undefined => ctx.useOptional("stargantt.timeline");
  const themeService = (): ThemeService | undefined => ctx.useOptional("stargantt.theme");

  // §11.3 — an explicit `shadeCalendar` is sticky from setup onward; omitted, the registry default
  // is followed live (registry.ts's `commit`). This mirrors the earlier `explicitShade` seeding,
  // folded into the registry's own bookkeeping here (§1.2).
  if (shadeCalendarConfig !== undefined) registry.setShadeCalendar(shadeCalendarConfig);

  let editor: Editor | undefined;
  let mounted = false;

  function mountEditor(): void {
    if (mounted || editorSections === undefined) return;
    mounted = true;
    editor = createEditor(ctx.root.ownerDocument, ctx.root, {
      messages: deps.messages,
      locale: ctx.locale,
      sections: editorSections,
      list: () => registry.state.get().calendars,
      setWorkingDays: (id, days) => service.setWorkingDays(id, days),
      setWorkingHours: (id, windows) => service.setWorkingHours(id, windows),
      setException: (id, exception) => service.setException(id, exception),
      removeException: (id, date) => service.removeException(id, date),
      setExceptionRange: (id, range) => service.setExceptionRange(id, range),
      removeExceptionRange: (id, from, to) => service.removeExceptionRange(id, from, to),
      selectedTasks(): readonly TaskId[] | undefined {
        // Resolved per call, never latched (§14: optional, late lookup).
        const selection: SelectionService | undefined = ctx.useOptional("stargantt.selection");
        return selection === undefined ? undefined : [...selection.state.get().taskIds];
      },
      assignTask: (taskId, calendarId) => service.assignTask(taskId, calendarId),
    });
    // One owned disposable for the panel: setup() is where the core's resource ledger is fed, and
    // disposal must also release a panel built later (on `lifecycle/ready`).
    ctx.own({ dispose: () => editor?.dispose() });
  }

  const service: CalendarsService = createCalendarsService({
    registry,
    getTask: (id) => data.getTask(id),
    storeCalendars: () => data.query().calendars,
    dispatchTaskUpdate: (id, after, clears) => {
      if (clears !== undefined) ctx.dispatch("task/update", { id, after, clears });
      else ctx.dispatch("task/update", { id, after });
    },
    openEditor: (id) => {
      mountEditor();
      editor?.open(id);
    },
    closeEditor: () => editor?.close(),
  });

  function repaint(): void {
    viewService()?.invalidate("background");
  }

  // §1.2 — every announcing mutator (the eight registry edits plus `setShadeCalendar`, §1.2)
  // commits `registry.state` exactly once per gesture; one subscription here turns each commit
  // into a repaint and an editor refresh (registry edits stay outside
  // undo, §1.2, so this is the only place they become visible). Registry commits are never part of
  // a data transaction, so the bulk-only guard below does not apply here.
  ctx.own(
    registry.state.subscribe(() => {
      repaint();
      editor?.refresh();
    }),
  );

  // The earlier implementation repainted and refreshed the editor only on a BULK `load()` that
  // replaced the data store's own calendar set (registry untouched, but `resolve()`'s data-store
  // fallback and `effectiveCalendar` may answer differently afterward) — never on an ordinary
  // transaction, which its plugin never saw at all through this path. This package has one shared
  // `data.tasks` store for both the bulk and the transaction path, so the two must be told apart
  // here: a transaction always opens with `data/willApplyTransaction` — emitted strictly before the
  // store's own `tasks.set()` burst that this subscription reacts to
  // (`@stargantt/plugin-data-store`'s `apply()`) — and a bulk `load()` never emits it at all. The
  // flag below is therefore `true` exactly while the CURRENT `tasks` notification, if any,
  // originates from a transaction; an ordinary edit is silently skipped (repainting nothing wipes
  // no editor state, exactly as the earlier guard did), and a
  // bulk load falls through to the repaint+refresh path unchanged. The `queueMicrotask` reset
  // guards only the rare case a will-handler cancels the transaction or empties its patch list
  // (`dispatch()` then returns before `tasks` is ever set, so the flag would otherwise never clear
  // itself) — the decisive synchronous path (a committed transaction, or a bulk load) never touches
  // it, so this is a safety net, not a timing dependency of the guard itself.
  let pendingTransaction = false;
  ctx.on("data/willApplyTransaction", () => {
    pendingTransaction = true;
    queueMicrotask(() => {
      pendingTransaction = false;
    });
  });
  ctx.own(
    data.tasks.subscribe(() => {
      if (pendingTransaction) {
        pendingTransaction = false;
        return;
      }
      repaint();
      editor?.refresh();
    }),
  );

  if (editorSections !== undefined) {
    ctx.on("lifecycle/ready", () => mountEditor());
  }

  // §3.2 — the order-8 shading layer, registered only while the `calendars` nest is present (B2:
  // the service above is unconditional; only the visuals/editor stay nest-gated); its own draw pass
  // no-ops while no shade calendar resolves (§6.2).
  if (nest !== undefined) {
    ctx.claimOrder(LAYER_SCOPE, SHADING_LAYER_KEY, SHADING_LAYER_ORDER);
    const layer = createShadingLayer({
      shadeCalendarId: (): CalendarId | undefined => registry.state.get().shadeCalendar,
      resolve: (id) => service.resolve(id),
      timeline: () => timelineService(),
      theme: () => themeService(),
    });
    ctx.contribute(LAYER_SCOPE, layer);
  }

  ctx.provide("stargantt.calendars", service);
}
