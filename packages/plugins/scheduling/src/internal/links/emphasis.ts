// docs/specs/plugins/scheduling.md §5.4 / §5.5
/**
 * The interactive emphasis state of the dependency lines: which link the pointer hovers, which
 * link is selected for editing, and which links lie on the highlighted dependency path of the
 * current task selection.
 *
 * One state object with named transitions, each returning whether anything changed so the caller
 * repaints only when needed (§5.5: "repaint only when the set changed"). No services, no canvas —
 * unit-testable without a host.
 */
import type { LinkId } from "@stargantt/plugin-data-store";

/** The emphasis state of one chart's dependency lines. */
export interface LinkEmphasis {
  /** Moves the hover to a link (or to none). Returns whether the hover actually changed. */
  setHover(id: LinkId | null): boolean;
  /** Selects a link for editing (or deselects). Returns whether the selection actually changed. */
  setSelected(id: LinkId | null): boolean;
  /** The link currently selected for editing, or `null`. */
  selected(): LinkId | null;
  /** Replaces the highlighted dependency path. Returns whether the set actually changed. */
  setPath(ids: ReadonlySet<LinkId>): boolean;
  /** Whether a link is hovered or on the highlighted path (the §5.5 emphasis). */
  emphasized(id: LinkId): boolean;
  /**
   * Whether anything at all is emphasized right now.
   *
   * While nothing is, every line keeps its ordinary look; while something is, the lines outside
   * the emphasized set recede to alpha 0.35 (§5.5).
   */
  anyEmphasized(): boolean;
  /** Whether a link is the selected one (the §5.4 emphasis). */
  isSelected(id: LinkId): boolean;
}

function sameSet(a: ReadonlySet<LinkId>, b: ReadonlySet<LinkId>): boolean {
  if (a.size !== b.size) return false;
  for (const id of a) if (!b.has(id)) return false;
  return true;
}

/** Creates the emphasis state for one chart. */
export function createLinkEmphasis(): LinkEmphasis {
  let hover: LinkId | null = null;
  let selected: LinkId | null = null;
  let path: ReadonlySet<LinkId> = new Set();

  return {
    setHover(id: LinkId | null): boolean {
      if (id === hover) return false;
      hover = id;
      return true;
    },
    setSelected(id: LinkId | null): boolean {
      if (id === selected) return false;
      selected = id;
      return true;
    },
    selected: () => selected,
    setPath(ids: ReadonlySet<LinkId>): boolean {
      if (sameSet(ids, path)) return false;
      path = ids;
      return true;
    },
    emphasized: (id: LinkId) => id === hover || path.has(id),
    anyEmphasized: () => hover !== null || path.size > 0,
    isSelected: (id: LinkId) => id === selected,
  };
}
