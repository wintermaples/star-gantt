// docs/specs/plugins/interaction.md §6.5 — the chart and grid context menus, their built-in entries and the contributed ones
/**
 * Wiring entry point of the `context-menu` feature.
 *
 * Installs an `ArbiterContextMenu` implementation (§1.3: the gesture arbiter's own `context` FSM
 * state drives `openAtHit` / `openAtBackground` / `openAtRow` / `openAtGridBackground` / `close`) and
 * owns every seam the arbiter does not carry: native context-menu suppression, the outside-press
 * close, `view/scrolled`, and the tasks store's freshness subscription (§1.3's "Additional `context`
 * exits" note). Everything else — the `contextmenu/items` extension point, the menu DOM, the
 * built-in entries, the pending link-source state — is internal modules this file only wires
 * together.
 *
 * Link-source invocation bookkeeping: `linkSource.beginInvocation()` runs inside `openWith()`
 * before EVERY actual open (an empty resolution never begins one — there is nothing to end), and
 * `linkSource.endInvocation()` runs on EVERY close path, through the shared `closeMenu()` helper
 * below, regardless of what drove the close (an activation, a self-driven close, an outside press,
 * `view/scrolled`, the tasks-freshness subscription, or the arbiter's own `close()`). This is
 * orthogonal to the quiet/loud `menuClosed()` split kept for the arbiter's FSM: `menuClosed()`
 * decides whether the ARBITER needs telling; `closeMenu()`'s `endInvocation()` always fires so a
 * pending link source armed by one invocation never survives an unrelated later one that never
 * touched it (the `touched` flag `beginInvocation()` resets is otherwise stuck `true` forever after
 * the first arm, so no later close — of any kind — ever expires it).
 */
import { listen } from "@stargantt/sdk";
import type {} from "@stargantt/plugin-tree-grid";
import type {} from "@stargantt/plugin-view";
import type { ArbiterContextMenu } from "../gesture/arbiter";
import type { PeripheralWiring } from "../peripheral";
import { builtinItems } from "./builtins";
import { createLinkSource } from "./link-source";
import { createMenu } from "./menu";
import type { ContextMenuItem, ContextMenuItemProvider, ContextMenuTarget } from "./menu";

/** The renderer's DOM UI host — the shared mount point tooltip and context-menu both use. */
const OVERLAY_SELECTOR = ".sg-dom-overlay";

// docs/specs/plugins/tree-grid.md §3.1 — the grid pane keeps this class for exactly this kind of
// CSS/DOM compatibility. A menu opened on a grid row, or on the grid's blank body area, cannot live
// in the chart overlay: the chart pane clips its overflow, so a menu positioned to the left of it
// would be invisible.
const GRID_PANE_SELECTOR = ".sg-pane--grid";

/** Wires the context-menu feature into the composition. */
export function wireContextMenu(deps: PeripheralWiring): void {
  const { ctx, config, messages } = deps;

  // §6.5 — read once, never re-read afterwards.
  const insertMode = config["insertMode"] === "sibling" ? "sibling" : "child";

  /* --- §3.2 the store and the two placement readers, resolved once --- */
  // `stargantt.data-store` / `stargantt.tree-grid` / `stargantt.view` are all hard dependencies of
  // the whole interaction plugin, so all three are always present.
  const data = ctx.use("stargantt.data");
  const rows = ctx.use("stargantt.rows");
  const timeline = ctx.use("stargantt.timeline");
  const view = ctx.use("stargantt.view");

  // The pending link source (plugin-local two-step link state), one-shot: the lifetime rules live
  // in `./link-source` as named transitions.
  const linkSource = createLinkSource();

  const builtins: ContextMenuItemProvider = (target) =>
    builtinItems(
      {
        data,
        messages,
        dispatch: (key, payload) => ctx.dispatch(key, payload),
        linkSource,
        rows,
        scale: timeline,
        viewport: () => view.viewport.get(),
        insertMode,
      },
      target,
    );

  // §6.5 `items`: absent → built-ins; a function → that function in their place; `null` → none;
  // anything else unusable and treated as absent.
  const configuredItems = config["items"];
  const fallback: ContextMenuItemProvider | undefined =
    configuredItems === null
      ? undefined
      : typeof configuredItems === "function"
        ? (configuredItems as ContextMenuItemProvider)
        : builtins;

  /* --- every provider is foreign code; the feature owns the point, so it guards it --- */
  function guarded(
    provider: ContextMenuItemProvider,
    target: Readonly<ContextMenuTarget>,
  ): readonly ContextMenuItem[] {
    let result: unknown;
    try {
      result = provider(target);
    } catch (error) {
      deps.reportError(error);
      return [];
    }
    if (!Array.isArray(result)) return [];
    return (result as unknown[]).filter(usableItem);
  }

  /* --- §3 `contextmenu/items` (collect); composition happens per open, not at define time --- */
  const point = ctx.defineExtensionPoint(
    "contextmenu/items",
    (inputs: ContextMenuItemProvider[]): ContextMenuItemProvider[] => inputs,
  );

  /** The fallback first, then every contribution in contribution order. */
  function resolveItems(target: Readonly<ContextMenuTarget>): ContextMenuItem[] {
    const items: ContextMenuItem[] = [];
    if (fallback !== undefined) items.push(...guarded(fallback, target));
    for (const provider of point.get() ?? []) items.push(...guarded(provider, target));
    return items;
  }

  /* --- the menu surface, mounted in the renderer's overlay (or the root) --- */
  const doc = ctx.root.ownerDocument;
  const host: HTMLElement = ctx.root.querySelector(OVERLAY_SELECTOR) ?? ctx.root;
  const menu = createMenu({
    doc,
    host,
    label: messages.menuLabel,
    onActivate(item, target) {
      // `run` is foreign code too; the menu has already quietly closed when it executes.
      try {
        item.run(target);
      } catch (error) {
        deps.reportError(error);
      }
      // Evaluated after `run`, so a `run` that itself (re)armed or consumed the pending source
      // (link-from, link-to, cancel-link) is not immediately undone by the expiry check.
      linkSource.endInvocation();
      // This is a self-driven close from the arbiter's point of view — it never saw a `close()`
      // call for it — so the arbiter's `context` state must be told to leave.
      deps.menuClosed();
    },
    onSelfClose() {
      // Escape/Tab-inside-menu, an outside press, or focus leaving the menu: also completes the
      // pending-link invocation, and also a self-driven close the arbiter must be told about.
      linkSource.endInvocation();
      deps.menuClosed();
    },
  });
  ctx.own({ dispose: () => menu.destroy() });

  /**
   * Closes the menu (a no-op when it is already closed) and unconditionally completes the pending
   * link-source invocation (B1 fix). Every non-widget-driven close path below routes through this
   * instead of calling `menu.close()` directly, so `endInvocation()` is never missed. `onActivate`
   * and `onSelfClose` above are exempt: the widget has already closed itself by the time either
   * fires, so they call `endInvocation()` directly without a redundant `menu.close()`.
   */
  function closeMenu(): void {
    menu.close();
    linkSource.endInvocation();
  }

  // The raw `pointerdown` whose renderer event opened the currently-open menu. The two `openAt*`
  // chart-pane triggers below sit on that event's target path and the document-level closer further
  // down on its bubble path, so without this the opening press would close the menu again inside
  // its own dispatch. Identity is enough: every dispatch carries a distinct event object, so a stale
  // value can never match a later press.
  let openingPress: PointerEvent | undefined;

  /**
   * Opens for a resolved target; an empty resolution leaves the native menu untouched (nothing was
   * open before it that the arbiter did not already know about) and reports no open (minor-1 fix:
   * the caller — the arbiter — must not enter its `context` state for a press that opened nothing).
   *
   * `press` is the opening `pointerdown` for the chart-pane triggers, and `undefined` for the
   * grid-pane triggers, which arrive on the native `contextmenu` event instead — the document-level
   * closer has already seen (and ignored) the press that led there, so there is no opening press to
   * skip. `host` overrides where the menu is mounted: the grid pane, whose coordinates those
   * triggers carry, because the chart pane clips its own overflow.
   *
   * Returns whether a menu actually opened.
   */
  function openWith(
    target: Readonly<ContextMenuTarget>,
    press: PointerEvent | undefined,
    host?: HTMLElement,
  ): boolean {
    const items = resolveItems(target);
    // An empty resolution leaves the native menu untouched — including the opening press's own
    // default, which must survive so the browser's own context menu still shows — and begins no
    // link-source invocation (B1: nothing was opened, so there is nothing to later expire).
    if (items.length === 0) return false;
    linkSource.beginInvocation();
    openingPress = press;
    menu.open(items, target, target.x, target.y, host);
    // Focus moved into the menu during open, but the opening `pointerdown`'s DEFAULT action
    // (running after this dispatch) would transfer focus to the pressed pane and undo it.
    // Suppressing the default keeps focus on the first enabled entry; the native context menu is
    // unaffected (that is the `contextmenu` event's default, not `pointerdown`'s).
    if (press !== undefined && typeof press.preventDefault === "function") press.preventDefault();
    return true;
  }

  /** A grid-pane trigger: no opening press, mounted in the grid pane. Returns whether it opened. */
  function openInGridPane(target: Readonly<ContextMenuTarget>): boolean {
    const gridPane = ctx.root.querySelector<HTMLElement>(GRID_PANE_SELECTOR);
    if (gridPane === null) return false;
    return openWith(target, undefined, gridPane);
  }

  /* --- §1.3 the ArbiterContextMenu implementation ------------------------ */
  const impl: ArbiterContextMenu = {
    enabled: () => true,
    openAtHit: (e) => openWith({ kind: "hit", hitKind: e.hit.kind, id: e.hit.id, x: e.x, y: e.y }, e.event),
    openAtBackground: (e) => openWith({ kind: "background", x: e.x, y: e.y }, e.event),
    openAtRow: (e) => openInGridPane({ kind: "hit", hitKind: "row", id: e.id, x: e.x, y: e.y }),
    openAtGridBackground: (e) => openInGridPane({ kind: "gridBackground", x: e.x, y: e.y }),
    // Quiet: the arbiter itself is transitioning out of (or re-entering) `context` here, so it
    // already knows — reporting through `menuClosed()` too would re-enter the FSM transition the
    // caller is in the middle of (see the file header note). Still routes through `closeMenu()`, so
    // the link-source invocation always completes even when the arbiter drives the close (B1).
    close: () => closeMenu(),
  };
  deps.setContextMenu(impl);

  /* --- native-menu suppression -------------------------------------------- */
  // `preventDefault()` only while this feature's menu is open, so a right-press whose resolution
  // produced no entries keeps the browser's own menu. Covers both the chart pane (the native
  // `contextmenu` event fires after the `pointerdown` that opened ours) and the grid pane (whose own
  // `contextmenu` listener opens no menu and suppresses nothing itself — a plugin that answers that
  // event does both, and this bubbles-to-root listener is that plugin's other half).
  listen(ctx, ctx.root, "contextmenu", (e) => {
    if (menu.isOpen() && typeof e.preventDefault === "function") e.preventDefault();
  });

  /* --- outside-press close ------------------------------------------------- */
  // A press outside the chart (bus events cover only the panes) closes the menu; a press inside the
  // menu element is entry activation, handled by the menu itself. The press that opened the menu
  // reaches this listener later in its own dispatch and is skipped; the next genuine outside press
  // closes as specified.
  listen(ctx, doc, "pointerdown", (e) => {
    const opening = e === openingPress;
    openingPress = undefined;
    if (opening) return;
    if (menu.isOpen() && !menu.contains(e.target)) {
      closeMenu();
      deps.menuClosed();
    }
  });

  /* --- the two seams the arbiter does not carry (§1.3 "Additional context exits") --- */

  // The menu is anchored in viewport-local coordinates that scrolling invalidates.
  ctx.on("view/scrolled", () => {
    if (menu.isOpen()) {
      closeMenu();
      deps.menuClosed();
    }
  });

  // Freshness — the entries may describe stale data; also drop a pending link source whose task no
  // longer exists so the "link to" entry cannot be enabled by a dead id.
  ctx.own(
    data.tasks.subscribe(() => {
      if (menu.isOpen()) {
        closeMenu();
        deps.menuClosed();
      }
      linkSource.dropUnless((id) => data.getTask(id) !== undefined);
    }),
  );
}

/** Whether a foreign value is a usable menu entry (string id and label, callable `run`). */
function usableItem(value: unknown): value is ContextMenuItem {
  if (typeof value !== "object" || value === null) return false;
  const item = value as Partial<ContextMenuItem>;
  return (
    typeof item.id === "string" && typeof item.label === "string" && typeof item.run === "function"
  );
}
