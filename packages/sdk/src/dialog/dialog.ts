// The draggable dialog foundation (docs/specs/sdk.md, Module: sdk/dialog): one dialog for every
// panel-bearing plugin that floats something over the chart, styled through the `--sg-dialog-*`
// token family. Centered in the host, drag clamped to the host's box, Escape/close-button/backdrop
// close, optional modal focus trap.

/** How the dialog's chrome is built and what it is allowed to do. */
export interface DialogOptions {
  /**
   * The element the dialog is appended to and clamped inside; its `ownerDocument` builds the DOM.
   *
   * Pass the gantt root: the dialog then opens centred over the whole widget and the drag can park
   * it anywhere inside it, the tree grid included. A smaller host — one pane, say — becomes the
   * dialog's cage, since the drag clamps against exactly this element's box.
   */
  readonly host: HTMLElement;
  /** Class name of the dialog box, so callers keep their own selector. */
  readonly className: string;
  /** The accessible name, and the text of the header. */
  readonly label: string;
  /** Invoked by Escape, by the header's close button, and by a press on a modal backdrop. */
  readonly onClose?: (() => void) | undefined;
  /** Adds a dimmed backdrop, `aria-modal="true"` and a Tab focus trap. Defaults to `false`. */
  readonly modal?: boolean | undefined;
  /** Lets the pointer drag the dialog by its header. Defaults to `true`. */
  readonly draggable?: boolean | undefined;
  /** Adds a resize grip in the bottom-right corner. Defaults to `false`. */
  readonly resizable?: boolean | undefined;
  /** Text of a close button in the header. Omitted, the header carries no button. */
  readonly closeButton?: string | undefined;
  /** CSS `width` of the box. Omitted, it sizes to its content between the bounds below. */
  readonly width?: string | undefined;
  /** CSS `min-width`. Defaults to `"360px"`. */
  readonly minWidth?: string | undefined;
  /** CSS `max-width`. Defaults to `"90%"`. */
  readonly maxWidth?: string | undefined;
  /** CSS `max-height`. Defaults to `"80%"`. */
  readonly maxHeight?: string | undefined;
  /** Distance in px from the host's top edge at which the box opens. Defaults to `24`. */
  readonly top?: number | undefined;
  /**
   * Horizontal shift in px from the centred position the box opens at, positive to the right.
   * Defaults to `0`. Use it to cascade a second dialog off a first one that may be open at the
   * same time, rather than opening it exactly underneath.
   */
  readonly offsetX?: number | undefined;
}

/** A mounted dialog: its parts, and the two things a caller does to it. */
export interface Dialog {
  /** The dialog box itself, already mounted in the host. */
  readonly root: HTMLElement;
  /** The header row — the title, then anything you append, then the close button. */
  readonly header: HTMLElement;
  /** The scrolling content area. Append your body here. */
  readonly body: HTMLElement;
  /**
   * The right-aligned button bar under the body. Reading this creates the bar, so a dialog that
   * never asks for one does not render an empty strip.
   */
  readonly footer: HTMLElement;
  /** Moves focus into the dialog: to its first focusable element, or to the box itself. */
  focus(): void;
  /** Unmounts the dialog and drops the listeners it owns. Doing it twice is a no-op. */
  dispose(): void;
}

type Styles = Record<string, string>;

function applyStyles(target: HTMLElement, s: Styles): void {
  const sink = target.style as unknown as Record<string, string>;
  for (const key of Object.keys(s)) sink[key] = s[key] as string;
}

function make(doc: Document, tag: string, s: Styles, text?: string): HTMLElement {
  const node = doc.createElement(tag);
  applyStyles(node, s);
  if (text !== undefined) node.textContent = text;
  return node;
}

const FOCUSABLE_TAGS = new Set(["INPUT", "SELECT", "TEXTAREA", "BUTTON", "A"]);

/**
 * The box's focusable elements in document order.
 *
 * Walked by hand rather than asked of `querySelectorAll`: the walk is the same handful of lines,
 * it works against any DOM implementation, and it keeps the "what counts as focusable" rule in one
 * readable place instead of a selector string.
 */
function focusRing(root: HTMLElement): HTMLElement[] {
  const found: HTMLElement[] = [];
  const walk = (node: HTMLElement): void => {
    const kids = node.children as unknown as ArrayLike<HTMLElement>;
    for (let i = 0; i < kids.length; i += 1) {
      const child = kids[i];
      if (child === undefined) continue;
      const tabindex = child.getAttribute?.("tabindex") ?? null;
      const disabledAttr = child.getAttribute?.("disabled");
      const disabled = disabledAttr !== null && disabledAttr !== undefined;
      const hiddenAttr =
        child.hasAttribute?.("hidden") ?? ((child.getAttribute?.("hidden") ?? null) !== null);
      const displayNone = child.style?.display === "none";
      // `tagName` is uppercase in a real HTML document, but an SVG `<a>` reports lowercase, and a
      // test double may too — normalize defensively rather than trust the DOM contract here.
      const eligible =
        tabindex === null ? FOCUSABLE_TAGS.has(child.tagName?.toUpperCase() ?? "") : tabindex !== "-1";
      if (eligible && !disabled && !hiddenAttr && !displayNone) found.push(child);
      walk(child);
    }
  };
  walk(root);
  return found;
}

function rectOf(el: HTMLElement): { left: number; top: number; width: number; height: number } | undefined {
  if (typeof el.getBoundingClientRect !== "function") return undefined;
  const r = el.getBoundingClientRect();
  // A fake or detached element can answer an all-zero box; a zero-width dialog cannot be clamped
  // against anything meaningful, so the gesture declines rather than teleporting the box.
  if (r.width === 0 && r.height === 0) return undefined;
  return { left: r.left, top: r.top, width: r.width, height: r.height };
}

const clamp = (value: number, low: number, high: number): number =>
  value < low ? low : value > high ? high : value;

type Register = (target: EventTarget, type: string, fn: (e: Event) => void) => void;

/**
 * Wires one pointer-driven gesture on `target`: a `pointerdown` that asks `onStart` whether to
 * begin (returning the pointer id to capture, or `undefined` to decline), pointer capture for the
 * duration, an `onMove` fed every subsequent move while active, and the release — on `pointerup`
 * *and* `pointercancel` alike, so a capture lost to the OS still lets go cleanly.
 *
 * Drag and resize each wire one of these rather than hand-copying the same five listeners with a
 * `drag`/`resize` state variable swapped in; only what happens at the start, each move and the end
 * differs between them.
 */
function gesture(
  register: Register,
  doc: Document,
  target: HTMLElement,
  onStart: (e: PointerEvent) => number | undefined,
  onMove: (e: PointerEvent) => void,
  onEnd?: () => void,
): void {
  let activeId: number | null = null;
  register(target, "pointerdown", (e) => {
    const pe = e as PointerEvent;
    const id = onStart(pe);
    if (id === undefined) return;
    activeId = id;
    target.setPointerCapture?.(id);
  });
  register(doc, "pointermove", (e) => {
    if (activeId === null) return;
    onMove(e as PointerEvent);
  });
  const end = (e: Event): void => {
    if (activeId === null) return;
    const id = (e as PointerEvent).pointerId ?? activeId;
    target.releasePointerCapture?.(id);
    activeId = null;
    onEnd?.();
  };
  register(doc, "pointerup", end);
  register(doc, "pointercancel", end);
}

interface DragState {
  readonly pointerId: number;
  readonly startX: number;
  readonly startY: number;
  readonly originLeft: number;
  readonly originTop: number;
  readonly baseX: number;
  readonly baseY: number;
  readonly host: { left: number; top: number; width: number; height: number };
  readonly box: { width: number; height: number };
  readonly headerHeight: number;
}

interface ResizeState {
  readonly pointerId: number;
  readonly startX: number;
  readonly startY: number;
  readonly width: number;
  readonly height: number;
  readonly maxWidth: number;
  readonly maxHeight: number;
}

/**
 * Builds a dialog over the chart and mounts it in `host`.
 *
 * The dialog owns its chrome: a titled header, a scrolling body, an optional button bar, focus
 * handling, Escape, and the pointer containment that keeps the chart's own gesture handling from
 * seeing presses meant for the dialog. Everything inside the body is the caller's.
 */
export function createDialog(options: DialogOptions): Dialog {
  const {
    host,
    className,
    label,
    modal = false,
    draggable = true,
    resizable = false,
    top = 24,
  } = options;
  const doc = host.ownerDocument;

  // WCAG 2.4.3 (Focus Order) — a dialog that moves focus into itself must give it back to wherever
  // it came from when it closes, or a keyboard/AT user loses their place in the page. Captured here,
  // before any of the chrome below can steal focus, so it reflects whatever the caller had focused.
  const openerFocus = doc.activeElement as HTMLElement | null;

  /**
   * Every listener this dialog attached, so `dispose()` can drop them all.
   *
   * The dialog owns its listeners rather than handing them to the plugin's `ctx.own()` bag: a
   * plugin that opens and closes the same panel fifty times would otherwise leave fifty
   * generations of dead registrations in that bag, growing for the chart's whole life. The plugin
   * owns exactly one disposable — "dispose the current dialog" — which drains this list.
   */
  const owned: { target: EventTarget; type: string; fn: EventListener }[] = [];
  const register = (target: EventTarget, type: string, fn: (e: Event) => void): void => {
    target.addEventListener(type, fn as EventListener);
    owned.push({ target, type, fn: fn as EventListener });
  };

  const close = (): void => options.onClose?.();

  /* --- the box ----------------------------------------------------------- */

  const boxStyles: Styles = {
    display: "flex",
    flexDirection: "column",
    overflow: "hidden",
    minWidth: options.minWidth ?? "360px",
    maxWidth: options.maxWidth ?? "90%",
    maxHeight: options.maxHeight ?? "80%",
    background: "var(--sg-dialog-bg, #ffffff)",
    color: "var(--sg-dialog-fg, #1c1917)",
    border: "1px solid var(--sg-dialog-border, #d6d3d1)",
    borderRadius: "6px",
    boxShadow: "0 6px 24px var(--sg-dialog-shadow, rgba(0, 0, 0, 0.25))",
    font: "13px system-ui, sans-serif",
  };
  if (options.width !== undefined) boxStyles["width"] = options.width;
  if (modal) {
    // Inside a flex-centred backdrop the box positions itself, so it takes `relative` and the
    // drag offset rides on `transform` exactly as it does for a free-floating dialog.
    boxStyles["position"] = "relative";
  } else {
    boxStyles["position"] = "absolute";
    boxStyles["top"] = `${top}px`;
    boxStyles["left"] = "50%";
    boxStyles["zIndex"] = "40";
  }
  const root = make(doc, "div", boxStyles);
  root.className = className;
  root.setAttribute("role", "dialog");
  root.setAttribute("aria-label", label);
  root.setAttribute("tabindex", "-1");
  if (modal) root.setAttribute("aria-modal", "true");

  /**
   * Drag offset in px, applied through `transform` so the layout model never changes. It starts at
   * the caller's cascade shift, which the drag then carries like any other displacement.
   */
  let offsetX = Number.isFinite(options.offsetX) ? (options.offsetX as number) : 0;
  let offsetY = 0;
  const writeTransform = (): void => {
    // The non-modal box is centred by `left:50%`, so its own half-width is part of the transform;
    // the modal one is centred by its backdrop's flexbox and needs no correction.
    const base = modal ? "translate(" : "translate(calc(-50% + ";
    const tail = modal ? `${offsetX}px, ${offsetY}px)` : `${offsetX}px), ${offsetY}px)`;
    root.style.transform = `${base}${tail}`;
  };
  writeTransform();

  /* --- header ------------------------------------------------------------ */

  const headerStyles: Styles = {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: "8px",
    flex: "0 0 auto",
    padding: "8px 12px",
    background: "var(--sg-dialog-header-bg, #f4f6f8)",
    borderBottom: "1px solid var(--sg-dialog-border, #d6d3d1)",
    fontWeight: "600",
  };
  if (draggable) {
    headerStyles["cursor"] = "move";
    headerStyles["touchAction"] = "none";
    headerStyles["userSelect"] = "none";
  }
  const header = make(doc, "div", headerStyles);
  header.className = `${className}__header`;
  header.appendChild(make(doc, "span", { minWidth: "0", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }, label));
  root.appendChild(header);

  if (options.closeButton !== undefined) {
    const button = make(
      doc,
      "button",
      { minHeight: "24px", minWidth: "64px", padding: "4px 12px", cursor: "pointer", font: "inherit" },
      options.closeButton,
    );
    button.setAttribute("type", "button");
    button.className = `${className}__close`;
    register(button, "click", () => close());
    header.appendChild(button);
  }

  /* --- body -------------------------------------------------------------- */

  // `min-height: 0` is what lets this flex item shrink below its content and actually scroll,
  // instead of being clipped by the box's `overflow: hidden` and taking the footer off-screen.
  const body = make(doc, "div", { flex: "1 1 auto", minHeight: "0", overflow: "auto", padding: "12px" });
  body.className = `${className}__body`;
  root.appendChild(body);

  /* --- footer (built on first read) --------------------------------------- */

  let footerEl: HTMLElement | undefined;
  const footerOf = (): HTMLElement => {
    if (footerEl !== undefined) return footerEl;
    const bar = make(doc, "div", {
      display: "flex",
      flex: "0 0 auto",
      justifyContent: "flex-end",
      gap: "8px",
      padding: "8px 12px",
      borderTop: "1px solid var(--sg-dialog-border, #d6d3d1)",
    });
    bar.className = `${className}__footer`;
    root.appendChild(bar);
    footerEl = bar;
    return bar;
  };

  /* --- mount ------------------------------------------------------------- */

  let mounted: HTMLElement = root;
  if (modal) {
    const backdrop = make(doc, "div", {
      position: "absolute",
      inset: "0",
      background: "var(--sg-dialog-backdrop, rgba(16, 22, 29, 0.4))",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      zIndex: "1000",
    });
    backdrop.className = `${className}__backdrop`;
    backdrop.appendChild(root);
    register(backdrop, "pointerdown", (e) => {
      // A press on the dim, not on the box, dismisses — the same gesture Escape performs.
      if (e.target === backdrop) close();
    });
    mounted = backdrop;
  }

  /* --- containment, Escape, focus trap ------------------------------------ */

  // Presses inside the dialog are dialog interactions: stopping them keeps the chart pane's
  // gesture machine from capturing the pointer away from the dialog's own controls.
  register(root, "pointerdown", (e) => e.stopPropagation?.());
  register(mounted, "keydown", (e) => {
    const key = (e as KeyboardEvent).key;
    if (key === "Escape") {
      (e as KeyboardEvent).stopPropagation?.();
      close();
      return;
    }
    if (key !== "Tab" || !modal) return;
    const ring = focusRing(root);
    if (ring.length === 0) return;
    const index = ring.indexOf(doc.activeElement as HTMLElement);
    const shift = (e as KeyboardEvent).shiftKey === true;
    if (shift && index <= 0) {
      (e as KeyboardEvent).preventDefault?.();
      ring[ring.length - 1]?.focus?.();
    } else if (!shift && (index === ring.length - 1 || index === -1)) {
      (e as KeyboardEvent).preventDefault?.();
      ring[0]?.focus?.();
    }
  });

  /* --- drag and resize ---------------------------------------------------- */

  let drag: DragState | null = null;
  let resize: ResizeState | null = null;

  if (draggable) {
    gesture(
      register,
      doc,
      header,
      (pe) => {
        // Moving the dialog has no keyboard equivalent, and needs none: it changes nothing about
        // what the dialog can do. The body scrolls, so no content is unreachable at the default
        // position, and the drag exists only so a reader can uncover the bars behind the box.
        // A press on the header's own button is that button's, not a drag's.
        if ((pe.target as HTMLElement | null)?.tagName?.toUpperCase() === "BUTTON") return undefined;
        if (pe.button !== undefined && pe.button !== 0) return undefined;
        const hostRect = rectOf(host);
        const boxRect = rectOf(root);
        const headerRect = rectOf(header);
        if (hostRect === undefined || boxRect === undefined) return undefined;
        drag = {
          pointerId: pe.pointerId ?? 0,
          startX: pe.clientX,
          startY: pe.clientY,
          originLeft: boxRect.left,
          originTop: boxRect.top,
          baseX: offsetX,
          baseY: offsetY,
          host: hostRect,
          box: { width: boxRect.width, height: boxRect.height },
          headerHeight: headerRect?.height ?? 32,
        };
        pe.preventDefault?.();
        return drag.pointerId;
      },
      (pe) => {
        if (drag === null) return;
        const dx = pe.clientX - drag.startX;
        const dy = pe.clientY - drag.startY;
        // Clamp against the host so the box never leaves the chart. The bottom edge is clamped by
        // the *header* height, not the box height: a box taller than the chart must still be able
        // to sit with its header visible, which is the only part that can drag it back.
        const left = clamp(
          drag.originLeft + dx,
          drag.host.left,
          drag.host.left + Math.max(0, drag.host.width - drag.box.width),
        );
        const top2 = clamp(
          drag.originTop + dy,
          drag.host.top,
          drag.host.top + Math.max(0, drag.host.height - drag.headerHeight),
        );
        offsetX = drag.baseX + (left - drag.originLeft);
        offsetY = drag.baseY + (top2 - drag.originTop);
        writeTransform();
      },
      () => {
        drag = null;
      },
    );
  }

  if (resizable) {
    const grip = make(doc, "div", {
      position: "absolute",
      right: "0",
      bottom: "0",
      // 24x24 for WCAG 2.2 target size (2.5.8); the two hairlines below occupy only the inner
      // corner, so the affordance still *looks* like the 14px grip the convention expects.
      width: "24px",
      height: "24px",
      cursor: "nwse-resize",
      touchAction: "none",
      // Two diagonal hairlines read as a grip without needing an image or a glyph.
      background:
        "linear-gradient(135deg, transparent 58%, var(--sg-dialog-border, #d6d3d1) 58%, " +
        "var(--sg-dialog-border, #d6d3d1) 63%, transparent 63%, transparent 74%, " +
        "var(--sg-dialog-border, #d6d3d1) 74%, var(--sg-dialog-border, #d6d3d1) 79%, " +
        "transparent 79%)",
    });
    grip.className = `${className}__grip`;
    // The grip is decoration over a gesture that the keyboard cannot perform and does not need:
    // the dialog's content scrolls, so nothing is unreachable at the default size.
    grip.setAttribute("aria-hidden", "true");
    root.appendChild(grip);
    gesture(
      register,
      doc,
      grip,
      (pe) => {
        const hostRect = rectOf(host);
        const boxRect = rectOf(root);
        if (hostRect === undefined || boxRect === undefined) return undefined;
        resize = {
          pointerId: pe.pointerId ?? 0,
          startX: pe.clientX,
          startY: pe.clientY,
          width: boxRect.width,
          height: boxRect.height,
          // Bound against the host's *far* edges from the box's own top-left, captured now: a box
          // dragged off-centre before being resized must still stop at the host it is caged in,
          // not at the host's raw width/height measured from the origin.
          maxWidth: hostRect.left + hostRect.width - boxRect.left,
          maxHeight: hostRect.top + hostRect.height - boxRect.top,
        };
        pe.stopPropagation?.();
        pe.preventDefault?.();
        return resize.pointerId;
      },
      (pe) => {
        if (resize === null) return;
        const width = clamp(resize.width + (pe.clientX - resize.startX), 200, resize.maxWidth);
        const height = clamp(resize.height + (pe.clientY - resize.startY), 120, resize.maxHeight);
        root.style.width = `${Math.round(width)}px`;
        root.style.height = `${Math.round(height)}px`;
        // An explicit size has to win over the proportional caps, or the drag stops at 90%/80%.
        root.style.maxWidth = "none";
        root.style.maxHeight = "none";
      },
      () => {
        resize = null;
      },
    );
  }

  host.appendChild(mounted);

  let disposed = false;
  return {
    root,
    header,
    body,
    get footer(): HTMLElement {
      return footerOf();
    },
    focus(): void {
      const ring = focusRing(root);
      (ring[0] ?? root).focus?.();
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      drag = null;
      resize = null;
      for (const entry of owned) entry.target.removeEventListener(entry.type, entry.fn);
      owned.length = 0;
      mounted.remove?.();
      // WCAG 2.4.3 — hand focus back to whatever had it before the dialog opened, as long as that
      // element is still part of the document; a since-removed opener (its panel closed too, say)
      // has nowhere sensible to receive it, so the browser's own post-removal focus handling stands.
      // Only do this when focus is still where the dialog left it — inside the dialog, or fallen to
      // `body` after the box was removed. If the user has since moved focus elsewhere (opened
      // another panel, clicked another control), yanking it back to the opener would fight them.
      const active = doc.activeElement as HTMLElement | null;
      const focusIsOurs = active === null || active === doc.body || root.contains?.(active) === true;
      if (
        focusIsOurs &&
        openerFocus !== null &&
        (openerFocus as unknown as { isConnected?: boolean }).isConnected !== false
      ) {
        openerFocus.focus?.();
      }
    },
  };
}
