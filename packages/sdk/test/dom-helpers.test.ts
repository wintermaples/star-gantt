/**
 * The DOM and frame micro-helpers of `@stargantt/sdk` (docs/specs/sdk.md, Modules: sdk/dom,
 * sdk/frame): `isEditableTarget`, `findUp`, `focusRestorer`, `styled`, `sameIdSet`,
 * `alignHalfPixel`.
 */
import { describe, expect, it } from "vitest";
import {
  alignHalfPixel,
  findUp,
  focusRestorer,
  isEditableTarget,
  sameIdSet,
  styled,
} from "../src/index";
import { FakeElement } from "./_dom";

/** A minimal element-like node for the ancestor walks. */
function node(init: {
  tag?: string;
  contentEditable?: boolean;
  disabled?: boolean;
  attrs?: Record<string, string>;
  parent?: unknown;
}): Record<string, unknown> {
  return {
    tagName: init.tag,
    isContentEditable: init.contentEditable,
    disabled: init.disabled,
    getAttribute: (name: string) => init.attrs?.[name] ?? null,
    parentNode: init.parent ?? null,
  };
}

describe("isEditableTarget", () => {
  it("accepts input, textarea and select tags, case-insensitively", () => {
    expect(isEditableTarget(node({ tag: "INPUT" }))).toBe(true);
    expect(isEditableTarget(node({ tag: "textarea" }))).toBe(true);
    expect(isEditableTarget(node({ tag: "select" }))).toBe(true);
    expect(isEditableTarget(node({ tag: "DIV" }))).toBe(false);
  });

  it("accepts contenteditable regions and their descendants", () => {
    const region = node({ tag: "DIV", attrs: { contenteditable: "" } });
    expect(isEditableTarget(region)).toBe(true);
    expect(isEditableTarget(node({ tag: "SPAN", parent: region }))).toBe(true);
    expect(isEditableTarget(node({ tag: "DIV", contentEditable: true }))).toBe(true);
    expect(isEditableTarget(node({ tag: "DIV", attrs: { contenteditable: "false" } }))).toBe(false);
  });

  it("rejects null, plain objects and unrelated elements", () => {
    expect(isEditableTarget(null)).toBe(false);
    expect(isEditableTarget(undefined)).toBe(false);
    expect(isEditableTarget(node({ tag: "BUTTON" }))).toBe(false);
  });

  it("rejects a disabled input/textarea/select — it cannot own keystrokes", () => {
    expect(isEditableTarget(node({ tag: "INPUT", disabled: true }))).toBe(false);
    expect(isEditableTarget(node({ tag: "textarea", disabled: true }))).toBe(false);
    expect(isEditableTarget(node({ tag: "select", disabled: true }))).toBe(false);
    // A falsy-but-not-strictly-true `disabled` (e.g. absent or explicitly false) still counts as
    // editable — only `disabled === true` opts out.
    expect(isEditableTarget(node({ tag: "INPUT", disabled: false }))).toBe(true);
  });
});

describe("findUp", () => {
  it("returns the first matching element walking up, excluding the root", () => {
    const root = node({ tag: "DIV", attrs: { "data-hit": "root" } });
    const cell = node({ tag: "TD", attrs: { "data-hit": "cell" }, parent: root });
    const leaf = node({ tag: "SPAN", parent: cell });
    const byAttr = (el: HTMLElement): boolean => el.getAttribute("data-hit") !== null;
    expect(findUp(leaf, byAttr, root)).toBe(cell);
    expect(findUp(root, byAttr, root)).toBeNull();
    expect(findUp(leaf, (el) => el.getAttribute("data-none") !== null, root)).toBeNull();
    expect(findUp(null, byAttr, root)).toBeNull();
  });

  it("walks to the top of the tree when no root is given", () => {
    const top = node({ tag: "MAIN", attrs: { "data-hit": "top" } });
    const leaf = node({ tag: "SPAN", parent: top });
    expect(findUp(leaf, (el) => el.getAttribute("data-hit") !== null)).toBe(top);
  });
});

describe("focusRestorer", () => {
  it("saves the active element and focuses it back exactly once", () => {
    let focused = 0;
    const previous = { focus: () => void (focused += 1) };
    const doc = { activeElement: previous as unknown };
    const restorer = focusRestorer(doc);
    restorer.save();
    doc.activeElement = { focus: () => {} }; // the dialog took the focus
    restorer.restore();
    expect(focused).toBe(1);
    restorer.restore(); // nothing saved any more
    expect(focused).toBe(1);
  });

  it("tolerates a saved target without focus(), and restore without save", () => {
    const restorer = focusRestorer({ activeElement: {} });
    expect(() => restorer.restore()).not.toThrow();
    restorer.save();
    expect(() => restorer.restore()).not.toThrow();
  });
});

describe("styled", () => {
  it("assigns every record entry onto el.style", () => {
    const el = new FakeElement("div", null as never);
    styled(el, { position: "absolute", maxWidth: "100%" });
    expect(el.style["position"]).toBe("absolute");
    expect(el.style["maxWidth"]).toBe("100%");
  });
});

describe("sameIdSet", () => {
  it("compares sets by membership", () => {
    expect(sameIdSet(new Set([1, 2]), new Set([2, 1]))).toBe(true);
    expect(sameIdSet(new Set(), new Set())).toBe(true);
    expect(sameIdSet(new Set([1]), new Set([1, 2]))).toBe(false);
    expect(sameIdSet(new Set([1, 3]), new Set([1, 2]))).toBe(false);
  });
});

describe("alignHalfPixel", () => {
  it("rounds to the nearest half-pixel center", () => {
    expect(alignHalfPixel(10)).toBe(10.5);
    expect(alignHalfPixel(10.4)).toBe(10.5);
    expect(alignHalfPixel(10.6)).toBe(11.5);
    expect(alignHalfPixel(-0.4)).toBe(0.5);
  });
});
