// docs/specs/plugins/a11y.md § Shortcut-help dialog.
/**
 * The opt-in keyboard-shortcut help dialog: a modal listing every described `keys/bindings`
 * contribution currently in force, opened and closed with `?` and closed with `Escape` or its close
 * button.
 *
 * The DOM exists only while the dialog is open, so an enabled-but-never-opened chart renders
 * nothing extra. While it is open no chart binding runs: the key dispatcher consults `handleStroke`
 * before any binding, and the swallow is narrow — modifier-carrying chords and the native scroll
 * keys are left to the browser un-prevented, everything else is claimed.
 */
import { focusRestorer, styled } from "@stargantt/sdk";
import type { KeyBinding } from "../types";
import type { ModalVerdict } from "./dispatch";
import { canonicalChord, parseChord } from "./keys";

const DIALOG_CLASS = "sg-a11y-help";
const TITLE_CLASS = "sg-a11y-help-title";
const LIST_CLASS = "sg-a11y-help-list";
const ROW_CLASS = "sg-a11y-help-row";
const KEY_CLASS = "sg-a11y-help-key";
const TEXT_CLASS = "sg-a11y-help-text";
const CLOSE_CLASS = "sg-a11y-help-close";

/** One dialog line: the chord as contributed, and its contributor-written label. */
export interface ShortcutEntry {
  key: string;
  description: string;
}

/**
 * The lines the dialog shows: every binding with a `description`, one line per chord with the
 * **last** contribution of that chord winning — exactly the binding the dispatcher would run — in
 * contribution order (oldest surviving contribution first).
 */
export function listShortcuts(bindings: readonly KeyBinding[] | undefined): ShortcutEntry[] {
  if (bindings === undefined) return [];
  const chosen = new Map<string, ShortcutEntry>();
  const order: string[] = [];
  // Scan newest-first so the dispatcher's last-wins rule picks the same binding per chord.
  for (let i = bindings.length - 1; i >= 0; i -= 1) {
    const binding = bindings[i];
    if (binding === undefined) continue;
    const chord = parseChord(binding.key);
    if (chord === undefined) continue;
    const canonical = canonicalChord(chord);
    if (chosen.has(canonical)) continue;
    const description = typeof binding.description === "string" ? binding.description.trim() : "";
    // The chord is claimed even when its winner is undescribed: a described older contribution it
    // shadows must not surface as if it still ran.
    chosen.set(canonical, { key: binding.key, description });
    order.push(canonical);
  }
  order.reverse();
  const entries: ShortcutEntry[] = [];
  for (const canonical of order) {
    const entry = chosen.get(canonical);
    if (entry !== undefined && entry.description !== "") entries.push(entry);
  }
  return entries;
}

export interface ShortcutHelpDeps {
  doc: Document;
  /** The chart root the dialog mounts into. */
  root: HTMLElement;
  /** The composed `keys/bindings` list, oldest contribution first. */
  bindings(): readonly KeyBinding[] | undefined;
  /** The dialog's accessible name and visible heading (catalog member). */
  title(): string;
  /** The close button's accessible name (catalog member). */
  closeLabel(): string;
}

export interface ShortcutHelp {
  isOpen(): boolean;
  /** Opens the dialog (rebuilding its list from the current bindings), or closes an open one. */
  toggle(): void;
  close(): void;
  /**
   * The modal keystroke hook. While the dialog is open, `Escape` and `?` close it and `Tab` /
   * `Shift`+`Tab` move the DOM focus around the dialog's own elements (both `"claim"`ed, so the
   * close button stays keyboard-reachable and the focus never escapes the modal); chords carrying
   * `Ctrl` / `Meta` / `Alt` and the native scroll keys answer `"pass"` — they stay the browser's
   * (page zoom, find-in-page, scrolling the dialog body) but still reach no chart binding; every
   * other plain key is swallowed (`"claim"`). Answers `"inactive"` while the dialog is closed so
   * normal dispatch proceeds.
   */
  handleStroke(stroke: {
    key: string;
    shiftKey?: boolean;
    ctrlKey?: boolean;
    metaKey?: boolean;
    altKey?: boolean;
  }): ModalVerdict;
}

// `references/visual-design.md` — a solid dark panel: white-on-#1f2937 is ~14:1, the kbd chips
// #f9fafb-on-#374151 ~10:1, both far above the 4.5:1 text minimum; no animation is used, so
// `prefers-reduced-motion` needs no special casing; the close button is a ≥ 24×24 px hit area.
export function createShortcutHelp(deps: ShortcutHelpDeps): ShortcutHelp {
  let dialog: HTMLElement | null = null;
  // The dialog's focus ring: the panel itself and its close button, in that order. Tab cycles
  // forward through it and Shift+Tab backwards, wrapping at both ends, so the focus never leaves
  // the modal and the close button is keyboard-reachable.
  let ring: HTMLElement[] = [];
  /** Where the DOM focus sat before the dialog took it, restored on close. */
  const restorer = focusRestorer(deps.doc);

  /** Moves the DOM focus one step around the ring, from whichever element holds it now. */
  function cycleFocus(step: number): void {
    if (ring.length === 0) return;
    const active = deps.doc.activeElement as unknown as HTMLElement | null;
    const at = active === null ? -1 : ring.indexOf(active);
    // Focus sitting outside the ring (nothing focused yet) enters it at the first element going
    // forward, and at the last one going backwards.
    const from = at < 0 ? (step > 0 ? -1 : 0) : at;
    const size = ring.length;
    const next = ring[(((from + step) % size) + size) % size];
    if (next !== undefined && typeof next.focus === "function") next.focus();
  }

  function close(): void {
    if (dialog === null) return;
    dialog.remove();
    dialog = null;
    ring = [];
    restorer.restore();
  }

  function open(): void {
    if (dialog !== null) return;
    const doc = deps.doc;
    restorer.save();

    const panel = doc.createElement("div");
    panel.className = DIALOG_CLASS;
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-modal", "true");
    panel.setAttribute("aria-label", deps.title());
    panel.setAttribute("tabindex", "-1");
    styled(panel, {
      position: "absolute",
      left: "50%",
      top: "50%",
      transform: "translate(-50%, -50%)",
      zIndex: "1000",
      minWidth: "280px",
      maxWidth: "440px",
      maxHeight: "80%",
      overflowY: "auto",
      background: "#1f2937",
      color: "#f9fafb",
      border: "1px solid #4b5563",
      borderRadius: "8px",
      padding: "16px",
      font: "13px/1.5 system-ui, sans-serif",
      boxShadow: "0 8px 24px rgba(0, 0, 0, 0.35)",
    });

    const title = doc.createElement("div");
    title.className = TITLE_CLASS;
    title.textContent = deps.title();
    styled(title, { fontSize: "14px", fontWeight: "600", marginBottom: "8px" });
    panel.appendChild(title);

    const closeButton = doc.createElement("button");
    closeButton.className = CLOSE_CLASS;
    closeButton.setAttribute("type", "button");
    closeButton.setAttribute("aria-label", deps.closeLabel());
    closeButton.textContent = "✕";
    styled(closeButton, {
      position: "absolute",
      top: "8px",
      right: "8px",
      minWidth: "24px",
      minHeight: "24px",
      background: "transparent",
      color: "#f9fafb",
      border: "none",
      cursor: "pointer",
      fontSize: "14px",
    });
    // No explicit removal, and no `ctx.own()` entry: the listener is bound to an element created
    // with the dialog and discarded with it — `close()` removes the whole overlay subtree, so the
    // button and its listener become unreachable together. Owning it separately would register a
    // new disposable on every open (`references/code-quality.md` §3, the re-arm leak shape).
    closeButton.addEventListener("click", () => close());
    panel.appendChild(closeButton);

    const list = doc.createElement("div");
    list.className = LIST_CLASS;
    for (const entry of listShortcuts(deps.bindings())) {
      const row = doc.createElement("div");
      row.className = ROW_CLASS;
      styled(row, { display: "flex", gap: "12px", alignItems: "baseline", margin: "4px 0" });
      const key = doc.createElement("kbd");
      key.className = KEY_CLASS;
      key.textContent = entry.key;
      styled(key, {
        background: "#374151",
        color: "#f9fafb",
        borderRadius: "4px",
        padding: "1px 6px",
        font: "12px ui-monospace, monospace",
        whiteSpace: "nowrap",
      });
      const text = doc.createElement("span");
      text.className = TEXT_CLASS;
      text.textContent = entry.description;
      row.appendChild(key);
      row.appendChild(text);
      list.appendChild(row);
    }
    panel.appendChild(list);

    deps.root.appendChild(panel);
    dialog = panel;
    ring = [panel, closeButton];
    if (typeof panel.focus === "function") panel.focus();
  }

  return {
    isOpen: () => dialog !== null,
    toggle: () => (dialog === null ? open() : close()),
    close,
    handleStroke: (stroke) => {
      if (dialog === null) return "inactive";
      // The swallow is narrow: a modifier-carrying chord belongs to the browser (Ctrl+'+'/'-' page
      // zoom is a WCAG 1.4.4 resize-text affordance, Ctrl+F is find-in-page), so it is neither
      // dispatched nor prevented. `"pass"` still stops the dispatcher, so no chart binding runs
      // behind the modal.
      if (stroke.ctrlKey === true || stroke.metaKey === true || stroke.altKey === true) {
        return "pass";
      }
      // Tab and Shift+Tab are exempt from the swallow rule: instead of being dropped they move the
      // focus around the dialog's own ring, which is what keeps the close button reachable without
      // letting the focus escape the modal.
      if (stroke.key === "Tab") {
        cycleFocus(stroke.shiftKey === true ? -1 : 1);
        return "claim";
      }
      if (stroke.key === "Escape" || stroke.key === "?") {
        close();
        return "claim";
      }
      // The scroll keys stay the browser's too, so a dialog list taller than the panel scrolls
      // natively while the panel holds the focus; the chart behind still sees nothing.
      switch (stroke.key) {
        case "ArrowUp":
        case "ArrowDown":
        case "PageUp":
        case "PageDown":
        case "Home":
        case "End":
          return "pass";
        default:
          break;
      }
      // Every other plain key is claimed while the modal is open — nothing reaches the chart behind
      // it.
      return "claim";
    },
  };
}
