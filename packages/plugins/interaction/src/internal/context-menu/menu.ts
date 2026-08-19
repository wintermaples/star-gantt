// docs/specs/plugins/interaction.md §6.5 — the one `.sg-context-menu` element: how entries are
// rendered, keyboard navigation, and focus handling.
/**
 * The context-menu surface — the feature's single piece of DOM.
 *
 * A menu element exists only while a menu is open; `close()` removes it, so an idle chart carries
 * no hidden menu node. This module owns rendering, roving focus and keyboard navigation; it knows
 * nothing about where entries come from or what activating one does.
 *
 * `ContextMenuTarget` / `ContextMenuItem` / `ContextMenuItemProvider` and the `contextmenu/items`
 * extension-point declaration live in the package's single declaration site (`src/types.ts`,
 * architecture.md ch. 1.4); this file re-exports them locally so this feature's own modules keep
 * importing from here.
 *
 * Close-reporting split (needed because the gesture arbiter — not this widget —
 * owns the `context` FSM state, §1.3): `close()` is quiet (no callback) and is what the arbiter
 * itself drives through `ArbiterContextMenu.close()`; the widget's own self-driven closes (Escape or
 * Tab while focus is inside the menu, an outside press, focus leaving the menu, entry activation)
 * report through `onSelfClose` / `onActivate` instead, so `wire.ts` can call the arbiter's
 * `menuClosed()` exactly where the arbiter does not already know the menu went away. Calling
 * `menuClosed()` from a quiet, arbiter-driven `close()` would double-transition the arbiter's FSM
 * (observed while porting: it would leave `state` at `"idle"` under a menu the arbiter had just told
 * this widget to re-open at a new target, e.g. `gridContextMenu`'s `"context"` row).
 */
import { styled } from "@stargantt/sdk";

export type { ContextMenuTarget, ContextMenuItem, ContextMenuItemProvider } from "../../types";
import type { ContextMenuTarget, ContextMenuItem } from "../../types";

/* ------------------------------------------------------------------ *
 * The menu widget
 * ------------------------------------------------------------------ */

export interface MenuOptions {
  /** The document the element is created in. */
  doc: Document;
  /** The element the menu is mounted under by default: the renderer's DOM overlay, or the root. */
  host: HTMLElement;
  /** Accessible name of the menu container (`aria-label`). */
  label: string;
  /** Invoked with the activated entry and the menu's target, after the menu has quietly closed. */
  onActivate(item: ContextMenuItem, target: Readonly<ContextMenuTarget>): void;
  /**
   * Invoked whenever the menu closes ITSELF — Escape or Tab while focus is inside it, an outside
   * press, or focus leaving it — never for a `close()` the caller (the arbiter) requested, and never
   * for the close that precedes an activation (`onActivate` signals that instead, since a `run` may
   * still need to read plugin-local state as it stood at close time before mutating it further).
   */
  onSelfClose(): void;
}

/** The menu's controls, as `wire.ts`'s subscriptions use them. */
export interface MenuSurface {
  /** Whether a menu is currently on screen. */
  isOpen(): boolean;
  /**
   * Opens a menu with `items` for `target`, anchored at `x`/`y` (host-local coordinates). Any
   * previously open menu is closed first, quietly. An empty `items` leaves the native menu
   * untouched (nothing opens).
   *
   * `host` overrides the element the menu is mounted in — the grid pane rather than the chart
   * overlay for a menu opened on a grid row. `x`/`y` are read in that host's box.
   */
  open(
    items: readonly ContextMenuItem[],
    target: Readonly<ContextMenuTarget>,
    x: number,
    y: number,
    host?: HTMLElement,
  ): void;
  /** Closes the menu quietly (removing its element, restoring focus) — `onSelfClose` is NOT called. */
  close(): void;
  /** Whether `node` is the menu element or one of its descendants. */
  contains(node: unknown): boolean;
  /** Closes if open, quietly; the feature's dispose hook. */
  destroy(): void;
}

interface OpenMenu {
  el: HTMLElement;
  target: Readonly<ContextMenuTarget>;
  items: readonly ContextMenuItem[];
  /** One button per item, indexed like `items`. */
  buttons: HTMLElement[];
  /** Index of the entry holding the roving focus. */
  active: number;
  /** What held the focus before the menu opened, to restore on close. */
  restoreFocus: HTMLElement | null;
}

/** Creates the (initially closed) menu surface. */
export function createMenu(options: MenuOptions): MenuSurface {
  const { doc, host: defaultHost, label, onActivate, onSelfClose } = options;

  let current: OpenMenu | null = null;

  /** Removes the element and restores focus, without reporting anything. */
  function closeQuiet(): void {
    const open = current;
    if (open === null) return;
    current = null;
    // Restore focus only when the menu still holds it — the user may have moved focus elsewhere
    // (Tab out of the menu, focus in a grid cell) before a close trigger such as a scroll or a
    // data change fires, and yanking focus back would abort what they are doing.
    const active = doc.activeElement;
    const held =
      active === open.el ||
      (active !== null && typeof open.el.contains === "function" && open.el.contains(active));
    open.el.remove();
    const restore = open.restoreFocus;
    if (held && restore !== null && typeof restore.focus === "function") restore.focus();
  }

  /** The widget decided to close itself — quiet close, then report. */
  function closeSelf(): void {
    if (current === null) return;
    closeQuiet();
    onSelfClose();
  }

  function activate(index: number): void {
    const open = current;
    if (open === null) return;
    const item = open.items[index];
    if (item === undefined || item.disabled === true) return;
    const target = open.target;
    // The menu closes before `run` executes, so an action that opens its own UI never fights the
    // menu for focus. Quiet: `onActivate` is the caller's signal for this close, not `onSelfClose`.
    closeQuiet();
    onActivate(item, target);
  }

  function focusEntry(open: OpenMenu, index: number): void {
    // A navigation key on a menu with no enabled entry resolves to -1: keep the roving state as
    // it is rather than stripping the active entry's tabindex and "focusing" buttons[-1].
    if (index < 0) return;
    const from = open.buttons[open.active];
    if (from !== undefined) from.setAttribute("tabindex", "-1");
    open.active = index;
    const to = open.buttons[index];
    if (to !== undefined) {
      to.setAttribute("tabindex", "0");
      if (typeof to.focus === "function") to.focus();
    }
  }

  /** First enabled index at or cycling from `start`, stepping by `dir`; -1 when none is enabled. */
  function nextEnabled(open: OpenMenu, start: number, dir: 1 | -1): number {
    const n = open.items.length;
    for (let i = 0; i < n; i++) {
      const idx = (((start + dir * i) % n) + n) % n;
      if (open.items[idx]?.disabled !== true) return idx;
    }
    return -1;
  }

  function onKeyDown(e: KeyboardEvent): void {
    const open = current;
    if (open === null) return;
    switch (e.key) {
      case "ArrowDown":
        focusEntry(open, nextEnabled(open, open.active + 1, 1));
        break;
      case "ArrowUp":
        focusEntry(open, nextEnabled(open, open.active - 1, -1));
        break;
      case "Home":
        focusEntry(open, nextEnabled(open, 0, 1));
        break;
      case "End":
        focusEntry(open, nextEnabled(open, open.items.length - 1, -1));
        break;
      case "Enter":
      case " ":
        activate(open.active);
        break;
      case "Escape":
        closeSelf();
        break;
      // APG menu pattern: Tab (and Shift+Tab) closes the menu. The default action is deliberately
      // left to run: `closeQuiet` (inside `closeSelf`) restores focus to the pre-open element, and
      // the browser's own focus move then proceeds from there.
      case "Tab":
        closeSelf();
        return;
      default:
        return;
    }
    if (typeof e.preventDefault === "function") e.preventDefault();
  }

  function open(
    items: readonly ContextMenuItem[],
    target: Readonly<ContextMenuTarget>,
    x: number,
    y: number,
    hostOverride?: HTMLElement,
  ): void {
    closeQuiet();
    if (items.length === 0) return;
    const host = hostOverride ?? defaultHost;

    const el = doc.createElement("div");
    el.className = "sg-context-menu";
    el.setAttribute("role", "menu");
    el.setAttribute("aria-label", label);
    // Theme custom properties first, readable literals as fallbacks. The 4px vertical padding plus
    // each entry's own padding keeps every entry's hit area >= 24px tall.
    styled(el, {
      position: "absolute",
      pointerEvents: "auto",
      zIndex: "1000",
      background: "var(--sg-menu-bg, #ffffff)",
      color: "var(--sg-menu-fg, #1f2328)",
      border: "1px solid var(--sg-menu-border, #d0d7de)",
      borderRadius: "4px",
      boxShadow: "0 4px 12px rgba(0, 0, 0, 0.15)",
      padding: "4px 0",
      minWidth: "160px",
      font: "13px/1.4 system-ui, sans-serif",
    });

    const buttons: HTMLElement[] = [];
    items.forEach((item, index) => {
      if (item.separatorBefore === true && index > 0) {
        const sep = doc.createElement("div");
        sep.className = "sg-context-menu-separator";
        sep.setAttribute("role", "separator");
        styled(sep, { borderTop: "1px solid var(--sg-menu-border, #d0d7de)", margin: "4px 0" });
        el.appendChild(sep);
      }
      const entry = doc.createElement("div");
      entry.className = "sg-context-menu-item";
      entry.setAttribute("role", "menuitem");
      entry.setAttribute("tabindex", "-1");
      entry.setAttribute("data-item-id", item.id);
      entry.textContent = item.label;
      // 6px + 6px padding around the 13px/1.4 line ≈ 30px tall — over the 24px minimum target.
      styled(entry, { padding: "6px 12px", cursor: "default", whiteSpace: "nowrap" });
      if (item.disabled === true) {
        entry.setAttribute("aria-disabled", "true");
        entry.style.opacity = "0.5";
      }
      if (typeof entry.addEventListener === "function") {
        entry.addEventListener("click", () => activate(index));
        // Focus (not just hover styling) follows the pointer, keeping one roving focus model.
        entry.addEventListener("pointerenter", () => {
          const openNow = current;
          if (openNow !== null && openNow.items[index]?.disabled !== true) focusEntry(openNow, index);
        });
      }
      el.appendChild(entry);
      buttons.push(entry);
    });

    if (typeof el.addEventListener === "function") {
      el.addEventListener("keydown", onKeyDown as EventListener);
      // APG: focus leaving the menu closes it (a programmatic focus move, a focusable control
      // elsewhere taking focus). A roving move between entries stays inside the element and is
      // ignored; a close this menu performs itself nulls `current` before any focus change it
      // causes, so its own focusout is ignored too.
      el.addEventListener("focusout", ((e: FocusEvent) => {
        const openNow = current;
        if (openNow === null || openNow.el !== el) return;
        const next = e.relatedTarget;
        if (next !== null && typeof el.contains === "function" && el.contains(next as Node)) return;
        closeSelf();
      }) as EventListener);
    }

    host.appendChild(el);

    const activeEl = doc.activeElement;
    const openMenu: OpenMenu = {
      el,
      target,
      items,
      buttons,
      active: -1,
      restoreFocus: activeEl instanceof Object ? (activeEl as HTMLElement) : null,
    };
    current = openMenu;

    // Position at the press point, clamped inside the host box where the box is measurable.
    // Measured after mounting so offsetWidth/Height reflect the rendered entries; a headless host
    // reporting zero sizes skips the clamp.
    el.style.left = "0px";
    el.style.top = "0px";
    const menuW = el.offsetWidth;
    const menuH = el.offsetHeight;
    const hostW = host.offsetWidth;
    const hostH = host.offsetHeight;
    let left = x;
    let top = y;
    if (menuW > 0 && hostW > 0 && left + menuW > hostW) left = Math.max(0, hostW - menuW);
    if (menuH > 0 && hostH > 0 && top + menuH > hostH) top = Math.max(0, hostH - menuH);
    el.style.left = `${left}px`;
    el.style.top = `${top}px`;

    // Focus moves into the menu: its first enabled entry.
    const firstEnabled = nextEnabled(openMenu, 0, 1);
    if (firstEnabled >= 0) {
      focusEntry(openMenu, firstEnabled);
    } else {
      // Every entry is disabled: focus the menu container itself, so the keyboard user is not
      // trapped — the container's keydown listener still receives Escape, and `closeQuiet` still
      // sees the menu as holding focus. Without this, focus never enters the menu while the native
      // context menu stays suppressed.
      el.setAttribute("tabindex", "-1");
      if (typeof el.focus === "function") el.focus();
    }
  }

  return {
    isOpen: () => current !== null,
    open,
    close: closeQuiet,
    contains(node: unknown): boolean {
      const el = current?.el;
      if (el === undefined) return false;
      if (node === el) return true;
      return typeof el.contains === "function" && el.contains(node as Node);
    },
    destroy: closeQuiet,
  };
}
