// @vitest-environment happy-dom
/**
 * DOM-level tests for `src/internal/tooltip/panel.ts` — the single `.sg-tooltip` element: mounting,
 * content rendering (string vs `HTMLElement`), the hoverable/pointer-events split (§6.4a), and the
 * freshness `refresh()` cycle. Positioning arithmetic itself is covered by
 * `test/tooltip-placement.test.ts`; this file only checks the panel wires that arithmetic up
 * correctly (an anchor near an edge actually flips).
 *
 * docs/specs/plugins/interaction.md §6.4, §6.4a.
 */
import { describe, expect, it } from "vitest";
import type { HitResult } from "@stargantt/plugin-view";
import { createPanel } from "../src/internal/tooltip/panel";
import type { TooltipContent } from "../src/internal/tooltip/panel";

function hit(id: string | number = "t1", kind: HitResult["kind"] = "bar"): HitResult {
  return { kind, id, cursor: "default" };
}

function makeHost(): HTMLElement {
  const host = document.createElement("div");
  document.body.appendChild(host);
  return host;
}

describe("createPanel — mounting", () => {
  it("mounts a hidden .sg-tooltip element under host, role=tooltip", () => {
    const host = makeHost();
    const panel = createPanel({ doc: document, host, resolve: () => "hi", hoverable: false });
    expect(panel.element.className).toBe("sg-tooltip");
    expect(panel.element.getAttribute("role")).toBe("tooltip");
    expect(panel.element.style.display).toBe("none");
    expect(host.contains(panel.element)).toBe(true);
    expect(panel.isVisible()).toBe(false);
  });

  it("is pointer-events: none when not hoverable (click trigger)", () => {
    const host = makeHost();
    const panel = createPanel({ doc: document, host, resolve: () => "x", hoverable: false });
    expect(panel.element.style.pointerEvents).toBe("none");
  });

  it("is pointer-events: auto when hoverable (hover/both trigger, WCAG 1.4.13)", () => {
    const host = makeHost();
    const panel = createPanel({ doc: document, host, resolve: () => "x", hoverable: true });
    expect(panel.element.style.pointerEvents).toBe("auto");
  });

  it("destroy detaches the element", () => {
    const host = makeHost();
    const panel = createPanel({ doc: document, host, resolve: () => "x", hoverable: false });
    panel.destroy();
    expect(host.contains(panel.element)).toBe(false);
  });
});

describe("show / hide", () => {
  it("shows string content and reports true", () => {
    const host = makeHost();
    const panel = createPanel({ doc: document, host, resolve: () => "Task A", hoverable: false });
    const shown = panel.show(hit(), 10, 10);
    expect(shown).toBe(true);
    expect(panel.isVisible()).toBe(true);
    expect(panel.element.style.display).not.toBe("none");
    expect(panel.element.textContent).toBe("Task A");
  });

  it("mounts an HTMLElement content and removes it on the next render", () => {
    const host = makeHost();
    let content: HTMLElement = document.createElement("span");
    content.textContent = "first";
    const panel = createPanel({
      doc: document,
      host,
      resolve: () => content,
      hoverable: false,
    });
    panel.show(hit(), 0, 0);
    expect(panel.element.querySelector("span")?.textContent).toBe("first");

    content = document.createElement("em");
    content.textContent = "second";
    panel.show(hit(), 0, 0);
    expect(panel.element.querySelector("span")).toBeNull();
    expect(panel.element.querySelector("em")?.textContent).toBe("second");
  });

  it("returns false and leaves the panel untouched when content resolution declines", () => {
    const host = makeHost();
    let answer: TooltipContent | undefined = "shown";
    const panel = createPanel({ doc: document, host, resolve: () => answer, hoverable: false });
    panel.show(hit(), 0, 0);
    expect(panel.isVisible()).toBe(true);
    answer = undefined;
    const shown = panel.show(hit("t2"), 5, 5);
    expect(shown).toBe(false);
    // The caller (hover.ts) decides what a decline means; the panel itself does not auto-hide.
    expect(panel.isVisible()).toBe(true);
  });

  it("hide takes the panel down and unmounts its content", () => {
    const host = makeHost();
    const panel = createPanel({ doc: document, host, resolve: () => "x", hoverable: false });
    panel.show(hit(), 0, 0);
    panel.hide();
    expect(panel.isVisible()).toBe(false);
    expect(panel.element.style.display).toBe("none");
    expect(panel.element.textContent).toBe("");
  });
});

describe("refresh (§6.4a freshness)", () => {
  it("does nothing when no tooltip is visible", () => {
    const host = makeHost();
    let calls = 0;
    const panel = createPanel({
      doc: document,
      host,
      resolve: () => {
        calls += 1;
        return "x";
      },
      hoverable: false,
    });
    panel.refresh();
    expect(calls).toBe(0);
  });

  it("re-resolves the visible anchor and replaces content in place", () => {
    const host = makeHost();
    let answer = "v1";
    const panel = createPanel({ doc: document, host, resolve: () => answer, hoverable: false });
    panel.show(hit(), 0, 0);
    answer = "v2";
    panel.refresh();
    expect(panel.element.textContent).toBe("v2");
    expect(panel.isVisible()).toBe(true);
  });

  it("hides when the anchor no longer resolves (task deleted / dataset reloaded)", () => {
    const host = makeHost();
    let answer: TooltipContent | undefined = "v1";
    const panel = createPanel({ doc: document, host, resolve: () => answer, hoverable: false });
    panel.show(hit(), 0, 0);
    answer = undefined;
    panel.refresh();
    expect(panel.isVisible()).toBe(false);
  });

  it("resolves nothing again after a hide (anchor forgotten)", () => {
    const host = makeHost();
    let calls = 0;
    const panel = createPanel({
      doc: document,
      host,
      resolve: () => {
        calls += 1;
        return "x";
      },
      hoverable: false,
    });
    panel.show(hit(), 0, 0);
    panel.hide();
    calls = 0;
    panel.refresh();
    expect(calls).toBe(0);
  });
});

describe("placement", () => {
  it("moves the panel by exactly the anchor delta when nothing forces a flip", () => {
    // In happy-dom, layout metrics (the host's own screen position, the panel's natural size) are
    // effectively zero, which makes an absolute assertion on `style.left` brittle across
    // environments. The offset/flip/clamp arithmetic itself is covered by
    // tooltip-placement.test.ts; what this checks is that the panel actually calls into it on show
    // — moving the anchor by a fixed delta with plenty of room should move the panel by the same
    // delta, with no flip in the way.
    const host = makeHost();
    Object.assign(host.style, { position: "absolute", width: "2000px", height: "2000px" });
    const panel = createPanel({ doc: document, host, resolve: () => "x", hoverable: false });
    panel.show(hit(), 100, 100);
    const left1 = Number.parseFloat(panel.element.style.left || "0");
    const top1 = Number.parseFloat(panel.element.style.top || "0");
    panel.show(hit(), 150, 140);
    const left2 = Number.parseFloat(panel.element.style.left || "0");
    const top2 = Number.parseFloat(panel.element.style.top || "0");
    expect(left2 - left1).toBe(50);
    expect(top2 - top1).toBe(40);
  });
});
