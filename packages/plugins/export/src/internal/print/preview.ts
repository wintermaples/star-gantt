/** The print-preview overlay: page canvases, Print/Close buttons, and the two print stylesheets. */
// docs/specs/plugins/export.md §1.3 (print preview)
/**
 * Built on the SDK dialog foundation (`sdk/dialog`), which supplies the accessibility
 * obligations §1.3 lists: `role="dialog"` / `aria-modal`, Tab
 * cycling confined to the overlay, Escape/close/disposal teardown, and focus return to the
 * previously focused element. What stays this module's own is everything about *printing*: the two
 * stylesheets below, whose rules are hard-won and verified against real Chromium print output.
 *
 * The modal dialog mounts as `host → .sg-print-preview__backdrop → .sg-print-preview` (the class
 * lands on the inner box, not on the backdrop), so the print CSS neutralizes the backdrop
 * explicitly and the ancestor marking starts at it.
 */
import { createDialog } from "@stargantt/sdk";
import type { Dialog } from "@stargantt/sdk";
import type { ExportMessages } from "../messages";

/** Class of the dialog box; the foundation derives `__backdrop` / `__header` / … from it. */
const PREVIEW_CLASS = "sg-print-preview";
const BACKDROP_CLASS = `${PREVIEW_CLASS}__backdrop`;
const HEADER_CLASS = `${PREVIEW_CLASS}__header`;
const BODY_CLASS = `${PREVIEW_CLASS}__body`;
const FOOTER_CLASS = `${PREVIEW_CLASS}__footer`;
/** One printed sheet in the preview; also the page-break unit of the print stylesheet. */
const PAGE_CLASS = `${PREVIEW_CLASS}-page`;

/** Marks every ancestor of the preview overlay (backdrop and chart pane included). */
const ANCESTOR_MARK_CLASS = "sg-print-preview-ancestor";

/** How long the print state is left installed when the host never fires `afterprint`. */
const HIDE_STYLE_FALLBACK_MS = 2000;

// Installed for as long as the preview overlay is mounted.
//
// `.sg-print-preview` is `position: static` (the CSS default, restated `!important` to override
// the box's own on-screen positioning), NOT `fixed`. This was verified against real Chromium print
// output (headless `page.pdf()` against `.sg-print-preview-page` content taller than one sheet): a
// `position: fixed` overlay renders its content pinned to the *first* printed page only —
// Chromium's paginator does not repaint a fixed-position box across page boundaries — so every
// page after the first came out blank while the on-screen preview still reported many pages. A
// `static` overlay instead sits in normal document flow, so the paginator walks its content across
// as many sheets as `page-break-after` on `.sg-print-preview-page` calls for, matching the
// on-screen preview's page count. The ancestor-chain rule below neutralizes `overflow:
// hidden/auto/scroll` on the chart pane (and any other ancestor) so multi-page content isn't
// clipped to the pane's on-screen scroll box now that layout, not compositing, drives pagination.
//
// The dialog chrome adds boxes that would clip or shrink the printed flow: the absolutely
// positioned, flex-centred backdrop; the box's own `overflow: hidden` with proportional
// max-width/max-height caps and its drag `transform`; and the scrolling body. All are
// flattened back to ordinary block flow here. The header and the button bar are chrome, not
// content, so they print nothing, applied to the foundation's two parts.
const STATIC_PRINT_CSS =
  "@media print {" +
  ` .${ANCESTOR_MARK_CLASS} { overflow: visible !important; }` +
  ` .${BACKDROP_CLASS} { position: static !important; display: block !important;` +
  " background: none !important; overflow: visible !important; z-index: auto !important; }" +
  ` .${PREVIEW_CLASS} { position: static !important; overflow: visible !important;` +
  " background: #fff !important; display: block !important; transform: none !important;" +
  " width: auto !important; height: auto !important; min-width: 0 !important;" +
  " max-width: none !important; max-height: none !important;" +
  " border: 0 !important; border-radius: 0 !important; box-shadow: none !important; }" +
  ` .${HEADER_CLASS}, .${FOOTER_CLASS} { display: none !important; }` +
  ` .${BODY_CLASS} { display: block !important; overflow: visible !important; padding: 0 !important; }` +
  ` .${PAGE_CLASS} { box-shadow: none !important; margin: 0 !important; page-break-after: always; }` +
  "}";

// Installed only around the actual print action (not for the whole time the on-screen preview is
// open): hides everything outside the overlay. Keeping this active while the user is merely
// looking at the preview needlessly hides the whole app before printing was ever requested.
//
// `display: none` (not `visibility: hidden`) on the non-ancestor siblings at every level of the
// ancestor chain: `visibility: hidden` was tried first but, unlike `display: none`, still
// reserves the hidden element's layout box — with the overlay now `position: static` (see above)
// that reserved space pushes the overlay's own content down the page, so real-Chromium output
// opened with a blank leading page/gap before the actual pages. Targeting only the ancestor
// chain's *unmarked* children (rather than a blanket `body *`) keeps the rule cheap and, by
// construction, never matches anything inside `.sg-print-preview` itself (the overlay is always
// excluded from the set being hidden, at both the `body` level and every ancestor level), so no
// counter-rule is needed to un-hide the overlay's own subtree. The backdrop is itself marked as an
// ancestor, so the box survives its level of the chain too.
const HIDE_EVERYTHING_ELSE_CSS =
  "@media print {" +
  ` body > *:not(.${ANCESTOR_MARK_CLASS}):not(.${PREVIEW_CLASS}) { display: none !important; }` +
  ` .${ANCESTOR_MARK_CLASS} > *:not(.${ANCESTOR_MARK_CLASS}):not(.${PREVIEW_CLASS}) { display: none !important; }` +
  "}";

/** What the preview needs from its caller; nothing here is a service, so it stays hostless. */
export interface PrintPreviewOptions {
  /** `ViewService.chartPaneElement()`. */
  host: HTMLElement;
  canvases: HTMLCanvasElement[];
  pageWidth: number;
  messages: ExportMessages;
  /** Invoked by the Print button. */
  print(): void;
  /** Invoked by Escape and by the Close button; the caller disposes the preview. */
  close(): void;
  fault(where: string, error: unknown): void;
}

/** A mounted preview: its box, and the one thing a caller does to it. */
export interface PrintPreview {
  /** The dialog box carrying `.sg-print-preview`; the mounted wrapper is its backdrop. */
  readonly root: HTMLElement;
  dispose(): void;
}

/**
 * A toolbar button.
 *
 * ≥24×24 px hit area (WCAG 2.2 §2.5.8, comfortably exceeded at 64×28) and ≥4.5:1 text contrast:
 * the theme tokens carry the dialog's own colors, and the fallbacks are a checked light pair
 * (#1f2937 on #f3f4f6 ≈ 12:1 text, #6b7280 border ≈ 4:1 against the button face, over the ≥3:1
 * a UI boundary needs).
 */
function button(doc: Document, label: string, onClick: () => void): HTMLButtonElement {
  const b = doc.createElement("button");
  b.type = "button";
  b.textContent = label;
  b.style.cssText =
    "min-width:64px;min-height:28px;padding:4px 12px;font:12px system-ui, sans-serif;" +
    "color:var(--sg-dialog-fg, #1f2937);background:var(--sg-dialog-header-bg, #f3f4f6);" +
    "border:1px solid var(--sg-dialog-border, #6b7280);border-radius:4px;cursor:pointer;";
  b.addEventListener("click", onClick);
  return b;
}

/**
 * Builds and mounts the preview around already-rendered page canvases, and moves focus into it.
 *
 * `dispose()` unmounts everything this owns — both stylesheets, the print listeners, the fallback
 * timer, the ancestor marks, the inert marks and the dialog itself — and the foundation hands
 * focus back to whatever held it before the preview opened (falling back to the chart pane).
 */
export function createPrintPreview(options: PrintPreviewOptions): PrintPreview {
  const { host, messages } = options;
  const doc = host.ownerDocument;

  const dialog: Dialog = createDialog({
    host,
    className: PREVIEW_CLASS,
    label: messages.previewTitle,
    modal: true,
    // The preview covers the chart on purpose and its body scrolls, so there is nothing to uncover
    // by moving the box — and a drag `transform` would otherwise ride along into the printed flow.
    draggable: false,
    width: "min(1024px, 96%)",
    maxWidth: "96%",
    maxHeight: "92%",
    onClose: options.close,
  });

  /* --- the printed sheets ------------------------------------------------- */

  for (const canvas of options.canvases) {
    const sheet = doc.createElement("div");
    sheet.className = PAGE_CLASS;
    // `max-width: 100%` is what scales every page down to fit the preview's width; the canvas
    // keeps its aspect ratio through `height: auto`.
    sheet.style.cssText =
      "background:#fff;box-shadow:0 2px 8px rgba(0,0,0,0.35);margin:0 auto 12px;" +
      `width:${options.pageWidth}px;max-width:100%;`;
    canvas.style.cssText = "display:block;width:100%;height:auto;";
    sheet.appendChild(canvas);
    dialog.body.appendChild(sheet);
  }

  /* --- the print stylesheets ---------------------------------------------- */

  const styleHost = doc.head ?? doc.body ?? doc.documentElement;
  const staticStyle = doc.createElement("style");
  staticStyle.textContent = STATIC_PRINT_CSS;
  styleHost?.appendChild(staticStyle);

  // The hide-everything-else stylesheet is only needed for the instant `window.print()` is
  // actually invoked, not for the whole time the on-screen preview is open — installed just
  // before the call and torn down right after (and also on `afterprint`, for prints triggered
  // outside the button, e.g. the browser's own Ctrl+P / File > Print while the preview is open).
  let hideStyle: HTMLStyleElement | undefined;
  const installHideStyle = (): void => {
    if (hideStyle !== undefined) return;
    hideStyle = doc.createElement("style");
    hideStyle.textContent = HIDE_EVERYTHING_ELSE_CSS;
    styleHost?.appendChild(hideStyle);
  };
  let removeHideStyleTimer: ReturnType<typeof setTimeout> | undefined;
  const removeHideStyle = (): void => {
    if (removeHideStyleTimer !== undefined) {
      clearTimeout(removeHideStyleTimer);
      removeHideStyleTimer = undefined;
    }
    hideStyle?.remove();
    hideStyle = undefined;
  };
  const view = doc.defaultView;
  view?.addEventListener?.("beforeprint", installHideStyle);
  view?.addEventListener?.("afterprint", removeHideStyle);

  const triggerPrint = (): void => {
    installHideStyle();
    // `window.print()` returns as soon as the print dialog is dismissed in most browsers, but
    // rasterization (paint of the hidden-everything-else state into the print job / PDF) can
    // still be in flight at that point — removing the hide stylesheet synchronously here would
    // race it and risk printing the un-hidden on-screen preview instead of the print layout.
    // `afterprint` is the correct signal and does the real cleanup; the timer below is only a
    // fallback for hosts that never fire it (no printer / some test doubles), given enough
    // headroom for rasterization to have finished first.
    try {
      options.print();
    } catch (error) {
      options.fault("print", error);
    }
    removeHideStyleTimer = setTimeout(removeHideStyle, HIDE_STYLE_FALLBACK_MS);
  };

  /* --- the toolbar --------------------------------------------------------- */

  // Reading `dialog.footer` is what creates the button bar, so it exists only because we ask.
  const footer = dialog.footer;
  footer.appendChild(button(doc, messages.printButton, triggerPrint));
  footer.appendChild(button(doc, messages.closeButton, options.close));

  /* --- ancestors: overflow neutralization and inert siblings ---------------- */

  // The dialog mounts synchronously, so the chain is walkable right now.
  //
  // Marking every ancestor of the box — the backdrop, the chart pane, and everything above them —
  // is what lets `STATIC_PRINT_CSS` neutralize their `overflow` under `@media print`; otherwise an
  // ancestor's `overflow: hidden/auto/scroll` clips the overlay's multi-page content to that
  // ancestor's on-screen scroll box instead of letting it paginate across full printed pages.
  //
  // The same pass marks the overlay's siblings `inert`: the overlay declares `aria-modal`, so
  // while it is open assistive tech and the Tab order must skip the content behind it. (The Tab
  // confinement itself is the foundation's; `inert` is the belt-and-braces it does not supply.)
  // The siblings are the *mounted wrapper's* — under `modal: true` the foundation puts a backdrop
  // between the host and the box, so the box has no siblings of its own.
  const madeInert: Element[] = [];
  const markedAncestors: Element[] = [];
  let mounted: HTMLElement = dialog.root;
  while (mounted.parentElement !== null && mounted.parentElement !== host) {
    mounted = mounted.parentElement;
  }
  for (const sibling of Array.from(host.children)) {
    if (sibling === mounted) continue;
    if (!sibling.hasAttribute("inert")) {
      sibling.setAttribute("inert", "");
      madeInert.push(sibling);
    }
  }
  for (let node: Element | null = dialog.root.parentElement; node !== null; node = node.parentElement) {
    if (!node.classList.contains(ANCESTOR_MARK_CLASS)) {
      node.classList.add(ANCESTOR_MARK_CLASS);
      markedAncestors.push(node);
    }
  }

  // Focus moves into the overlay: the Print button, its first focusable element.
  dialog.focus();

  return {
    root: dialog.root,
    dispose: () => {
      view?.removeEventListener?.("beforeprint", installHideStyle);
      view?.removeEventListener?.("afterprint", removeHideStyle);
      removeHideStyle();
      for (const sibling of madeInert) sibling.removeAttribute("inert");
      madeInert.length = 0;
      for (const node of markedAncestors) node.classList.remove(ANCESTOR_MARK_CLASS);
      markedAncestors.length = 0;
      staticStyle.remove();
      dialog.dispose();
      // §1.3 — focus returns to the element that held it before the preview opened; the foundation
      // does exactly that, but leaves focus where the browser put it when that element is gone (or
      // was never focusable). The chart pane is this plugin's documented fallback for that case.
      const active = doc.activeElement;
      if (active === null || active === doc.body) host.focus?.();
    },
  };
}
