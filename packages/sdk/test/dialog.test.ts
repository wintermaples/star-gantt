/**
 * `createDialog` (docs/specs/sdk.md, Module: sdk/dialog): the shared chrome every panel-bearing
 * plugin floats over the chart — header, scrolling body, lazy footer, containment, Escape, the
 * modal backdrop and focus trap, and the header drag.
 */
import { describe, expect, it, vi } from "vitest";
import { asElement, fakeHost, pointerEvent } from "./_dom";
import type { FakeDocument, FakeElement } from "./_dom";
import { createDialog } from "../src/index";
import type { Dialog, DialogOptions } from "../src/index";

interface Fixture {
  harness: { document: FakeDocument };
  host: FakeElement;
  dialog: Dialog;
  /** Fires an event on an element, whatever depth it sits at. */
  fire(el: FakeElement | HTMLElement, type: string, event?: unknown): void;
}

function fixture(options: Partial<DialogOptions> = {}): Fixture {
  const host = fakeHost(800, 600);
  const dialog = createDialog({
    host: asElement(host),
    className: "sg-test-dialog",
    label: "Test dialog",
    ...options,
  });
  return {
    harness: { document: host.ownerDocument },
    host,
    dialog,
    fire(el, type, event) {
      (el as unknown as FakeElement).fire(type, event);
    },
  };
}

/** The element the dialog mounted into the host — the backdrop when modal, else the box. */
const mountedIn = (host: FakeElement): FakeElement => host.children[0] as FakeElement;

describe("chrome", () => {
  it("mounts a labelled dialog box with a header, a body and no footer", () => {
    const { host, dialog } = fixture();
    const root = dialog.root as unknown as FakeElement;
    expect(mountedIn(host)).toBe(root);
    expect(root.className).toBe("sg-test-dialog");
    expect(root.getAttribute("role")).toBe("dialog");
    expect(root.getAttribute("aria-label")).toBe("Test dialog");
    expect(root.getAttribute("tabindex")).toBe("-1");
    expect(root.getAttribute("aria-modal")).toBeNull();
    // Header, body — and nothing else, because the footer was never asked for.
    expect(root.children.map((c) => c.className)).toEqual([
      "sg-test-dialog__header",
      "sg-test-dialog__body",
    ]);
    expect((dialog.header as unknown as FakeElement).textContent).toBe("Test dialog");
  });

  it("reads its surfaces from the dialog token family, not the panel one", () => {
    const { dialog } = fixture();
    const style = (dialog.root as unknown as FakeElement).style;
    expect(style["background"]).toBe("var(--sg-dialog-bg, #ffffff)");
    expect(style["color"]).toBe("var(--sg-dialog-fg, #1c1917)");
    expect(style["border"]).toBe("1px solid var(--sg-dialog-border, #d6d3d1)");
    expect(style["boxShadow"]).toBe("0 6px 24px var(--sg-dialog-shadow, rgba(0, 0, 0, 0.25))");
    expect((dialog.header as unknown as FakeElement).style["background"]).toBe(
      "var(--sg-dialog-header-bg, #f4f6f8)",
    );
  });

  it("honours the size and offset overrides", () => {
    const { dialog } = fixture({ width: "min(680px,92%)", top: 16, maxHeight: "85%" });
    const style = (dialog.root as unknown as FakeElement).style;
    expect(style["width"]).toBe("min(680px,92%)");
    expect(style["top"]).toBe("16px");
    expect(style["maxHeight"]).toBe("85%");
  });

  it("builds the footer on first read and reuses it afterwards", () => {
    const { dialog } = fixture();
    const root = dialog.root as unknown as FakeElement;
    expect(root.children).toHaveLength(2);
    const first = dialog.footer;
    expect(root.children).toHaveLength(3);
    expect(dialog.footer).toBe(first);
    expect(root.children).toHaveLength(3);
    expect((first as unknown as FakeElement).className).toBe("sg-test-dialog__footer");
  });

  it("adds a header close button only when one is asked for", () => {
    const onClose = vi.fn();
    const plain = fixture();
    expect((plain.dialog.header as unknown as FakeElement).children).toHaveLength(1);

    const { dialog, fire } = fixture({ closeButton: "Close", onClose });
    const header = dialog.header as unknown as FakeElement;
    const button = header.children[1] as FakeElement;
    expect(button.tagName.toUpperCase()).toBe("BUTTON");
    expect(button.textContent).toBe("Close");
    expect(button.getAttribute("type")).toBe("button");
    fire(button, "click");
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe("containment and Escape", () => {
  it("stops a press inside the dialog from reaching the chart", () => {
    const { dialog, fire } = fixture();
    const stopPropagation = vi.fn();
    fire(dialog.root, "pointerdown", { type: "pointerdown", stopPropagation });
    expect(stopPropagation).toHaveBeenCalledTimes(1);
  });

  it("closes on Escape and swallows the key", () => {
    const onClose = vi.fn();
    const { dialog, fire } = fixture({ onClose });
    const stopPropagation = vi.fn();
    fire(dialog.root, "keydown", { type: "keydown", key: "Escape", stopPropagation });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(stopPropagation).toHaveBeenCalledTimes(1);
  });

  it("ignores every other key", () => {
    const onClose = vi.fn();
    const { dialog, fire } = fixture({ onClose });
    fire(dialog.root, "keydown", { type: "keydown", key: "a" });
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe("modal", () => {
  it("wraps the box in a backdrop and marks it modal", () => {
    const { host, dialog } = fixture({ modal: true });
    const backdrop = mountedIn(host);
    expect(backdrop.className).toBe("sg-test-dialog__backdrop");
    expect(backdrop.children[0]).toBe(dialog.root as unknown as FakeElement);
    expect((dialog.root as unknown as FakeElement).getAttribute("aria-modal")).toBe("true");
    expect(backdrop.style["background"]).toBe("var(--sg-dialog-backdrop, rgba(16, 22, 29, 0.4))");
  });

  it("closes on a press on the dim but not on one inside the box", () => {
    const onClose = vi.fn();
    const { host, dialog } = fixture({ modal: true, onClose });
    const backdrop = mountedIn(host);
    backdrop.fire("pointerdown", { type: "pointerdown", target: backdrop });
    expect(onClose).toHaveBeenCalledTimes(1);
    backdrop.fire("pointerdown", { type: "pointerdown", target: dialog.root });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("wraps Tab and Shift+Tab around the box's focusables", () => {
    const { harness, host, dialog } = fixture({ modal: true });
    const doc = harness.document;
    const first = doc.createElement("input");
    const last = doc.createElement("button");
    (dialog.body as unknown as FakeElement).appendChild(first);
    (dialog.footer as unknown as FakeElement).appendChild(last);
    const backdrop = mountedIn(host);

    last.focus();
    const forward = { type: "keydown", key: "Tab", shiftKey: false, preventDefault: vi.fn() };
    backdrop.fire("keydown", forward);
    expect(forward.preventDefault).toHaveBeenCalledTimes(1);
    expect(first.focused).toBe(true);

    first.focus();
    const back = { type: "keydown", key: "Tab", shiftKey: true, preventDefault: vi.fn() };
    backdrop.fire("keydown", back);
    expect(back.preventDefault).toHaveBeenCalledTimes(1);
    expect(last.focused).toBe(true);
  });

  it("leaves Tab alone in a non-modal dialog — it is not a trap", () => {
    const { harness, dialog } = fixture();
    const input = harness.document.createElement("input");
    (dialog.body as unknown as FakeElement).appendChild(input);
    const event = { type: "keydown", key: "Tab", shiftKey: false, preventDefault: vi.fn() };
    (dialog.root as unknown as FakeElement).fire("keydown", event);
    expect(event.preventDefault).not.toHaveBeenCalled();
  });
});

describe("focus()", () => {
  it("focuses the first focusable, falling back to the box", () => {
    const { harness, dialog } = fixture();
    dialog.focus();
    expect((dialog.root as unknown as FakeElement).focused).toBe(true);
    const input = harness.document.createElement("input");
    (dialog.body as unknown as FakeElement).appendChild(input);
    dialog.focus();
    expect(input.focused).toBe(true);
  });

  it("does not treat a child lacking both hasAttribute and getAttribute as hidden", () => {
    // A double that answers neither probe: `hasAttribute?.()` is `undefined` and so is
    // `getAttribute?.()`. The old fallback compared that `undefined` result to `null` directly
    // (`undefined !== null` is `true`), so every such child read as hidden and was skipped.
    const { dialog } = fixture();
    const bare = { tagName: "BUTTON", style: {}, children: [] } as unknown as FakeElement;
    (dialog.body as unknown as FakeElement).children.push(bare);
    dialog.focus();
    expect((bare as unknown as { focus?: () => void }).focus).toBeUndefined();
    // `focusRing` found it eligible (not hidden), so `focus()` tried to call `.focus` on it — a
    // no-op here since the bare double has none — rather than falling back to the box.
    expect((dialog.root as unknown as FakeElement).focused).toBe(false);
  });

  it("treats a lowercase tagName the same as uppercase in the focus ring", () => {
    // A real SVG `<a>` reports a lowercase `tagName`, and a double may too.
    const { dialog } = fixture();
    const lower = { tagName: "button", style: {}, children: [], focused: false } as unknown as
      FakeElement & { focus(): void };
    (lower as unknown as { focus: () => void }).focus = function (this: typeof lower) {
      this.focused = true;
    };
    (dialog.body as unknown as FakeElement).children.push(lower as unknown as FakeElement);
    dialog.focus();
    expect(lower.focused).toBe(true);
  });
});

describe("drag", () => {
  function draggable(): Fixture & { root: FakeElement; header: FakeElement } {
    const f = fixture({ top: 24 });
    const root = f.dialog.root as unknown as FakeElement;
    const header = f.dialog.header as unknown as FakeElement;
    root.rect = { left: 220, top: 24, width: 360, height: 200 };
    header.rect = { left: 220, top: 24, width: 360, height: 32 };
    return { ...f, root, header };
  }

  it("moves the box by the pointer delta", () => {
    const { harness, header, root } = draggable();
    header.fire("pointerdown", pointerEvent(300, 30, { pointerId: 1 }));
    harness.document.fire("pointermove", pointerEvent(380, 70, { pointerId: 1 }));
    expect(root.style["transform"]).toBe("translate(calc(-50% + 80px), 40px)");
  });

  it("clamps the box inside the host instead of letting it leave", () => {
    const { harness, header, root } = draggable();
    header.fire("pointerdown", pointerEvent(300, 30, { pointerId: 1 }));
    // Far past the left and top edges: the box stops at the host's origin.
    harness.document.fire("pointermove", pointerEvent(-9000, -9000, { pointerId: 1 }));
    expect(root.style["transform"]).toBe("translate(calc(-50% + -220px), -24px)");
    // Far past the right and bottom: the right edge stops at 800 − 360, and the *header* — not
    // the box's bottom — is what the bottom clamp keeps on screen.
    harness.document.fire("pointermove", pointerEvent(9000, 9000, { pointerId: 1 }));
    expect(root.style["transform"]).toBe("translate(calc(-50% + 220px), 544px)");
  });

  it("accumulates across successive drags", () => {
    const { harness, header, root } = draggable();
    header.fire("pointerdown", pointerEvent(300, 30, { pointerId: 1 }));
    harness.document.fire("pointermove", pointerEvent(320, 40, { pointerId: 1 }));
    harness.document.fire("pointerup", pointerEvent(320, 40, { pointerId: 1 }));
    root.rect = { left: 240, top: 34, width: 360, height: 200 };
    header.rect = { left: 240, top: 34, width: 360, height: 32 };
    header.fire("pointerdown", pointerEvent(320, 40, { pointerId: 1 }));
    harness.document.fire("pointermove", pointerEvent(330, 45, { pointerId: 1 }));
    expect(root.style["transform"]).toBe("translate(calc(-50% + 30px), 15px)");
  });

  it("stops moving once the pointer is released", () => {
    const { harness, header, root } = draggable();
    header.fire("pointerdown", pointerEvent(300, 30, { pointerId: 1 }));
    harness.document.fire("pointerup", pointerEvent(300, 30, { pointerId: 1 }));
    harness.document.fire("pointermove", pointerEvent(500, 300, { pointerId: 1 }));
    expect(root.style["transform"]).toBe("translate(calc(-50% + 0px), 0px)");
  });

  it("does not start from a press on the header's own button", () => {
    const { harness, dialog, header, root } = draggable();
    const button = (dialog.header as unknown as FakeElement).children[1] as FakeElement | undefined;
    expect(button).toBeUndefined();
    const own = harness.document.createElement("button");
    header.appendChild(own);
    header.fire("pointerdown", pointerEvent(300, 30, { pointerId: 1, target: own }));
    harness.document.fire("pointermove", pointerEvent(500, 300, { pointerId: 1 }));
    expect(root.style["transform"]).toBe("translate(calc(-50% + 0px), 0px)");
  });

  it("is off, header cursor and all, when the caller declines it", () => {
    const { harness, dialog } = fixture({ draggable: false });
    const header = dialog.header as unknown as FakeElement;
    const root = dialog.root as unknown as FakeElement;
    root.rect = { left: 220, top: 24, width: 360, height: 200 };
    expect(header.style["cursor"]).toBeUndefined();
    header.fire("pointerdown", pointerEvent(300, 30, { pointerId: 1 }));
    harness.document.fire("pointermove", pointerEvent(500, 300, { pointerId: 1 }));
    expect(root.style["transform"]).toBe("translate(calc(-50% + 0px), 0px)");
  });

  it("translates without the centring correction when modal", () => {
    const { harness, dialog } = fixture({ modal: true });
    const root = dialog.root as unknown as FakeElement;
    const header = dialog.header as unknown as FakeElement;
    root.rect = { left: 220, top: 200, width: 360, height: 200 };
    header.rect = { left: 220, top: 200, width: 360, height: 32 };
    header.fire("pointerdown", pointerEvent(300, 210, { pointerId: 1 }));
    harness.document.fire("pointermove", pointerEvent(340, 230, { pointerId: 1 }));
    expect(root.style["transform"]).toBe("translate(40px, 20px)");
  });
});

describe("focus restore on dispose (WCAG 2.4.3)", () => {
  it("hands focus back to whatever had it when the dialog opened", () => {
    const host = fakeHost(800, 600);
    const doc = host.ownerDocument;
    const opener = doc.createElement("button");
    host.appendChild(opener);
    opener.focus();
    expect(opener.focused).toBe(true);

    const dialog = createDialog({ host: asElement(host), className: "sg-test-dialog", label: "Test" });
    dialog.focus();
    expect(opener.focused).toBe(false);

    dialog.dispose();
    expect(opener.focused).toBe(true);
    expect(doc.activeElement).toBe(opener);
  });

  it("does not refocus an opener that is no longer connected", () => {
    const host = fakeHost(800, 600);
    const doc = host.ownerDocument;
    const container = doc.createElement("div");
    const opener = doc.createElement("button");
    container.appendChild(opener);
    // Not attached anywhere the fake tree calls "connected" — a detached subtree, as an already
    // removed panel would leave behind.
    opener.focus();
    const refocus = vi.spyOn(opener, "focus");

    const dialog = createDialog({ host: asElement(host), className: "sg-test-dialog", label: "Test" });
    dialog.dispose();
    // Not forced onto a dead element — dispose() never calls back into it.
    expect(refocus).not.toHaveBeenCalled();
  });

  it("does nothing when nothing held focus before the dialog opened", () => {
    const host = fakeHost(800, 600);
    const doc = host.ownerDocument;
    expect(doc.activeElement).toBeNull();
    const dialog = createDialog({ host: asElement(host), className: "sg-test-dialog", label: "Test" });
    dialog.focus();
    expect(() => dialog.dispose()).not.toThrow();
  });

  it("does not yank focus back once the user has moved it elsewhere", () => {
    const host = fakeHost(800, 600);
    const doc = host.ownerDocument;
    const opener = doc.createElement("button");
    host.appendChild(opener);
    opener.focus();

    const dialog = createDialog({ host: asElement(host), className: "sg-test-dialog", label: "Test" });
    dialog.focus();
    expect(opener.focused).toBe(false);

    // The user moves on to something else entirely — outside the dialog — before it closes.
    const elsewhere = doc.createElement("button");
    host.appendChild(elsewhere);
    elsewhere.focus();

    dialog.dispose();
    // Focus stays where the user put it; the opener is not stolen back.
    expect(elsewhere.focused).toBe(true);
    expect(opener.focused).toBe(false);
  });
});

describe("resize", () => {
  it("adds a decorative grip that sizes the box and drops the proportional caps", () => {
    const { harness, dialog } = fixture({ resizable: true });
    const root = dialog.root as unknown as FakeElement;
    root.rect = { left: 220, top: 24, width: 360, height: 200 };
    const grip = root.children.find((c) => c.className === "sg-test-dialog__grip");
    expect(grip).toBeDefined();
    expect((grip as FakeElement).getAttribute("aria-hidden")).toBe("true");
    (grip as FakeElement).fire("pointerdown", pointerEvent(580, 224, { pointerId: 2 }));
    harness.document.fire("pointermove", pointerEvent(640, 304, { pointerId: 2 }));
    expect(root.style["width"]).toBe("420px");
    expect(root.style["height"]).toBe("280px");
    expect(root.style["maxWidth"]).toBe("none");
    expect(root.style["maxHeight"]).toBe("none");
  });

  it("has no grip unless one is asked for", () => {
    const { dialog } = fixture();
    const root = dialog.root as unknown as FakeElement;
    expect(root.children.some((c) => c.className === "sg-test-dialog__grip")).toBe(false);
  });

  it("clamps against the host's far edges from wherever the drag left the box, not the host's raw size", () => {
    const { harness, dialog } = fixture({ draggable: true, resizable: true, top: 24 });
    const root = dialog.root as unknown as FakeElement;
    const header = dialog.header as unknown as FakeElement;
    root.rect = { left: 220, top: 24, width: 360, height: 200 };
    header.rect = { left: 220, top: 24, width: 360, height: 32 };

    // Drag the box hard against the host's right edge first: at 800×600 with a 360-wide box, the
    // drag clamp stops its left edge at 800 − 360 = 440.
    header.fire("pointerdown", pointerEvent(300, 30, { pointerId: 1 }));
    harness.document.fire("pointermove", pointerEvent(9000, 30, { pointerId: 1 }));
    harness.document.fire("pointerup", pointerEvent(9000, 30, { pointerId: 1 }));
    root.rect = { left: 440, top: 24, width: 360, height: 200 };

    const grip = root.children.find((c) => c.className === "sg-test-dialog__grip") as FakeElement;
    grip.fire("pointerdown", pointerEvent(796, 220, { pointerId: 2 }));
    // A resize that would have reached 420px wide from the box's own top-left (440) would land at
    // 860 — past the 800px host. It must stop at the host's edge instead: 800 − 440 = 360, i.e. no
    // growth at all from where the drag left it.
    harness.document.fire("pointermove", pointerEvent(816, 220, { pointerId: 2 }));
    expect(root.style["width"]).toBe("360px");
  });

  it("releases the grip's pointer capture on release, matching the drag path", () => {
    const { harness, dialog } = fixture({ resizable: true });
    const root = dialog.root as unknown as FakeElement;
    root.rect = { left: 220, top: 24, width: 360, height: 200 };
    const grip = root.children.find((c) => c.className === "sg-test-dialog__grip") as FakeElement;
    grip.fire("pointerdown", pointerEvent(580, 224, { pointerId: 2 }));
    expect(grip.captured).toContain(2);
    harness.document.fire("pointerup", pointerEvent(580, 224, { pointerId: 2 }));
    expect(grip.captured).not.toContain(2);
  });
});

describe("ownership", () => {
  it("removes its own listeners and unmounts on dispose, idempotently", () => {
    const onClose = vi.fn();
    const { host, dialog } = fixture({ onClose });
    const root = dialog.root as unknown as FakeElement;
    dialog.dispose();
    expect(host.children).toHaveLength(0);
    root.fire("keydown", { type: "keydown", key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
    dialog.dispose();
    expect(host.children).toHaveLength(0);
  });

  it("keeps its listener list to itself rather than growing the plugin's own bag", () => {
    // The dialog is created and destroyed on every open/close. Were the listeners handed to the
    // plugin's `ctx.own()` bag, fifty opens would leave fifty dead generations in it; instead the
    // plugin owns one disposable and the dialog drains its own list.
    const onClose = vi.fn();
    const { host, dialog } = fixture({ onClose, resizable: true });
    const doc = (host as FakeElement).ownerDocument;
    // Drag and resize each wire their own `gesture()` (drag defaults on; resize was asked for
    // here), so this is one `pointermove` listener per gesture rather than one shared listener.
    expect(doc.listenerCount("pointermove")).toBe(2);
    expect((dialog.root as unknown as FakeElement).deepListenerCount()).toBeGreaterThan(0);
    dialog.dispose();
    expect(doc.listenerCount()).toBe(0);
    expect((dialog.root as unknown as FakeElement).deepListenerCount()).toBe(0);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("unmounts the backdrop, not just the box, when modal", () => {
    const { host, dialog } = fixture({ modal: true });
    dialog.dispose();
    expect(host.children).toHaveLength(0);
  });
});
