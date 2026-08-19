// docs/specs/plugins/export.md §9 — internal module: not part of the published surface.
// §1.1 "True-vector SVG via a partial recording proxy" — detection is per layer; `renderTo`
// composites every layer into one surface, tile by tile.
/**
 * A partial `CanvasRenderingContext2D` recording proxy that turns drawing calls into SVG elements.
 *
 * It implements the subset of the drawing surface the official layers actually use — rectangles,
 * paths, lines, text, transforms and basic state — and records an SVG fragment from them. Any
 * member outside that subset (gradients, patterns, clipping, filters, image drawing) is *detected*
 * rather than emulated: the call is swallowed and the member's name is reported, so the caller can
 * discard the recording and rasterize that one drawing pass instead.
 *
 * This module is the Canvas2D-shaped facade only; the pieces it drives live beside it in `./svg/` —
 * the drawing state and its stack (`svg/state.ts`), the affine matrix algebra (`svg/matrix.ts`), the
 * path builder (`svg/path.ts`), the element emitters (`svg/emit.ts`) and the per-block output sink
 * (`svg/blocks.ts`).
 *
 * Not part of the package's published surface.
 */

import { BlockSink } from "./svg/blocks";
import type { Block } from "./svg/blocks";
import {
  estimateTextWidth,
  fillPathElement,
  fillRectElement,
  strokePathElement,
  strokeRectElement,
  textElement,
} from "./svg/emit";
import { identity, multiply, rotation, scaling, translation } from "./svg/matrix";
import { PathBuilder } from "./svg/path";
import { DrawStateStack } from "./svg/state";
import type { DrawState } from "./svg/state";

/**
 * The recorder proper: a plain object whose members mirror the Canvas2D subset, accumulating SVG
 * element strings. Instances are always handed out wrapped in the detection proxy
 * (`record` / `recordComposite`), never bare.
 *
 * Output is split per top-level `save()` / `restore()` block; see `./svg/blocks.ts`.
 */
class SvgRecorder {
  private readonly sink = new BlockSink();
  private readonly states = new DrawStateStack();
  /** Path segments already expressed in device space (the CTM is applied as points are added). */
  private readonly path = new PathBuilder();

  /** A minimal stand-in for `ctx.canvas`, enough for the `canvas.width` / `canvas.height` reads. */
  readonly canvas: { width: number; height: number };

  constructor(width: number, height: number) {
    this.canvas = { width, height };
  }

  /** Top-level blocks in call order; index `k` is the `k`-th block the pass opened. */
  get blocks(): readonly Block[] {
    return this.sink.blocks;
  }
  /** Output made while no top-level block was open. */
  get loose(): Block {
    return this.sink.loose;
  }
  /** Every emitted element in call order, blocks and loose output interleaved as they happened. */
  get ordered(): readonly string[] {
    return this.sink.ordered;
  }

  /** Reports a member outside the implemented subset; the detection proxy calls this. */
  flag(name: string): void {
    this.sink.flag(name);
  }

  private get s(): DrawState {
    return this.states.state;
  }

  /* --- state ------------------------------------------------------- */

  get fillStyle(): string {
    return this.s.fillStyle;
  }
  set fillStyle(v: string) {
    // A gradient / pattern object is not a colour string: it cannot be expressed by this subset.
    if (typeof v === "string") this.s.fillStyle = v;
    else this.flag("fillStyle(non-string)");
  }

  get strokeStyle(): string {
    return this.s.strokeStyle;
  }
  set strokeStyle(v: string) {
    if (typeof v === "string") this.s.strokeStyle = v;
    else this.flag("strokeStyle(non-string)");
  }

  get lineWidth(): number {
    return this.s.lineWidth;
  }
  set lineWidth(v: number) {
    this.s.lineWidth = v;
  }

  get lineCap(): string {
    return this.s.lineCap;
  }
  set lineCap(v: string) {
    this.s.lineCap = v;
  }

  get lineJoin(): string {
    return this.s.lineJoin;
  }
  set lineJoin(v: string) {
    this.s.lineJoin = v;
  }

  get globalAlpha(): number {
    return this.s.globalAlpha;
  }
  set globalAlpha(v: number) {
    this.s.globalAlpha = v;
  }

  get font(): string {
    return this.s.font;
  }
  set font(v: string) {
    this.s.font = v;
  }

  get textAlign(): string {
    return this.s.textAlign;
  }
  set textAlign(v: string) {
    this.s.textAlign = v;
  }

  get textBaseline(): string {
    return this.s.textBaseline;
  }
  set textBaseline(v: string) {
    this.s.textBaseline = v;
  }

  setLineDash(segments: number[]): void {
    this.s.dash = Array.isArray(segments) ? segments.slice() : [];
  }

  getLineDash(): number[] {
    return this.s.dash.slice();
  }

  save(): void {
    this.sink.enter();
    this.states.save();
  }

  restore(): void {
    this.states.restore();
    this.sink.exit();
  }

  /* --- transforms --------------------------------------------------- */

  translate(x: number, y: number): void {
    this.s.ctm = multiply(this.s.ctm, translation(x, y));
  }

  scale(x: number, y: number): void {
    this.s.ctm = multiply(this.s.ctm, scaling(x, y));
  }

  rotate(angle: number): void {
    this.s.ctm = multiply(this.s.ctm, rotation(angle));
  }

  transform(a: number, b: number, c: number, d: number, e: number, f: number): void {
    this.s.ctm = multiply(this.s.ctm, [a, b, c, d, e, f]);
  }

  setTransform(a: number, b: number, c: number, d: number, e: number, f: number): void {
    // Only the six-argument form is part of the subset; the `DOMMatrix` form is not.
    if (typeof a !== "number") {
      this.flag("setTransform(matrix)");
      return;
    }
    this.s.ctm = [a, b, c, d, e, f];
  }

  resetTransform(): void {
    this.s.ctm = identity();
  }

  /* --- paths -------------------------------------------------------- */

  beginPath(): void {
    this.path.begin();
  }

  moveTo(x: number, y: number): void {
    this.path.moveTo(this.s.ctm, x, y);
  }

  lineTo(x: number, y: number): void {
    this.path.lineTo(this.s.ctm, x, y);
  }

  quadraticCurveTo(cx: number, cy: number, x: number, y: number): void {
    this.path.quadraticCurveTo(this.s.ctm, cx, cy, x, y);
  }

  bezierCurveTo(
    c1x: number,
    c1y: number,
    c2x: number,
    c2y: number,
    x: number,
    y: number,
  ): void {
    this.path.bezierCurveTo(this.s.ctm, c1x, c1y, c2x, c2y, x, y);
  }

  /** Circular arcs, as the official dependency ports draw them (approximated by cubic Béziers). */
  arc(cx: number, cy: number, r: number, start: number, end: number, counter = false): void {
    this.path.arc(this.s.ctm, cx, cy, r, start, end, counter);
  }

  closePath(): void {
    this.path.close();
  }

  rect(x: number, y: number, w: number, h: number): void {
    this.path.rect(this.s.ctm, x, y, w, h);
  }

  fill(rule?: string): void {
    if (this.path.isEmpty) return;
    this.sink.emit(fillPathElement(this.s, this.path.d, rule));
  }

  stroke(): void {
    if (this.path.isEmpty) return;
    this.sink.emit(strokePathElement(this.s, this.path.d));
  }

  /* --- rectangles ---------------------------------------------------- */

  fillRect(x: number, y: number, w: number, h: number): void {
    if (w === 0 || h === 0) return;
    this.sink.emit(fillRectElement(this.s, x, y, w, h));
  }

  strokeRect(x: number, y: number, w: number, h: number): void {
    this.sink.emit(strokeRectElement(this.s, x, y, w, h));
  }

  /**
   * `clearRect` erases pixels, which an append-only SVG document cannot express. Every official
   * layer uses it only to clear the whole canvas before painting, which an SVG fragment starts out
   * as anyway, so it records nothing rather than failing the recording.
   */
  clearRect(_x: number, _y: number, _w: number, _h: number): void {
    /* nothing to record */
  }

  /* --- text ---------------------------------------------------------- */

  fillText(text: string, x: number, y: number, maxWidth?: number): void {
    if (text === "") return;
    this.sink.emit(textElement(this.s, text, x, y, maxWidth, false));
  }

  strokeText(text: string, x: number, y: number, maxWidth?: number): void {
    if (text === "") return;
    this.sink.emit(textElement(this.s, text, x, y, maxWidth, true));
  }

  /**
   * An approximation, not a measurement: no font metrics exist off-screen. Layers use it to decide
   * whether a label fits, so a mean-glyph-width estimate keeps their layout decisions sane.
   */
  measureText(text: string): { width: number } {
    return { width: estimateTextWidth(this.s.font, text) };
  }
}

/**
 * One recorded drawing pass, or one layer's block of it — `record` and `recordComposite` report
 * the same three fields, so both use this one type.
 */
export interface RecordedBlock {
  /**
   * `true` when every call the block (or whole pass) made is inside the implemented subset, so
   * `svg` is a faithful vector transcription. `false` means the caller must rasterize it instead.
   */
  ok: boolean;
  /** The recorded SVG elements, concatenated (no wrapper element). */
  svg: string;
  /** The names of the members touched that the subset does not implement, in first-touch order. */
  unsupported: string[];
}

/**
 * A composite pass split per top-level `save()` / `restore()` block.
 *
 * `blocks[k]` is the `k`-th layer contribution `ViewService.renderTo` invoked, in z order; `loose`
 * holds anything the pass drew outside a block (`renderTo` itself draws nothing there).
 */
export interface CompositeRecording {
  blocks: RecordedBlock[];
  loose: RecordedBlock;
}

function run(
  draw: (g: CanvasRenderingContext2D) => void,
  width: number,
  height: number,
): SvgRecorder {
  const recorder = new SvgRecorder(width, height);
  const proxy = new Proxy(recorder as unknown as Record<string | symbol, unknown>, {
    get(target, prop, receiver): unknown {
      if (typeof prop === "symbol" || prop in target) return Reflect.get(target, prop, receiver);
      recorder.flag(String(prop));
      // A no-op stand-in keeps the pass running to completion, so every unimplemented member it
      // uses is discovered in a single run instead of one per retry.
      return () => undefined;
    },
    set(target, prop, value, receiver): boolean {
      if (typeof prop !== "symbol" && !(prop in target)) {
        recorder.flag(String(prop));
        return true;
      }
      return Reflect.set(target, prop, value, receiver);
    },
  });

  try {
    draw(proxy as unknown as CanvasRenderingContext2D);
  } catch {
    recorder.flag("threw");
  }
  return recorder;
}

function finish(block: Block): RecordedBlock {
  const unsupported = Array.from(block.unsupported);
  return { ok: unsupported.length === 0, svg: block.parts.join(""), unsupported };
}

/**
 * Runs one composite drawing pass against the recording proxy, split per layer.
 *
 * `draw` is expected to be a `ViewService.renderTo` call: it brackets each layer contribution in
 * its own top-level `save()` / `restore()` pair, so `blocks[k]` is the `k`-th layer's transcription
 * and carries its own `ok` flag. A layer that reaches outside the implemented subset therefore
 * fails alone (§1.1), and the block index it fails at is the same index the raster fallback
 * replays (see `layerFilter` in `./capture.ts`).
 */
export function recordComposite(
  draw: (g: CanvasRenderingContext2D) => void,
  width: number,
  height: number,
): CompositeRecording {
  const recorder = run(draw, width, height);
  return { blocks: recorder.blocks.map(finish), loose: finish(recorder.loose) };
}

/**
 * Runs one drawing pass against the recording proxy and returns its SVG transcription as a whole.
 *
 * `draw` receives an object that types as a `CanvasRenderingContext2D`; every member outside the
 * implemented subset is a no-op that flags the recording as unusable, so a pass that reaches for
 * gradients, patterns, clipping or image drawing degrades to `ok: false` rather than throwing.
 * A pass that throws is likewise reported as unusable, with `"threw"` among `unsupported`.
 *
 * The plugin itself only ever needs the per-layer split (`recordComposite`); this whole-pass form is
 * what the recorder's own unit tests are written against, since asserting one SVG string per pass is
 * how the Canvas2D-subset-to-SVG mapping is pinned call by call.
 */
export function record(
  draw: (g: CanvasRenderingContext2D) => void,
  width: number,
  height: number,
): RecordedBlock {
  const recorder = run(draw, width, height);
  const unsupported: string[] = [];
  for (const block of [recorder.loose, ...recorder.blocks]) {
    for (const name of block.unsupported) if (!unsupported.includes(name)) unsupported.push(name);
  }
  // `ordered` keeps the emission order across blocks, which a per-block concatenation would lose.
  return { ok: unsupported.length === 0, svg: recorder.ordered.join(""), unsupported };
}
