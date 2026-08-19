// docs/specs/plugins/export.md §9 — internal module: not part of the published surface.
// §1.1 "True-vector SVG": per-layer vector/raster detection; `ViewService.renderTo` composites
// every registered layer into one surface, tile by tile.
/**
 * The recording proxy's output sink, split per top-level `save()` / `restore()` block.
 *
 * `ViewService.renderTo` brackets every layer contribution in exactly one such block, so a block is
 * one layer's drawing pass — which is what lets the SVG export decide vector-versus-raster per
 * layer even though `renderTo` composites all layers into a single surface. Anything emitted while
 * no top-level block is open lands in `loose`.
 *
 * Not part of the package's published surface.
 */

/** One `save()` / `restore()` block's worth of recorded output. */
export interface Block {
  parts: string[];
  /** Names of members touched that the subset does not implement (empty ⇒ the block is usable). */
  unsupported: Set<string>;
}

export function emptyBlock(): Block {
  return { parts: [], unsupported: new Set<string>() };
}

/** Routes emitted elements and unsupported-member reports to the block that is open, if any. */
export class BlockSink {
  /** Top-level blocks in call order; index `k` is the `k`-th block the pass opened. */
  readonly blocks: Block[] = [];
  /** Output made while no top-level block was open. */
  readonly loose: Block = emptyBlock();
  /** Every emitted element in call order, blocks and loose output interleaved as they happened. */
  readonly ordered: string[] = [];

  private depth = 0;
  private index = -1;

  /** The open block, or `loose` when none is. */
  private target(): Block {
    if (this.depth > 0) {
      const open = this.blocks[this.index];
      if (open !== undefined) return open;
    }
    return this.loose;
  }

  emit(part: string): void {
    this.target().parts.push(part);
    this.ordered.push(part);
  }

  /** Records that a member outside the implemented subset was touched. */
  flag(name: string): void {
    this.target().unsupported.add(name);
  }

  /**
   * One `save()`.
   *
   * At depth 0 it opens the next top-level block. The block is created eagerly, even when the layer
   * draws nothing, so block indices line up across tiles and with the raster fallback's own
   * counting.
   */
  enter(): void {
    if (this.depth === 0) {
      this.index += 1;
      this.blocks[this.index] = emptyBlock();
    }
    this.depth += 1;
  }

  /** One `restore()`; an unbalanced one is ignored, as Canvas2D ignores it. */
  exit(): void {
    if (this.depth > 0) this.depth -= 1;
  }
}
