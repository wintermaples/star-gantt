/**
 * What one header paint needs to know.
 *
 * Its own module because three of them read it — the layout pass (`header-layout.ts`), the label
 * pass (`header-labels.ts`) and the two paint paths (`header.ts`) — and because the on-screen
 * canvas and the export tiles differ in exactly the four fields `HeaderPaintInputs` leaves out.
 *
 * Internal: not part of the published surface.
 */
import type { HeaderCell, ZoomLevel } from "./index";

/**
 * Which of the header's two typographic tiers a row belongs to.
 *
 * `"major"` is the coarse top row of a multi-row header — the months above the days — and
 * `"minor"` is every other row, including the only row of a single-row header.
 */
export type HeaderTier = "major" | "minor";

export interface HeaderDrawOptions {
  level: ZoomLevel;
  locale: string;
  // docs/specs/plugins/view.md — display time zone: absent
  // means the pre-existing UTC arithmetic, byte-identical by construction.
  /** IANA zone the boundary arithmetic runs in; absent means UTC. */
  timeZone?: string;
  // docs/specs/plugins/view.md — the header-cell template
  // hook, already wrapped in its latched fault barrier by the caller: the paint may call it
  // freely and treat any non-string result as "keep the default label".
  /** Custom label producer; a non-string result keeps the row's own formatted label. */
  cellFormat?(cell: HeaderCell): string | null | undefined;
  // docs/specs/plugins/view.md — the token value; `rowRatio` divides it.
  /** Total header height in CSS pixels. */
  height: number;
  // docs/specs/plugins/view.md
  // colours come from theme tokens; empty string means "token unavailable" and falls back to the
  // built-in light-mode defaults.
  /** Text colour (`--sg-header-fg`); empty string selects the built-in default. */
  fg: string;
  /** Band background (`--sg-header-bg`); empty string selects the built-in default. */
  bg: string;
  /** Row separator and coarse-tier cell separator colour (`--sg-header-tick`); empty string selects the built-in default. */
  border: string;
  /**
   * Fine-tier cell separator colour (`--sg-grid-line-major`); empty string selects the
   * built-in default.
   *
   * The per-day ticks are ground, not figure: the day numbers themselves carry the reading, and
   * ruling every column at the same weight as the month boundary turns the header into a mesh.
   */
  borderMinor: string;
  // docs/specs/plugins/view.md — canvas text is themeable through font
  // tokens, and the header's two tiers carry one token each so the coarse tier can differ in
  // weight without differing in family or size.
  /** Fine-tier label font (`--sg-header-font`); empty string selects the built-in default. */
  font: string;
  /**
   * Coarse-tier label font (`--sg-header-major-font`) — the top row of a multi-row header. An
   * empty string falls back to the fine-tier font, so a header whose theme sets only `font` paints
   * both tiers alike.
   */
  fontMajor: string;
  // docs/specs/plugins/view.md
  /** Weekday `"week"` boundaries fall on: 0 = Sunday … 6 = Saturday. */
  firstDayOfWeek: number;
  // docs/specs/plugins/view.md
  /** The top row's share of `height` for a two-row header; other row counts split evenly. */
  rowRatio: number;
  /** Inner padding between a label and its cell's left edge, in CSS pixels. */
  labelPadding: number;
  // docs/specs/plugins/view.md — the sticky-leading-label rule serves a
  // *scrolling viewport*; an export tile is a slice of one seamless static image, where a pinned
  // label at every tile seam duplicated the month caption mid-month.
  /**
   * Whether a cell straddling the surface's left edge pins its label to that edge (, the
   * on-screen header). `false` (export tiles) paints every label at its true boundary
   * position instead — a straddling cell's label lands at its negative x, so the halves the clip
   * leaves in adjacent tiles compose into one seamless caption.
   */
  sticky: boolean;
  // docs/specs/plugins/view.md — label thinning must agree across export tile
  // seams; a tile-local candidate set can resolve a different factor than its neighbour's,
  // dropping one half of a straddling caption.
  /**
   * Time span to compute fit-based label thinning over, instead of the painted span.
   * Export tiles pass the whole exported range here so every tile agrees on the same factor;
   * absent (the on-screen header), thinning is computed from the visible candidates as always.
   */
  thinningRange?: { from: number; to: number };
  // docs/specs/plugins/view.md
  /** Virtual horizontal scroll offset; the header follows it and never `scrollTop`. */
  scrollLeft: number;
  width: number;
  /** Content x of a time — i.e. the `tToX` of the provided service. */
  tToX(t: number): number;
  /** Inverse of `tToX`. */
  xToT(x: number): number;
  // docs/specs/plugins/view.md — the geometry pass needs a label's
  // painted width to decide whether the sticky leading label fits its visible sliver and whether a
  // row's labels need fit-based thinning. The caller sources this from the header canvas context
  // and memoises it per font + text (§1.7.1/§1.7.2's shared-geometry-pass note).
  /**
   * Width, in CSS px, `text` would paint at in the given tier's font.
   *
   * The tier is passed rather than assumed because gives the coarse tier a heavier font: a
   * width measured in the fine tier's font would under-report every coarse label, and thinning
   * decisions taken on that width let bold month captions collide.
   */
  measureText(text: string, tier: HeaderTier): number;
  // docs/specs/architecture.md
  /**
   * Called when a `ScaleRow.format` callback throws.
   *
   * `format` is a function carried by a `timeline/zoomLevels` contribution; function-shaped
   * contributions are invoked by the plugin that owns the extension point, which must guard them
   * and report the fault rather than letting it escape into the paint loop.
   */
  onFormatError(error: unknown): void;
}

/**
 * Everything a header paint reads live — active level, locale, theme tokens, week start, row
 * geometry, the axis mapping and the measurement channel — with the surface-specific fields left
 * out.
 *
 * The on-screen canvas adds its own box and `scrollLeft` plus `sticky: true`; an export tile adds
 * the tile's box, the `scrollLeft` derived from the tile's start, `sticky: false` and the
 * whole-export `thinningRange` (docs/specs/plugins/view.md). Both therefore agree, by construction,
 * on every input that is *not* about which slice of the axis is being painted.
 */
export type HeaderPaintInputs = Omit<
  HeaderDrawOptions,
  "height" | "width" | "scrollLeft" | "sticky" | "thinningRange"
>;
