// docs/specs/plugins/interaction.md §6.4 — hover / click tooltip over a bar, its content point and the focus-driven display
/**
 * Wiring entry point of the `tooltip` feature.
 *
 * Installs an `ArbiterTooltip` implementation (§1.3: the gesture arbiter dispatches `hover` / `press`
 * / `suppress` / `dismiss` to it) and owns the two seams the arbiter does not carry: `view/scrolled`
 * (anchor invalidated) and the tasks store's freshness subscription (§6.4a). Everything else — the
 * `tooltip/content` extension point, the panel DOM, the hover state machine, the sticky Escape
 * dismissal, the focus-driven display — is internal modules this file only wires together.
 */
import { first } from "@stargantt/core";
import { isoDay, listen } from "@stargantt/sdk";
import type { TaskId } from "@stargantt/plugin-data-store";
import type { HitResult } from "@stargantt/plugin-view";
import type { ArbiterTooltip } from "../gesture/arbiter";
import type { PeripheralWiring } from "../peripheral";
import { focusChannel } from "../upward";
import { createFocusFollow } from "./focus-follow";
import { createHoverMachine } from "./hover";
import { createPanel } from "./panel";
import type { TooltipContent, TooltipContentProvider } from "./panel";

/** The renderer's DOM UI host — the shared mount point tooltip and context-menu both use. */
const OVERLAY_SELECTOR = ".sg-dom-overlay";

// §6.4 / the "unusable value silently falls back to its default" config rule (§6).
function validTrigger(value: unknown): "click" | "hover" | "both" {
  return value === "click" || value === "hover" || value === "both" ? value : "click";
}

function validDelay(value: unknown, fallbackMs: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallbackMs;
}

/** Wires the tooltip feature into the composition. */
export function wireTooltip(deps: PeripheralWiring): void {
  const { ctx, config } = deps;

  // §6.4 — read once, never re-read afterwards.
  const trigger = validTrigger(config["trigger"]);
  const showDelay = validDelay(config["showDelay"], 300);
  const hideDelay = validDelay(config["hideDelay"], 100);

  /** The feature owns the `tooltip/content` point, so it guards every contribution it calls. */
  function guard(provider: TooltipContentProvider): TooltipContentProvider {
    return (hit) => {
      try {
        return provider(hit);
      } catch (error) {
        deps.reportError(error);
        return undefined;
      }
    };
  }

  /* --- §6.4 the built-in fallback provider ------------------------------ */

  // `stargantt.data-store` is a hard dependency of the whole interaction plugin, so the store is
  // always present wherever the built-in fallback can fire.
  const data = ctx.use("stargantt.data");

  /** The built-in fallback: the hit task's name and its start and end dates. */
  function builtInContent(hit: Readonly<HitResult>): TooltipContent | undefined {
    if (hit.kind !== "bar" && hit.kind !== "handle") return undefined;
    const task = data.getTask(hit.id as TaskId);
    if (task === undefined) return undefined;
    // `Task.end` is exclusive; the stored instant is shown as-is, without subtracting a day, so the
    // tooltip agrees with the grid and the side panel. An instant that is not a finite number
    // formats to nothing and is left out.
    const dates: string[] = [];
    for (const formatted of [isoDay(task.start), isoDay(task.end)]) {
      if (formatted !== undefined && !dates.includes(formatted)) dates.push(formatted);
    }
    if (dates.length === 0) return task.name;
    if (dates.length === 1) return `${task.name} (${dates[0]})`;
    return `${task.name} (${dates[0]} – ${dates[1]})`;
  }

  // §6.4 `content`: absent → built-in provider; a function → that function in its place; `null` →
  // no fallback at all; anything else is unusable and counts as absent.
  const configured = config["content"];
  const fallback: TooltipContentProvider | undefined =
    configured === null
      ? undefined
      : typeof configured === "function"
        ? guard(configured as TooltipContentProvider)
        : builtInContent;

  /* --- §3 `tooltip/content` (first): composite provider, call-time interception --- */
  const point = ctx.defineExtensionPoint(
    "tooltip/content",
    (inputs: TooltipContentProvider[]): TooltipContentProvider =>
      first<[hit: Readonly<HitResult>], TooltipContent>()(inputs.map(guard)),
  );

  /** The composed `tooltip/content` point first, then the fallback. */
  function resolveContent(hit: Readonly<HitResult>): TooltipContent | undefined {
    const provider = point.get();
    const contributed = typeof provider === "function" ? provider(hit) : undefined;
    return contributed ?? fallback?.(hit);
  }

  /* --- DOM element in the renderer's overlay container ------------------ */
  const doc = ctx.root.ownerDocument;
  const host: HTMLElement = ctx.root.querySelector(OVERLAY_SELECTOR) ?? ctx.root;
  // §6.4a hoverable applies only to the hover/both triggers' grace period; a click-only panel has no
  // hide-on-leave to cancel by being entered, so it must not become a pointer target that could
  // swallow a press.
  const hoverable = trigger === "hover" || trigger === "both";
  const panel = createPanel({ doc, host, resolve: resolveContent, hoverable });
  ctx.own({ dispose: () => panel.destroy() });

  /* --- show/hide state machine ------------------------------------------- */
  const hover = createHoverMachine(panel, { showDelay, hideDelay });
  ctx.own({ dispose: () => hover.cancelTimers() });

  // §6.4a WCAG 1.4.13 "Hoverable" — the panel keeps itself alive: entering it cancels the pending
  // hover-end hide (the one armed when the pointer left the bar toward the panel), and leaving it
  // re-arms the same `hideDelay`. Attached only for the hover/both triggers: a click-triggered
  // tooltip persists until dismissed, and arming a hide on panel-leave would silently expire it.
  // Guarded for stub DOMs whose elements carry no listener API (the unit-test environment).
  const el = panel.element;
  if (hoverable && typeof el.addEventListener === "function") {
    const onPanelEnter = ((): void => hover.onPanelEnter()) as EventListener;
    const onPanelLeave = ((): void => hover.onPanelLeave()) as EventListener;
    el.addEventListener("pointerenter", onPanelEnter);
    el.addEventListener("pointerleave", onPanelLeave);
    ctx.own({
      dispose: () => {
        el.removeEventListener("pointerenter", onPanelEnter);
        el.removeEventListener("pointerleave", onPanelLeave);
      },
    });
  }

  /* --- §6.4a focus-driven display (keyboard trigger, no pointer required) --- */
  // Resolved lazily on every event and never latched: `stargantt.task-bars` and `stargantt.view` are
  // hard dependencies of this plugin, but the focus channel itself is the a11y plugin's optional
  // service, which may start after this one (or never).
  const follow = createFocusFollow({
    anchorOf: (id) => {
      const rect = ctx.use("stargantt.task-bars").barRect(id as TaskId);
      if (rect === undefined) return undefined;
      // `barRect` answers in content coordinates; the panel anchors in viewport-local ones, the
      // space the pointer events deliver, so the current scroll offsets are subtracted. Anchored
      // at the bar's bottom-left corner, so the below-right offset clears the bar itself.
      const vp = ctx.use("stargantt.view").viewport.get();
      return { x: rect.x - vp.scrollLeft, y: rect.y - vp.scrollTop + rect.height };
    },
    show: (h, x, y) => hover.onClick(h, x, y),
    isVisible: () => panel.isVisible(),
    hide: () => hover.onSuppress(),
  });
  // The a11y plugin's `stargantt.focus` (`FocusService.state`) replaces the abolished `focus/changed`
  // event (docs/specs/plugins/a11y.md) — store-shaped, so this feature subscribes to it instead of
  // listening for an event. Resolved on `lifecycle/ready` (fired once after every plugin's setup()
  // completes), never at this plugin's own `setup()`: the a11y plugin — same layer, optional — may
  // start after this one, so the service is not necessarily composed yet while `wireTooltip` runs.
  // Without the a11y plugin composed at all, `focusChannel(ctx)()` stays `undefined` forever and this
  // subscription is simply never installed — every pointer behavior is untouched, matching the
  // buffered/inert semantics `internal/upward.ts` documents for the other optional-focus seams.
  ctx.on("lifecycle/ready", () => {
    const channel = focusChannel(ctx)();
    if (channel === undefined) return;
    ctx.own(channel.state.subscribe((state) => follow.onFocusChanged(state.focused)));
  });
  // Blur equivalent of pointer-leave: the DOM focus leaving the chart root dismisses a focus-shown
  // tooltip (and only one that a focus move put up — pointer tooltips stay). Guarded for stub DOMs
  // whose elements carry no listener API (the unit-test environment).
  if (typeof (ctx.root as Partial<HTMLElement>).addEventListener === "function") {
    listen(ctx, ctx.root, "focusout", (e) => {
      const related = e.relatedTarget;
      const root = ctx.root as unknown as { contains?: (n: unknown) => boolean };
      const stillInside =
        related !== null && typeof root.contains === "function" && root.contains(related);
      if (!stillInside) follow.onRootBlur();
    });
  }

  /* --- §1.3 the ArbiterTooltip implementation ---------------------------- */
  const impl: ArbiterTooltip = {
    hover(e): void {
      // The arbiter's own FSM state moves to "hover" on every `pointer/barHover` regardless of
      // trigger (the renderer does not know about tooltip config); this feature's own hover
      // machinery is armed only under the hover/both triggers (§1.2 state doc).
      if (!hoverable) return;
      if (e.hit === undefined) {
        hover.onLeave();
        return;
      }
      // A pointer trigger takes the panel over from the focus cycle.
      follow.onPointerShow();
      hover.onHit(e.hit, e.x, e.y);
    },
    press(e): void {
      if (trigger === "click" || trigger === "both") {
        follow.onPointerShow();
        hover.onClick(e.hit, e.x, e.y);
        return;
      }
      // §1.3 "hover" state row — a press on the hover-tracked bar sticks a dismissal to it (the
      // same sticky mechanic Escape uses); a no-op when nothing is tracked (idle-state row: no note
      // applies to the pure hover trigger there).
      hover.onDismiss();
    },
    suppress: () => hover.onSuppress(),
    dismiss: () => hover.onDismiss(),
  };
  deps.setTooltip(impl);

  /* --- the two seams the arbiter does not carry -------------------------- */

  // The tooltip is anchored in viewport-local coordinates that scrolling invalidates.
  ctx.on("view/scrolled", () => hover.onScroll());

  // §6.4a freshness — while a tooltip is visible, every tasks store change re-runs the content
  // resolution for its anchor hit: a non-`undefined` result replaces the content in place (no
  // flicker), `undefined` (task deleted, dataset reloaded) hides it. A resting chart with no visible
  // tooltip resolves nothing (`panel.refresh()` is a no-op without an anchor).
  ctx.own(data.tasks.subscribe(() => panel.refresh()));
}
