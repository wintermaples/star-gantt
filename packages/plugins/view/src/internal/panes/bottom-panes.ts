/**
 * Bottom-region planning — pure, hostless (`.claude/skills/gantt-ui-ux/references/code-quality.md`
 * §1): contribution normalization (sanitizing, ordering, duplicate-id handling), the divider's
 * accessible-name fallback and the height-resize clamp all live here, testable without a host.
 * The DOM writes stay in the plugin's wiring modules.
 */
// docs/specs/plugins/view.md — "Bottom region" —
// docs/specs/plugins/view.md — (contribution shape) (clamp),
// (interactive floor).

/**
 * The elements handed to a `view/bottomPanes` contribution's `mount`. The pane and its
 * three columns are created, classed, sized and disposed by `stargantt.panes`; the contributor
 * renders into the columns. The column widths track the layout above: the gutter matches the
 * left panes and their dividers, the body matches the chart pane, and the trailing column
 * matches the right panes and their dividers.
 */
// Contribution surface:; column-width tracking:
// (docs/specs/plugins/view.md — "Bottom-pane columns").
export interface BottomPaneElements {
  /** The whole strip: `.sg-bottom-pane`. */
  pane: HTMLElement;
  /** Column aligned with the left panes: `.sg-bottom-pane__gutter`. */
  gutter: HTMLElement;
  /** Column aligned with the chart pane: `.sg-bottom-pane__body`. */
  body: HTMLElement;
  /** Column aligned with the right panes: `.sg-bottom-pane__trailing`. */
  trailing: HTMLElement;
}

/** One full-width strip of the bottom region, stacked below the pane row. */
// Contribution shape: (docs/specs/plugins/view.md — "Bottom region").
export interface BottomPaneContribution {
  /** Unique among contributions; duplicates keep the first and are reported via `core/pluginError`. */
  id: string;
  /** Ascending order stacks downward from the pane row; ties by registration order. Default 0. */
  order?: number;
  /** Initial height in CSS px. Unusable values (non-finite, negative) count as 0. */
  height: number;
  /**
   * Lower clamp for resize, CSS px. Default 0. On a resizable pane no gesture goes below 24 px —
   * the divider's own minimum target size — even when this value is lower, so a drag, a keyboard
   * step or Home can never remove the divider that performed it. The height command is floored the
   * same way except at exactly 0, which releases the pane: it and its divider are hidden, and the
   * same command brings them back. That is how a contributor shows and hides its own strip.
   */
  minHeight?: number; // interactive floor:
  /** Upper clamp for resize, CSS px. Default unbounded. */
  maxHeight?: number;
  /**
   * Omitted = true. `false` renders no divider for this pane at all — no separator element and
   * no resize.
   */
  resizable?: boolean;
  /**
   * Optional. The accessible name of this pane's divider (its `role="separator"` element).
   * Surrounding whitespace is trimmed. Localization is the contributor's/host's concern; when
   * omitted — or empty or blank, since an accessible name must never be missing on a tabbable
   * separator — the divider is named `"Resize panel"`.
   */
  label?: string;
  /**
   * Optional. Called with the pane's new height in CSS px after every applied height change —
   * pointer drag, keyboard step or `view/setBottomPaneHeight` — that actually changed the
   * height. The reported height is the height the pane actually gets, after the layout's clamp.
   * Not called for the initial height.
   */
  onResize?(height: number): void;
  /**
   * Called exactly once, after every plugin's setup() has completed and after the side panes are
   * mounted, with the pane's elements. The contributor renders into the columns and registers its
   * own listeners/observers via its `ctx.own()`; the elements themselves are created and disposed
   * by `stargantt.panes`.
   */
  mount(elements: BottomPaneElements): void;
}

/**
 * The default accessible name of a bottom pane's horizontal divider. Deliberately one word away
 * from the side dividers' `"Resize pane"`: it names a full-width strip of chrome, not one of the
 * row's panes.
 */
// docs/specs/plugins/view.md — the two defaults must not be unified.
const DEFAULT_BOTTOM_LABEL = "Resize panel";

/**
 * The interactive floor a resizable bottom pane can never be driven below, in CSS px — the
 * divider's own minimum pointer-target size, so a resize can never remove the affordance that
 * performed it.
 */
// docs/specs/plugins/view.md —.
export const BOTTOM_INTERACTIVE_FLOOR_PX = 24;

/** A `view/bottomPanes` contribution with every optional field defaulted and sanitized. */
export interface NormalizedBottomPane {
  id: string;
  /** Sanitized initial height: non-finite and negative contributions count as 0. */
  height: number;
  /** Sanitized `minHeight`: unusable (non-finite, negative) values count as the default 0. */
  minHeight: number;
  /** Sanitized `maxHeight`: unusable (non-finite, negative) values count as unbounded. */
  maxHeight: number;
  resizable: boolean;
  /** The divider's accessible name: the contributed `label` (trimmed), or the default when
   * blank/omitted. */
  label: string;
  onResize: ((height: number) => void) | undefined;
  mount: (elements: BottomPaneElements) => void;
}

/**
 * Normalizes the collected contributions: duplicates keep the first (later ids are returned for
 * fault reporting), the survivors are sorted by `order` ascending — lower orders sit closer to
 * the pane row, so ascending order stacks downward — with ties resolved by registration order,
 * and every optional field is defaulted (`order` 0, `minHeight` 0, `maxHeight` unbounded,
 * `resizable` true) with unusable numeric values silently replaced by the defaults.
 */
// docs/specs/plugins/view.md — "Bottom region".
export function normalizeBottomContributions(raw: readonly BottomPaneContribution[]): {
  panes: NormalizedBottomPane[];
  duplicateIds: string[];
} {
  const seen = new Set<string>();
  const unique: { c: BottomPaneContribution; i: number }[] = [];
  const duplicateIds: string[] = [];
  raw.forEach((c, i) => {
    if (seen.has(c.id)) {
      duplicateIds.push(c.id);
      return;
    }
    seen.add(c.id);
    unique.push({ c, i });
  });

  const orderOf = (c: BottomPaneContribution): number =>
    typeof c.order === "number" && Number.isFinite(c.order) ? c.order : 0;
  unique.sort((a, b) => orderOf(a.c) - orderOf(b.c) || a.i - b.i);

  const panes = unique.map(({ c }): NormalizedBottomPane => {
    const label = typeof c.label === "string" ? c.label.trim() : "";
    return {
      id: c.id,
      height: Number.isFinite(c.height) && c.height > 0 ? c.height : 0,
      minHeight:
        typeof c.minHeight === "number" && Number.isFinite(c.minHeight) && c.minHeight > 0
          ? c.minHeight
          : 0,
      maxHeight:
        typeof c.maxHeight === "number" && Number.isFinite(c.maxHeight) && c.maxHeight >= 0
          ? c.maxHeight
          : Infinity,
      resizable: c.resizable !== false,
      // The trimmed value, not the raw one: blankness was decided on the trimmed label, and a
      // label like " Resize band " must not carry its padding into the accessible name.
      label: label === "" ? DEFAULT_BOTTOM_LABEL : label,
      onResize: typeof c.onResize === "function" ? c.onResize.bind(c) : undefined,
      // A malformed runtime contribution without a callable `mount` must fail inside the mount
      // fault barrier — reported via `core/pluginError` like a throwing mount — not here.
      mount:
        typeof c.mount === "function"
          ? c.mount.bind(c)
          : () => {
              throw new TypeError(
                `view/bottomPanes contribution "${c.id}" has no mount function`,
              );
            },
    };
  });
  return { panes, duplicateIds };
}

/** The inputs of {@link bottomResizeBounds}, all in CSS px. */
export interface BottomBoundsInput {
  /** Whether the pane renders a divider; only a resizable pane carries the 24 px floor. */
  resizable: boolean;
  /** The contribution's sanitized lower clamp. */
  minHeight: number;
  /** The contribution's sanitized upper clamp (`Infinity` = unbounded). */
  maxHeight: number;
  /** The pane's current height. */
  currentHeight: number;
  /** The pane row's current laid-out height, or `null` when it cannot be measured. */
  rowHeight: number | null;
  /**
   * The pane row's own height floor — the computed `--sg-pane-row-min-height` token — or `null`
   * when the token cannot be read or does not parse, which drops the row-derived upper bound.
   */
  rowMinHeight: number | null;
}

/**
 * A bottom pane's effective resize range. The floor of a resizable pane is
 * `max(minHeight, 24)` — a resize can never remove the pane's divider — while a pane without a
 * divider clamps at its plain `minHeight`. The maximum is `max(floor, min(maxHeight, room))`,
 * where `room` is the height the pane could grow to before the pane row is squeezed below its
 * own floor (the pane's current height plus the row's current height, less the row's
 * `--sg-pane-row-min-height`); taking the outer `max` against the floor keeps a root shorter
 * than the row floor (a negative `room`) from inverting the clamp. When the row floor cannot be
 * determined the range degrades to `[floor, max(floor, maxHeight)]`.
 */
// docs/specs/plugins/view.md — "Horizontal divider" and
// "Interactive floor"; the degradation mirrors the treatment of
// `--sg-chart-min-width` on the vertical axis.
export function bottomResizeBounds(input: BottomBoundsInput): { min: number; max: number } {
  const floor = input.resizable
    ? Math.max(input.minHeight, BOTTOM_INTERACTIVE_FLOOR_PX)
    : input.minHeight;
  let max = input.maxHeight;
  if (input.rowHeight !== null && input.rowMinHeight !== null) {
    const room = input.currentHeight + input.rowHeight - input.rowMinHeight;
    max = Math.min(max, room);
  }
  return { min: floor, max: Math.max(floor, max) };
}
