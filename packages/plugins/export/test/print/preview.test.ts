// @vitest-environment happy-dom
/**
 * The print-preview overlay: mount structure inside `createDialog`'s modal chrome, the a11y
 * obligations §1.3 delegates to the dialog foundation, the two print stylesheets, and disposal.
 *
 * Driven directly against `createPrintPreview` rather than through the facade: the preview is
 * hostless, and every claim below is about the DOM it builds, which a real happy-dom document pins
 * far more precisely than a service round-trip would.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_MESSAGES } from "../../src/internal/messages";
import { createPrintPreview } from "../../src/internal/print/preview";
import type { PrintPreview } from "../../src/internal/print/preview";

interface Harness {
  preview: PrintPreview;
  root: HTMLElement;
  chartPane: HTMLElement;
  box: HTMLElement;
  backdrop: HTMLElement;
  buttons: HTMLButtonElement[];
  canvases: HTMLCanvasElement[];
  printCalls: number;
  closeCalls: number;
  faults: { where: string; error: unknown }[];
}

let open: Harness | undefined;

function styleText(): string {
  return Array.from(document.querySelectorAll("style"))
    .map((s) => s.textContent ?? "")
    .join("\n");
}

const HIDE_RULE = /body\s*>\s*\*:not\(/;

interface MountOptions {
  pages?: number;
  print?: () => void;
  /** Elements placed inside the chart pane *before* the preview mounts. */
  siblings?: readonly HTMLElement[];
}

function mount(options: MountOptions = {}): Harness {
  const root = document.createElement("div");
  root.className = "sg-root";
  const chartPane = document.createElement("div");
  chartPane.className = "sg-pane sg-pane--chart";
  chartPane.style.overflow = "auto";
  root.appendChild(chartPane);
  document.body.appendChild(root);
  for (const sibling of options.siblings ?? []) chartPane.appendChild(sibling);

  const canvases = Array.from({ length: options.pages ?? 2 }, () =>
    document.createElement("canvas"),
  );

  const h: Partial<Harness> = { printCalls: 0, closeCalls: 0, faults: [] };
  const preview = createPrintPreview({
    host: chartPane,
    canvases,
    pageWidth: 1122,
    messages: DEFAULT_MESSAGES,
    print: () => {
      h.printCalls = (h.printCalls ?? 0) + 1;
      options.print?.();
    },
    close: () => {
      h.closeCalls = (h.closeCalls ?? 0) + 1;
    },
    fault: (where, error) => void h.faults!.push({ where, error }),
  });

  const box = preview.root;
  const harness = Object.assign(h, {
    preview,
    root,
    chartPane,
    box,
    backdrop: box.parentElement as HTMLElement,
    buttons: Array.from(box.querySelectorAll("button")),
    canvases,
  }) as Harness;
  open = harness;
  return harness;
}

beforeEach(() => {
  document.body.innerHTML = "";
  document.head.innerHTML = "";
});

afterEach(() => {
  open?.preview.dispose();
  open?.root.remove();
  open = undefined;
  vi.useRealTimers();
});

describe("mount structure", () => {
  it("puts .sg-print-preview on the dialog box inside a backdrop mounted in the chart pane", () => {
    const h = mount();
    // `createDialog({ modal: true })` mounts `host → __backdrop → box`; the caller's className
    // lands on the *box*, and the backdrop derives its own name from it.
    expect(h.backdrop.classList.contains("sg-print-preview__backdrop")).toBe(true);
    expect(h.backdrop.parentElement).toBe(h.chartPane);
    expect(h.box.className).toBe("sg-print-preview");
    expect(h.chartPane.querySelectorAll(".sg-print-preview")).toHaveLength(1);
  });

  it("labels the dialog and offers Print and Close in that order", () => {
    const h = mount();
    expect(h.box.getAttribute("role")).toBe("dialog");
    expect(h.box.getAttribute("aria-modal")).toBe("true");
    expect(h.box.getAttribute("aria-label")).toBe("Print preview");
    expect(h.buttons.map((b) => b.textContent)).toEqual(["Print", "Close"]);
    expect(h.box.textContent).toContain("Print preview");
  });

  it("shows one sheet per page, each holding its canvas scaled to fit", () => {
    const h = mount({ pages: 3 });
    const sheets = Array.from(h.box.querySelectorAll(".sg-print-preview-page"));
    expect(sheets).toHaveLength(3);
    sheets.forEach((sheet, i) => {
      expect(sheet.firstElementChild).toBe(h.canvases[i]);
      expect((sheet as HTMLElement).style.width).toBe("1122px");
      expect((sheet as HTMLElement).style.maxWidth).toBe("100%");
      expect(h.canvases[i]!.style.width).toBe("100%");
      expect(h.canvases[i]!.style.height).toBe("auto");
    });
  });

  it("gives both buttons a hit area of at least 24×24 px", () => {
    const h = mount();
    for (const b of h.buttons) {
      expect(Number.parseFloat(b.style.minWidth)).toBeGreaterThanOrEqual(24);
      expect(Number.parseFloat(b.style.minHeight)).toBeGreaterThanOrEqual(24);
    }
  });
});

describe("accessibility obligations supplied by the dialog foundation", () => {
  it("moves focus into the overlay on open", () => {
    const h = mount();
    expect(h.box.contains(document.activeElement)).toBe(true);
    expect(document.activeElement).toBe(h.buttons[0]);
  });

  it("Escape asks the caller to close (the caller disposes)", () => {
    const h = mount();
    const event = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    h.box.dispatchEvent(event);
    expect(h.closeCalls).toBe(1);
    // Nothing is torn down until the caller disposes.
    expect(h.chartPane.querySelector(".sg-print-preview")).not.toBeNull();
  });

  it("the Close button asks the caller to close", () => {
    const h = mount();
    h.buttons[1]!.click();
    expect(h.closeCalls).toBe(1);
  });

  it("confines Tab to the overlay, wrapping at both ends", () => {
    const h = mount();
    const [printBtn, closeBtn] = [h.buttons[0]!, h.buttons[1]!];
    closeBtn.focus();
    const forward = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
    h.box.dispatchEvent(forward);
    expect(forward.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(printBtn);

    printBtn.focus();
    const back = new KeyboardEvent("keydown", {
      key: "Tab",
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    });
    h.box.dispatchEvent(back);
    expect(back.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(closeBtn);
  });

  it("returns focus to the element that held it before the preview opened", () => {
    const opener = document.createElement("button");
    document.body.appendChild(opener);
    opener.focus();
    const h = mount();
    expect(document.activeElement).not.toBe(opener);
    h.preview.dispose();
    open = undefined;
    expect(document.activeElement).toBe(opener);
    h.root.remove();
    opener.remove();
  });

  it("falls back to the chart pane when nothing was focused before", () => {
    // Nothing focused: the foundation leaves focus on `body`, and this plugin's documented
    // fallback hands it to the chart pane instead.
    const h = mount();
    h.preview.dispose();
    open = undefined;
    expect(document.activeElement).toBe(h.chartPane);
    h.root.remove();
  });

  it("marks the chart pane's other children inert while open, restoring their prior state", () => {
    // The siblings that matter are the *backdrop's* — under `modal: true` the box itself has none,
    // so an inert pass written against the box would silently mark nothing.
    const plain = document.createElement("div");
    const alreadyInert = document.createElement("div");
    alreadyInert.setAttribute("inert", "");
    const h = mount({ siblings: [plain, alreadyInert] });

    expect(plain.hasAttribute("inert")).toBe(true);
    expect(alreadyInert.hasAttribute("inert")).toBe(true);
    expect(h.backdrop.hasAttribute("inert")).toBe(false);

    h.preview.dispose();
    open = undefined;
    expect(plain.hasAttribute("inert")).toBe(false);
    // Inert before the preview opened for unrelated reasons: still inert after close.
    expect(alreadyInert.hasAttribute("inert")).toBe(true);
    h.root.remove();
  });
});

describe("the static print stylesheet", () => {
  it("positions .sg-print-preview with position: static (not fixed/absolute) inside @media print", () => {
    // Verified against real Chromium print output: `position: fixed` pins the overlay's content
    // to the first printed page only, so a multi-page preview renders every page after the first
    // as blank. `static` (normal document flow) lets the paginator walk the content across as
    // many sheets as the page-break rule calls for.
    mount();
    const css = styleText();
    const mediaPrint = /@media print\s*{([\s\S]*)}/.exec(css)?.[1] ?? "";
    expect(mediaPrint).toMatch(/\.sg-print-preview\s*{[^}]*position:\s*static/);
    expect(mediaPrint).not.toMatch(/\.sg-print-preview\s*{[^}]*position:\s*fixed/);
    expect(mediaPrint).not.toMatch(/\.sg-print-preview\s*{[^}]*position:\s*absolute/);
  });

  it("neutralizes ancestor overflow, the backdrop, and the box's own scroll box", () => {
    mount();
    const css = styleText();
    expect(css).toMatch(/\.sg-print-preview-ancestor\s*{[^}]*overflow:\s*visible\s*!important/);
    expect(css).toMatch(/\.sg-print-preview__backdrop\s*{[^}]*position:\s*static\s*!important/);
    expect(css).toMatch(/\.sg-print-preview\s*{[^}]*overflow:\s*visible\s*!important/);
    expect(css).toMatch(/\.sg-print-preview__body\s*{[^}]*overflow:\s*visible\s*!important/);
    // The dialog's own drag transform must not ride into the printed flow.
    expect(css).toMatch(/\.sg-print-preview\s*{[^}]*transform:\s*none\s*!important/);
  });

  it("hides the dialog chrome and breaks a page after every sheet", () => {
    mount();
    const css = styleText();
    expect(css).toMatch(
      /\.sg-print-preview__header,\s*\.sg-print-preview__footer\s*{[^}]*display:\s*none\s*!important/,
    );
    expect(css).toMatch(/\.sg-print-preview-page\s*{[^}]*page-break-after:\s*always/);
  });

  it("marks the whole ancestor chain, and unmarks it on dispose", () => {
    const h = mount();
    for (const node of [h.backdrop, h.chartPane, h.root, document.body, document.documentElement]) {
      expect(node.classList.contains("sg-print-preview-ancestor")).toBe(true);
    }
    // Not the box itself: the print CSS addresses it by its own class.
    expect(h.box.classList.contains("sg-print-preview-ancestor")).toBe(false);
    h.preview.dispose();
    open = undefined;
    for (const node of [h.backdrop, h.chartPane, h.root, document.body, document.documentElement]) {
      expect(node.classList.contains("sg-print-preview-ancestor")).toBe(false);
    }
    h.root.remove();
  });
});

describe("the hide-everything-else stylesheet", () => {
  it("is not installed just because the preview is open", () => {
    mount();
    const css = styleText();
    // The layout rule is present immediately...
    expect(css).toMatch(/\.sg-print-preview\s*{[^}]*position:\s*static/);
    // ...but the global hide rule is not installed just from opening the preview.
    expect(css).not.toMatch(HIDE_RULE);
  });

  it("selects exactly the content outside the overlay in the real mounted structure", () => {
    // The rule is asserted against the DOM it will actually run over, not by reading the string:
    // `createDialog` inserts an extra backdrop level, and the selectors have to survive it.
    const h = mount();
    const outsider = document.createElement("div");
    document.body.appendChild(outsider);
    const paneSibling = document.createElement("div");
    h.chartPane.appendChild(paneSibling);

    const BODY_LEVEL = "body > *:not(.sg-print-preview-ancestor):not(.sg-print-preview)";
    const CHAIN_LEVEL =
      ".sg-print-preview-ancestor > *:not(.sg-print-preview-ancestor):not(.sg-print-preview)";

    // Hidden: everything outside the chain.
    expect(outsider.matches(BODY_LEVEL)).toBe(true);
    expect(paneSibling.matches(CHAIN_LEVEL)).toBe(true);
    // Kept: the chain itself, the backdrop, and the box.
    expect(h.root.matches(BODY_LEVEL)).toBe(false);
    expect(h.chartPane.matches(CHAIN_LEVEL)).toBe(false);
    expect(h.backdrop.matches(CHAIN_LEVEL)).toBe(false);
    expect(h.box.matches(CHAIN_LEVEL)).toBe(false);
    // And nothing inside the overlay is ever matched.
    for (const inside of Array.from(h.box.children)) {
      expect(inside.matches(CHAIN_LEVEL)).toBe(false);
      expect(inside.matches(BODY_LEVEL)).toBe(false);
    }
    outsider.remove();
  });

  it("installs it only around the Print button's actual print action, with a timed fallback", () => {
    let sawHideRuleDuringPrint = false;
    const h = mount({
      print: () => {
        sawHideRuleDuringPrint = HIDE_RULE.test(styleText());
      },
    });
    expect(styleText()).not.toMatch(HIDE_RULE);

    vi.useFakeTimers();
    h.buttons[0]!.click();
    expect(h.printCalls).toBe(1);
    expect(sawHideRuleDuringPrint).toBe(true);
    // Still installed right after print() returns: rasterization can still be in flight (this host
    // never fires `afterprint`) — the hide rule must not be torn down synchronously in a `finally`.
    expect(styleText()).toMatch(HIDE_RULE);
    // The fallback timer cleans it up when `afterprint` never arrives.
    vi.advanceTimersByTime(2000);
    expect(styleText()).not.toMatch(HIDE_RULE);
  });

  it("installs it on beforeprint and removes it on afterprint", () => {
    mount();
    window.dispatchEvent(new Event("beforeprint"));
    expect(styleText()).toMatch(HIDE_RULE);
    window.dispatchEvent(new Event("afterprint"));
    expect(styleText()).not.toMatch(HIDE_RULE);
  });

  it("stops listening to beforeprint once disposed", () => {
    const h = mount();
    h.preview.dispose();
    open = undefined;
    window.dispatchEvent(new Event("beforeprint"));
    expect(styleText()).not.toMatch(HIDE_RULE);
    h.root.remove();
  });

  it("cleans up on dispose even mid-print", () => {
    const h = mount({ print: () => {} });
    h.buttons[0]!.click();
    expect(styleText()).toMatch(HIDE_RULE);
    h.preview.dispose();
    open = undefined;
    expect(styleText()).not.toMatch(HIDE_RULE);
    h.root.remove();
  });

  it("contains a throwing print hook: reported once, hide rule still torn down", () => {
    const h = mount({
      print: () => {
        throw new Error("no printer");
      },
    });
    vi.useFakeTimers();
    expect(() => h.buttons[0]!.click()).not.toThrow();
    expect(h.faults.map((f) => f.where)).toEqual(["print"]);
    vi.advanceTimersByTime(2000);
    expect(styleText()).not.toMatch(HIDE_RULE);
  });
});

describe("disposal", () => {
  it("removes the overlay and both stylesheets", () => {
    const h = mount();
    expect(document.querySelectorAll("style").length).toBeGreaterThan(0);
    window.dispatchEvent(new Event("beforeprint"));
    expect(document.querySelectorAll("style")).toHaveLength(2);
    h.preview.dispose();
    open = undefined;
    expect(h.chartPane.querySelector(".sg-print-preview")).toBeNull();
    expect(h.chartPane.children).toHaveLength(0);
    expect(document.querySelectorAll("style")).toHaveLength(0);
    h.root.remove();
  });

  it("is idempotent", () => {
    const h = mount();
    h.preview.dispose();
    expect(() => h.preview.dispose()).not.toThrow();
    open = undefined;
    h.root.remove();
  });
});
