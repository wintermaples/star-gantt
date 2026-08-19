// docs/specs/plugins/export.md §9 — internal module: not part of the published surface.
/**
 * The recording proxy's drawing state and its `save()` / `restore()` stack.
 *
 * The state mirrors the Canvas2D members the implemented subset understands, starting from the
 * Canvas2D defaults, and the stack copies it on `save()` so a nested block cannot leak its styles
 * or its transform back out.
 *
 * Not part of the package's published surface.
 */
import { identity } from "./matrix";
import type { Matrix } from "./matrix";

/** The Canvas2D state the implemented subset tracks; `ctm` is the current transformation matrix. */
export interface DrawState {
  ctm: Matrix;
  fillStyle: string;
  strokeStyle: string;
  lineWidth: number;
  lineCap: string;
  lineJoin: string;
  globalAlpha: number;
  font: string;
  textAlign: string;
  textBaseline: string;
  dash: number[];
}

/** A state initialized to the Canvas2D defaults. */
export function initialState(): DrawState {
  return {
    ctm: identity(),
    fillStyle: "#000",
    strokeStyle: "#000",
    lineWidth: 1,
    lineCap: "butt",
    lineJoin: "miter",
    globalAlpha: 1,
    font: "10px sans-serif",
    textAlign: "start",
    textBaseline: "alphabetic",
    dash: [],
  };
}

/** A deep-enough copy: the matrix and the dash pattern are copied, every other field is a value. */
export function cloneState(s: DrawState): DrawState {
  return { ...s, ctm: [...s.ctm] as Matrix, dash: [...s.dash] };
}

/**
 * The current drawing state plus the `save()` / `restore()` stack.
 *
 * `save()` pushes a copy of the current state; `restore()` pops the most recent one, and an
 * unbalanced `restore()` (nothing pushed) keeps the current state rather than failing — Canvas2D
 * ignores it too.
 */
export class DrawStateStack {
  private current: DrawState = initialState();
  private readonly stack: DrawState[] = [];

  get state(): DrawState {
    return this.current;
  }

  save(): void {
    this.stack.push(cloneState(this.current));
  }

  restore(): void {
    const s = this.stack.pop();
    if (s !== undefined) this.current = s;
  }
}
