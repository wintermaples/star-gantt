// docs/specs/plugins/resource.md §3.3 — the assignment column/editor chrome, applied as literal
// inline styles rather than a bundled `<style>` tag (this package's convention throughout: no
// per-instance stylesheet dependency). Static rules that never vary per instance live here; the
// handful that are genuinely computed per open (the editor's measured left/top/maxHeight in
// `editor.ts`, the drop-target outline toggled in `wire.ts`) stay inline at their call sites
// because a value computed at runtime cannot ride a shared style block anyway.
import { styled } from "@stargantt/sdk";

/** The "Resources" cell container: a flex row that never lets its content wrap
 *  or spill outside the cell tree-grid gives it. */
export function styleCell(el: HTMLElement): void {
  styled(el, {
    display: "flex",
    alignItems: "center",
    gap: "4px",
    overflow: "hidden",
  });
}

/** The open-editor button — WCAG 2.2 §2.5.8's >=24x24px hit area, flex:none so no chip count can
 *  clip or push it out of the cell's leading edge. */
export function styleOpenButton(el: HTMLElement): void {
  styled(el, {
    minWidth: "24px",
    minHeight: "24px",
    border: "none",
    borderRadius: "4px",
    background: "transparent",
    cursor: "pointer",
    font: "inherit",
    flex: "none",
  });
}

/** One assignment chip — block (not flex) so `text-overflow: ellipsis` actually applies, with a
 *  24px shrink floor below which it never gets clipped by its neighbors. */
export function styleChip(el: HTMLElement, draggable: boolean): void {
  styled(el, {
    display: "block",
    boxSizing: "border-box",
    minWidth: "24px",
    overflow: "hidden",
    textOverflow: "ellipsis",
    padding: "2px 6px",
    borderRadius: "8px",
    whiteSpace: "nowrap",
    background: "var(--sg-ra-chip-bg, rgba(15, 118, 110, 0.12))",
    cursor: draggable ? "grab" : "default",
  });
}

/** The editor dialog's own box. `left`/`top`/`maxHeight` are set separately, per open, by the
 *  placement math in `editor.ts`. */
export function styleEditor(el: HTMLElement): void {
  styled(el, {
    position: "absolute",
    zIndex: "1000",
    minWidth: "220px",
    display: "flex",
    flexDirection: "column",
    overflow: "hidden",
    padding: "8px",
    borderRadius: "6px",
    background: "var(--sg-ra-editor-bg, #ffffff)",
    color: "var(--sg-ra-editor-fg, #1f2937)",
    border: "1px solid var(--sg-ra-editor-border, rgba(0, 0, 0, 0.25))",
    boxShadow: "0 4px 16px rgba(0, 0, 0, 0.2)",
  });
}

/** The scrollable choice-row list: the only flex child allowed to grow/scroll, so Apply/Cancel
 *  never scroll away once `maxHeight` caps the dialog. */
export function styleRows(el: HTMLElement): void {
  styled(el, {
    flex: "1 1 auto",
    minHeight: "0",
    overflowY: "auto",
    overflowX: "hidden",
  });
}

/** One choice row: checkbox, name, percent input, laid out in a line. */
export function styleRow(el: HTMLElement): void {
  styled(el, {
    display: "flex",
    alignItems: "center",
    gap: "6px",
    minHeight: "24px",
  });
}

export function styleName(el: HTMLElement): void {
  styled(el, {
    flex: "1",
    whiteSpace: "nowrap",
  });
}

export function styleUnitsInput(el: HTMLElement): void {
  styled(el, {
    width: "56px",
    minHeight: "24px",
  });
}

export function styleButtons(el: HTMLElement): void {
  styled(el, {
    display: "flex",
    flex: "0 0 auto",
    justifyContent: "flex-end",
    gap: "6px",
    marginTop: "8px",
  });
}

/** Apply / Cancel — the same >=24x24px hit-area floor as the open button. */
export function styleApplyCancel(el: HTMLElement): void {
  styled(el, {
    minWidth: "24px",
    minHeight: "24px",
  });
}

/** The drop-target outline applied to a cell being dragged over — a >=3:1 UI-component affordance
 *  against both light and dark grounds, never the sole signal (the `.sg-ra-drop` class rides along
 *  with it so a host stylesheet can add a second cue). */
export const DROP_OUTLINE = "2px solid var(--sg-ra-drop-outline, #0f766e)";
