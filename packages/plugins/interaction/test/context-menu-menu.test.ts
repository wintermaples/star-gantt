// @vitest-environment happy-dom
/**
 * DOM-level tests for `src/internal/context-menu/menu.ts` — the `.sg-context-menu` widget: opening,
 * roving keyboard focus, activation, and the quiet-`close()` vs self-driven-`onSelfClose()` /
 * `onActivate()` split (see the file's header note: the arbiter — not this widget — owns the
 * `context` FSM state, so only the widget's own self-driven closes may report back to it).
 *
 * docs/specs/plugins/interaction.md §6.5, §1.3 ("context" state, "Additional context exits").
 */
import { describe, expect, it, vi } from "vitest";
import { createMenu } from "../src/internal/context-menu/menu";
import type { ContextMenuItem, ContextMenuTarget } from "../src/internal/context-menu/menu";

function makeHost(): HTMLElement {
  const host = document.createElement("div");
  document.body.appendChild(host);
  return host;
}

function item(id: string, label: string, over: Partial<ContextMenuItem> = {}): ContextMenuItem {
  return { id, label, run: () => {}, ...over };
}

const TARGET: ContextMenuTarget = { kind: "background", x: 0, y: 0 };

function entries(host: HTMLElement): HTMLElement[] {
  return [...host.querySelectorAll<HTMLElement>('[role="menuitem"]')];
}

describe("open", () => {
  it("mounts role=menu with aria-label, one entry per item, hit areas over 24px tall", () => {
    const host = makeHost();
    const menu = createMenu({ doc: document, host, label: "Context menu", onActivate: () => {}, onSelfClose: () => {} });
    menu.open([item("a", "Alpha"), item("b", "Beta")], TARGET, 10, 10);
    const el = host.querySelector<HTMLElement>(".sg-context-menu");
    expect(el?.getAttribute("role")).toBe("menu");
    expect(el?.getAttribute("aria-label")).toBe("Context menu");
    expect(entries(host).map((e) => e.textContent)).toEqual(["Alpha", "Beta"]);
    expect(menu.isOpen()).toBe(true);
  });

  it("focuses the first enabled entry", () => {
    const host = makeHost();
    const menu = createMenu({ doc: document, host, label: "L", onActivate: () => {}, onSelfClose: () => {} });
    menu.open([item("a", "A", { disabled: true }), item("b", "B")], TARGET, 0, 0);
    expect(document.activeElement).toBe(entries(host)[1]);
    expect(entries(host)[1]?.getAttribute("tabindex")).toBe("0");
    expect(entries(host)[0]?.getAttribute("tabindex")).toBe("-1");
  });

  it("opens no element and leaves the native menu untouched when items is empty", () => {
    const host = makeHost();
    const menu = createMenu({ doc: document, host, label: "L", onActivate: () => {}, onSelfClose: () => {} });
    menu.open([], TARGET, 0, 0);
    expect(menu.isOpen()).toBe(false);
    expect(host.querySelector(".sg-context-menu")).toBeNull();
  });

  it("closes a previously open menu quietly (no onSelfClose) before opening the new one", () => {
    const host = makeHost();
    const onSelfClose = vi.fn();
    const menu = createMenu({ doc: document, host, label: "L", onActivate: () => {}, onSelfClose });
    menu.open([item("a", "A")], TARGET, 0, 0);
    menu.open([item("b", "B")], TARGET, 0, 0);
    expect(entries(host).map((e) => e.textContent)).toEqual(["B"]);
    expect(onSelfClose).not.toHaveBeenCalled();
  });

  it("mounts in an overridden host (the grid pane) instead of the default", () => {
    const defaultHost = makeHost();
    const gridPane = makeHost();
    const menu = createMenu({ doc: document, host: defaultHost, label: "L", onActivate: () => {}, onSelfClose: () => {} });
    menu.open([item("a", "A")], TARGET, 5, 5, gridPane);
    expect(defaultHost.querySelector(".sg-context-menu")).toBeNull();
    expect(gridPane.querySelector(".sg-context-menu")).not.toBeNull();
  });

  it("renders no separator above the first entry even when it asks for one", () => {
    const host = makeHost();
    const menu = createMenu({ doc: document, host, label: "L", onActivate: () => {}, onSelfClose: () => {} });
    menu.open(
      [item("x", "X", { separatorBefore: true }), item("y", "Y", { separatorBefore: true })],
      TARGET,
      0,
      0,
    );
    expect(host.querySelectorAll(".sg-context-menu-separator")).toHaveLength(1);
  });

  it("an all-disabled menu focuses its own container and stays reachable by Escape", () => {
    const host = makeHost();
    const onSelfClose = vi.fn();
    const menu = createMenu({ doc: document, host, label: "L", onActivate: () => {}, onSelfClose });
    menu.open([item("x", "X", { disabled: true }), item("y", "Y", { disabled: true })], TARGET, 0, 0);
    const el = host.querySelector<HTMLElement>(".sg-context-menu");
    expect(el?.getAttribute("tabindex")).toBe("-1");
    expect(document.activeElement).toBe(el);
    el?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(menu.isOpen()).toBe(false);
    expect(onSelfClose).toHaveBeenCalledTimes(1);
  });
});

describe("close() — quiet, no report", () => {
  it("removes the element and does not call onSelfClose", () => {
    const host = makeHost();
    const onSelfClose = vi.fn();
    const menu = createMenu({ doc: document, host, label: "L", onActivate: () => {}, onSelfClose });
    menu.open([item("a", "A")], TARGET, 0, 0);
    menu.close();
    expect(menu.isOpen()).toBe(false);
    expect(host.querySelector(".sg-context-menu")).toBeNull();
    expect(onSelfClose).not.toHaveBeenCalled();
  });

  it("is a no-op when nothing is open", () => {
    const host = makeHost();
    const menu = createMenu({ doc: document, host, label: "L", onActivate: () => {}, onSelfClose: () => {} });
    expect(() => menu.close()).not.toThrow();
  });

  it("restores focus to the element that held it before open, when the menu still holds focus", () => {
    const host = makeHost();
    const opener = document.createElement("input");
    document.body.appendChild(opener);
    opener.focus();
    const menu = createMenu({ doc: document, host, label: "L", onActivate: () => {}, onSelfClose: () => {} });
    menu.open([item("a", "A")], TARGET, 0, 0);
    menu.close();
    expect(document.activeElement).toBe(opener);
  });

  it("does not steal focus back when the user already moved it elsewhere", () => {
    const host = makeHost();
    const opener = document.createElement("input");
    const elsewhere = document.createElement("input");
    document.body.append(opener, elsewhere);
    opener.focus();
    const menu = createMenu({ doc: document, host, label: "L", onActivate: () => {}, onSelfClose: () => {} });
    menu.open([item("a", "A")], TARGET, 0, 0);
    elsewhere.focus(); // user tabbed away from the menu
    menu.close();
    expect(document.activeElement).toBe(elsewhere);
  });
});

describe("keyboard navigation", () => {
  it("ArrowDown / ArrowUp rove, skipping disabled entries", () => {
    const host = makeHost();
    const menu = createMenu({ doc: document, host, label: "L", onActivate: () => {}, onSelfClose: () => {} });
    menu.open([item("a", "A"), item("b", "B", { disabled: true }), item("c", "C")], TARGET, 0, 0);
    const el = host.querySelector<HTMLElement>(".sg-context-menu")!;
    el.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    expect(document.activeElement).toBe(entries(host)[2]); // skips disabled b
    el.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }));
    expect(document.activeElement).toBe(entries(host)[0]);
  });

  it("Home / End jump to the first / last enabled entry", () => {
    const host = makeHost();
    const menu = createMenu({ doc: document, host, label: "L", onActivate: () => {}, onSelfClose: () => {} });
    menu.open([item("a", "A"), item("b", "B"), item("c", "C", { disabled: true })], TARGET, 0, 0);
    const el = host.querySelector<HTMLElement>(".sg-context-menu")!;
    el.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true }));
    expect(document.activeElement).toBe(entries(host)[1]); // c is disabled
    el.dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true }));
    expect(document.activeElement).toBe(entries(host)[0]);
  });

  it("Enter / Space activate the focused entry: quiet close, then onActivate", () => {
    const host = makeHost();
    const activated: string[] = [];
    const onSelfClose = vi.fn();
    const run = vi.fn();
    const menu = createMenu({
      doc: document,
      host,
      label: "L",
      onActivate: (it) => activated.push(it.id),
      onSelfClose,
    });
    menu.open([item("a", "A", { run })], TARGET, 0, 0);
    const el = host.querySelector<HTMLElement>(".sg-context-menu")!;
    el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(menu.isOpen()).toBe(false);
    expect(activated).toEqual(["a"]);
    expect(onSelfClose).not.toHaveBeenCalled(); // onActivate signals this, not onSelfClose
    // `run` itself is the caller's (wire.ts's onActivate) responsibility, not the widget's.
    expect(run).not.toHaveBeenCalled();
  });

  it("does not activate a disabled entry", () => {
    const host = makeHost();
    const activated: string[] = [];
    const menu = createMenu({
      doc: document,
      host,
      label: "L",
      onActivate: (it) => activated.push(it.id),
      onSelfClose: () => {},
    });
    menu.open([item("a", "A"), item("b", "B", { disabled: true })], TARGET, 0, 0);
    entries(host)[1]?.dispatchEvent(new Event("click", { bubbles: true }));
    expect(menu.isOpen()).toBe(true);
    expect(activated).toEqual([]);
  });

  it("Escape closes and reports through onSelfClose", () => {
    const host = makeHost();
    const onSelfClose = vi.fn();
    const menu = createMenu({ doc: document, host, label: "L", onActivate: () => {}, onSelfClose });
    menu.open([item("a", "A")], TARGET, 0, 0);
    const el = host.querySelector<HTMLElement>(".sg-context-menu")!;
    el.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(menu.isOpen()).toBe(false);
    expect(onSelfClose).toHaveBeenCalledTimes(1);
  });

  it("Tab closes, restores focus, reports through onSelfClose, and does not preventDefault", () => {
    const host = makeHost();
    const opener = document.createElement("input");
    document.body.appendChild(opener);
    opener.focus();
    const onSelfClose = vi.fn();
    const menu = createMenu({ doc: document, host, label: "L", onActivate: () => {}, onSelfClose });
    menu.open([item("a", "A")], TARGET, 0, 0);
    const el = host.querySelector<HTMLElement>(".sg-context-menu")!;
    const event = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
    el.dispatchEvent(event);
    expect(menu.isOpen()).toBe(false);
    expect(document.activeElement).toBe(opener);
    expect(onSelfClose).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(false);
  });
});

describe("focusout closes only when focus truly leaves the menu", () => {
  it("closes and reports when focus moves outside the menu", () => {
    const host = makeHost();
    const elsewhere = document.createElement("input");
    document.body.appendChild(elsewhere);
    const onSelfClose = vi.fn();
    const menu = createMenu({ doc: document, host, label: "L", onActivate: () => {}, onSelfClose });
    menu.open([item("a", "A")], TARGET, 0, 0);
    const el = host.querySelector<HTMLElement>(".sg-context-menu")!;
    el.dispatchEvent(new FocusEvent("focusout", { relatedTarget: elsewhere, bubbles: true }));
    expect(menu.isOpen()).toBe(false);
    expect(onSelfClose).toHaveBeenCalledTimes(1);
  });

  it("stays open when focus moves between two of its own entries", () => {
    const host = makeHost();
    const onSelfClose = vi.fn();
    const menu = createMenu({ doc: document, host, label: "L", onActivate: () => {}, onSelfClose });
    menu.open([item("a", "A"), item("b", "B")], TARGET, 0, 0);
    const el = host.querySelector<HTMLElement>(".sg-context-menu")!;
    const second = entries(host)[1]!;
    el.dispatchEvent(new FocusEvent("focusout", { relatedTarget: second, bubbles: true }));
    expect(menu.isOpen()).toBe(true);
    expect(onSelfClose).not.toHaveBeenCalled();
  });
});

describe("contains", () => {
  it("is true for the menu element and its descendants, false otherwise", () => {
    const host = makeHost();
    const menu = createMenu({ doc: document, host, label: "L", onActivate: () => {}, onSelfClose: () => {} });
    menu.open([item("a", "A")], TARGET, 0, 0);
    const el = host.querySelector<HTMLElement>(".sg-context-menu")!;
    expect(menu.contains(el)).toBe(true);
    expect(menu.contains(entries(host)[0])).toBe(true);
    expect(menu.contains(document.body)).toBe(false);
  });

  it("is false once nothing is open", () => {
    const host = makeHost();
    const menu = createMenu({ doc: document, host, label: "L", onActivate: () => {}, onSelfClose: () => {} });
    expect(menu.contains(host)).toBe(false);
  });
});

describe("destroy", () => {
  it("closes quietly, without reporting", () => {
    const host = makeHost();
    const onSelfClose = vi.fn();
    const menu = createMenu({ doc: document, host, label: "L", onActivate: () => {}, onSelfClose });
    menu.open([item("a", "A")], TARGET, 0, 0);
    menu.destroy();
    expect(menu.isOpen()).toBe(false);
    expect(onSelfClose).not.toHaveBeenCalled();
  });
});
