/**
 * The recording canvas double this package's paint tests are written against.
 *
 * Test-only: nothing here enters the bundle. Trimmed from the same lineage as the view package's
 * `test/_utils/dom.ts` — each package keeps its test doubles inside
 * the package that needs them, so there is no shared harness package to import from. `happy-dom`
 * provides no 2d context, so it cannot stand in here: what these tests assert is *which* drawing
 * calls a pass makes, which a recording double answers directly.
 */

/** One recorded 2d-context call: the method, its numeric arguments and the state in effect. */
export interface Op {
  op: string;
  args: number[];
  fill: string;
  stroke: string;
  lineWidth: number;
  globalAlpha: number;
  /** The dash pattern in effect; empty for a solid line. */
  dash: number[];
}

/** One recorded `fillText` / `strokeText` call, with the text state in effect. */
export interface TextOp {
  text: string;
  x: number;
  y: number;
  fill: string;
  stroke: string;
  font: string;
  align: string;
  baseline: string;
}

/** A recording `CanvasGradient`: it collects its stops instead of rasterizing anything. */
export class FakeGradient {
  /** The `[x0, y0, x1, y1]` the gradient was created with. */
  readonly line: readonly [number, number, number, number];
  /** Every `addColorStop(offset, color)`, in call order. */
  readonly stops: { offset: number; color: string }[] = [];

  constructor(line: readonly [number, number, number, number]) {
    this.line = line;
  }

  addColorStop(offset: number, color: string): void {
    this.stops.push({ offset, color });
  }

  /** A stable textual form, so a recorded op's `fill` distinguishes a gradient from a colour. */
  toString(): string {
    return `linear-gradient(${this.stops.map((s) => `${String(s.offset)} ${s.color}`).join(", ")})`;
  }
}

/**
 * A recording 2d context: nothing is rasterized, every call is logged with the style state that
 * was in force, and the current transform is tracked through `setTransform` / `scale` /
 * `translate` and the `save()` / `restore()` stack.
 */
export class FakeContext2D {
  fillStyle = "";
  strokeStyle = "";
  font = "";
  textAlign = "";
  textBaseline = "";
  lineWidth = 1;
  lineCap = "";
  lineJoin = "";
  globalAlpha = 1;
  imageSmoothingEnabled = true;

  /** `[a, b, c, d, e, f]`, as `setTransform` takes them. */
  transform: [number, number, number, number, number, number] = [1, 0, 0, 1, 0, 0];

  readonly ops: Op[] = [];
  /** Every text call, in order — `Op.args` carries only numbers, so the string lives here. */
  readonly texts: TextOp[] = [];
  /** Current `save()` nesting depth, and the deepest it ever reached. */
  depth = 0;
  maxDepth = 0;

  private dash: number[] = [];
  private stack: {
    transform: [number, number, number, number, number, number];
    fillStyle: string;
    strokeStyle: string;
    font: string;
    textAlign: string;
    textBaseline: string;
    lineWidth: number;
    globalAlpha: number;
    dash: number[];
  }[] = [];

  /** Every gradient handed out by `createLinearGradient`, in creation order. */
  readonly gradients: FakeGradient[] = [];

  /**
   * A recording gradient. A real 2D context accepts one as `fillStyle`; painters that build one
   * (task-bars' bar bevel) are exercised through this rather than skipped, and its
   * `toString()` is what a recorded op's `fill` shows.
   */
  createLinearGradient(x0: number, y0: number, x1: number, y1: number): FakeGradient {
    const gradient = new FakeGradient([x0, y0, x1, y1]);
    this.gradients.push(gradient);
    return gradient;
  }

  /** Horizontal scale factor of the current transform. */
  get scaleX(): number {
    return this.transform[0];
  }
  /** Vertical scale factor of the current transform. */
  get scaleY(): number {
    return this.transform[3];
  }
  /** Horizontal translation of the current transform, in device px. */
  get tx(): number {
    return this.transform[4];
  }
  /** Vertical translation of the current transform, in device px. */
  get ty(): number {
    return this.transform[5];
  }

  private record(op: string, ...args: number[]): void {
    this.ops.push({
      op,
      args,
      // `String(...)` because a gradient is a legal `fillStyle`: the recorded op keeps a stable
      // textual form of whichever kind was in force, so assertions read the same either way.
      fill: String(this.fillStyle),
      stroke: String(this.strokeStyle),
      lineWidth: this.lineWidth,
      globalAlpha: this.globalAlpha,
      dash: [...this.dash],
    });
  }

  setTransform(a: number, b: number, c: number, d: number, e: number, f: number): void {
    this.transform = [a, b, c, d, e, f];
    this.record("setTransform", a, b, c, d, e, f);
  }
  resetTransform(): void {
    this.transform = [1, 0, 0, 1, 0, 0];
    this.record("resetTransform");
  }
  scale(x: number, y: number): void {
    const [a, b, c, d, e, f] = this.transform;
    this.transform = [a * x, b * x, c * y, d * y, e, f];
    this.record("scale", x, y);
  }
  translate(x: number, y: number): void {
    const [a, b, c, d, e, f] = this.transform;
    this.transform = [a, b, c, d, e + a * x + c * y, f + b * x + d * y];
    this.record("translate", x, y);
  }

  setLineDash(segments: number[]): void {
    this.dash = [...segments];
    this.record("setLineDash", ...segments);
  }
  getLineDash(): number[] {
    return [...this.dash];
  }

  clearRect(x: number, y: number, w: number, h: number): void {
    this.record("clearRect", x, y, w, h);
  }
  fillRect(x: number, y: number, w: number, h: number): void {
    this.record("fillRect", x, y, w, h);
  }
  strokeRect(x: number, y: number, w: number, h: number): void {
    this.record("strokeRect", x, y, w, h);
  }
  beginPath(): void {
    this.record("beginPath");
  }
  closePath(): void {
    this.record("closePath");
  }
  moveTo(x: number, y: number): void {
    this.record("moveTo", x, y);
  }
  lineTo(x: number, y: number): void {
    this.record("lineTo", x, y);
  }
  arc(x: number, y: number, r: number, from: number, to: number): void {
    this.record("arc", x, y, r, from, to);
  }
  arcTo(x1: number, y1: number, x2: number, y2: number, r: number): void {
    this.record("arcTo", x1, y1, x2, y2, r);
  }
  rect(x: number, y: number, w: number, h: number): void {
    this.record("rect", x, y, w, h);
  }
  fill(): void {
    this.record("fill");
  }
  stroke(): void {
    this.record("stroke");
  }
  clip(): void {
    this.record("clip");
  }

  fillText(text: string, x: number, y: number): void {
    this.texts.push(this.textOp(text, x, y));
    this.record("fillText", x, y);
  }
  strokeText(text: string, x: number, y: number): void {
    this.texts.push(this.textOp(text, x, y));
    this.record("strokeText", x, y);
  }
  /**
   * The advance width `measureText` gives every character, in CSS px.
   *
   * Raise it to make labels "too wide" for their slot without touching the text itself, which is
   * how a fit-based thinning or label-drop path is exercised deterministically.
   */
  charWidth = 6;

  /** A deterministic `charWidth` CSS px per character — enough for fit/thinning assertions. */
  measureText(text: string): { width: number } {
    return { width: text.length * this.charWidth };
  }

  save(): void {
    this.stack.push({
      transform: [...this.transform] as [number, number, number, number, number, number],
      fillStyle: this.fillStyle,
      strokeStyle: this.strokeStyle,
      font: this.font,
      textAlign: this.textAlign,
      textBaseline: this.textBaseline,
      lineWidth: this.lineWidth,
      globalAlpha: this.globalAlpha,
      dash: [...this.dash],
    });
    this.depth += 1;
    if (this.depth > this.maxDepth) this.maxDepth = this.depth;
    this.record("save");
  }
  restore(): void {
    const s = this.stack.pop();
    if (s !== undefined) {
      this.transform = s.transform;
      this.fillStyle = s.fillStyle;
      this.strokeStyle = s.strokeStyle;
      this.font = s.font;
      this.textAlign = s.textAlign;
      this.textBaseline = s.textBaseline;
      this.lineWidth = s.lineWidth;
      this.globalAlpha = s.globalAlpha;
      this.dash = s.dash;
      this.depth -= 1;
    }
    this.record("restore");
  }

  /* --- test helpers --- */

  /** Every recorded call of one method, in order. */
  calls(op: string): Op[] {
    return this.ops.filter((o) => o.op === op);
  }
  /** The recorded method names, in order — for asserting *ordering* (bodies before labels). */
  opNames(): string[] {
    return this.ops.map((o) => o.op);
  }
  /** Clears the logs but keeps the live state (transform, styles, save depth). */
  reset(): void {
    this.ops.length = 0;
    this.texts.length = 0;
    this.maxDepth = this.depth;
  }

  private textOp(text: string, x: number, y: number): TextOp {
    return {
      text,
      x,
      y,
      fill: this.fillStyle,
      stroke: this.strokeStyle,
      font: this.font,
      align: this.textAlign,
      baseline: this.textBaseline,
    };
  }
}

/* ------------------------------------------------------------------ *
 * Elements
 * ------------------------------------------------------------------ */

/** Casts the double to the context type the painters take. */
export function asContext(g: FakeContext2D): CanvasRenderingContext2D {
  return g as unknown as CanvasRenderingContext2D;
}
