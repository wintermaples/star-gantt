// docs/specs/plugins/resource.md §3.3 "Grid column" — the grid-column cell: the
// open-editor button first (flex:none, never clipped), then one shrinkable/ellipsized chip per
// assignment. Pure DOM construction; the delegated listeners live in `wire.ts`, so re-rendering a
// cell registers nothing.
import type { AssignmentLike, Id } from "./model";
import { toUnitsPercent } from "./model";
import { styleCell, styleChip, styleOpenButton } from "./style";

/** What a cell render needs from the plugin instance. */
export interface CellDeps {
  assignmentsOf(taskId: Id): readonly AssignmentLike[];
  /** Display name of a resource (store name, else pool name, else the raw id). */
  nameOf(resourceId: Id): string;
  /** Latched `messages.chipLabel` wrapper. */
  chipText(name: string, unitsPercent: number): string;
  /** `messages.openEditorLabel`. */
  openLabel: string;
  /** Whether chips are drag sources (§3.3). */
  draggable: boolean;
}

/** Renders one "Resources" cell for a task into the element the tree-grid hands out. */
export function renderResourcesCell(el: HTMLElement, taskId: Id, deps: CellDeps): void {
  const doc = el.ownerDocument;
  el.textContent = "";
  el.setAttribute("data-sg-ra-cell", String(taskId));
  // Same comma-joined text as `getValue`, so hovering reads the full list at any column width.
  el.setAttribute("title", cellText(taskId, deps));
  styleCell(el);

  // The open button is the cell's FIRST child, flex:none: a fixed target at the cell's
  // leading edge that no assignment count can clip or push out, and that doesn't jump position as
  // chips come and go.
  const open = doc.createElement("button");
  // WCAG 2.2 §2.5.8 — a >=24x24px hit area even though the glyph is small.
  open.className = "sg-ra-open";
  open.setAttribute("type", "button");
  open.setAttribute("data-sg-ra-open", String(taskId));
  open.setAttribute("aria-label", deps.openLabel);
  open.textContent = "+";
  styleOpenButton(open);
  el.appendChild(open);

  for (const a of deps.assignmentsOf(taskId)) {
    const chip = doc.createElement("span");
    chip.className = "sg-ra-chip";
    chip.setAttribute("data-sg-ra-task", String(taskId));
    chip.setAttribute("data-sg-ra-res", String(a.resourceId));
    if (deps.draggable) chip.setAttribute("draggable", "true");
    chip.textContent = deps.chipText(deps.nameOf(a.resourceId), toUnitsPercent(a.units));
    // Block, not (inline-)flex: text-overflow only applies to block containers, so a
    // flex chip never ellipsizes its text no matter how narrow it got. `min-width: 24px` overrides
    // the flex item's automatic min-width (its content's min-content size), which is what lets the
    // chip give up width down to a 24px floor instead of pushing the next sibling out. Border-box,
    // or the 2+6px paddings ride on top of the floor and it is really 36px.
    styleChip(chip, deps.draggable);
    el.appendChild(chip);
  }
}

/** The cell's `getValue` text: comma-joined chip labels. */
export function cellText(taskId: Id, deps: Pick<CellDeps, "assignmentsOf" | "nameOf" | "chipText">): string {
  return deps
    .assignmentsOf(taskId)
    .map((a) => deps.chipText(deps.nameOf(a.resourceId), toUnitsPercent(a.units)))
    .join(", ");
}
