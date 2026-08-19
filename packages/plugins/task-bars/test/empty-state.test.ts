// @vitest-environment happy-dom
/**
 * `src/internal/empty-state.ts` — the `.sg-empty` node, without a host.
 *
 * The node is present if and only if the composed row count is 0, no paint is involved, and
 * disposal removes it. The module touches nothing but plain DOM, so a real (happy-dom) document
 * stands in for the chart body rather than a recording double.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createEmptyState } from "../src/internal/empty-state";

function harness(text = "No tasks") {
  const parent = document.createElement("div");
  let count = 0;
  const state = createEmptyState({
    document,
    parent,
    rowCount: () => count,
    text,
  });
  return {
    state,
    parent,
    setRowCount: (n: number): void => void (count = n),
    node: (): Element | null => parent.querySelector(".sg-empty"),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("createEmptyState", () => {
  it("mounts nothing until sync() runs", () => {
    const h = harness();
    expect(h.parent.children).toHaveLength(0);
    h.state.sync();
    expect(h.node()).not.toBeNull();
  });

  it("mounts one div carrying the class and the resolved wording", () => {
    const h = harness("Nothing scheduled");
    h.state.sync();
    const node = h.node();
    expect(node?.tagName).toBe("DIV");
    expect(node?.textContent).toBe("Nothing scheduled");
  });

  it("tracks the row count exactly, and never mounts a second node", () => {
    const h = harness();
    h.state.sync();
    h.state.sync();
    expect(h.parent.children).toHaveLength(1);
    const first = h.node();

    h.setRowCount(3);
    h.state.sync();
    expect(h.node()).toBeNull();
    h.state.sync();
    expect(h.parent.children).toHaveLength(0);

    h.setRowCount(0);
    h.state.sync();
    expect(h.node()).not.toBeNull();
    // A remount is a new node, not a resurrected one.
    expect(h.node()).not.toBe(first);
  });

  it("carries no interactive semantics: no role, no tabindex, no listeners", () => {
    const listen = vi.spyOn(Element.prototype, "addEventListener");
    const h = harness();
    h.state.sync();
    const node = h.node();
    expect(node?.getAttribute("role")).toBeNull();
    expect(node?.getAttribute("tabindex")).toBeNull();
    expect(listen).not.toHaveBeenCalled();
  });

  it("removes the node on dispose, and stays removed if sync() is not called again", () => {
    const h = harness();
    h.state.sync();
    h.state.dispose();
    expect(h.parent.children).toHaveLength(0);
    // Disposing twice is harmless.
    h.state.dispose();
    expect(h.parent.children).toHaveLength(0);
  });

  it("mounts again after a dispose followed by a sync, without leaving the old node behind", () => {
    const h = harness();
    h.state.sync();
    h.state.dispose();
    h.state.sync();
    expect(h.parent.children).toHaveLength(1);
  });
});
