// docs/specs/plugins/export.md §9 — internal module: not part of the published surface.
/**
 * The 2D affine matrix algebra the recording proxy needs to fold Canvas2D transforms into the SVG
 * it writes: path points are baked through the current matrix, rectangles and text carry it as a
 * `transform` attribute, and stroke widths are scaled by it.
 *
 * Not part of the package's published surface.
 */

/** A 2D affine matrix `[a, b, c, d, e, f]`, in the order `CanvasRenderingContext2D.transform` takes. */
export type Matrix = [number, number, number, number, number, number];

export const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

/** A fresh mutable copy of the identity matrix. */
export function identity(): Matrix {
  return [...IDENTITY] as Matrix;
}

/** `m · n`, i.e. `n` applied before `m`, matching how Canvas2D concatenates transforms. */
export function multiply(m: Matrix, n: Matrix): Matrix {
  return [
    m[0] * n[0] + m[2] * n[1],
    m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4],
    m[1] * n[4] + m[3] * n[5] + m[5],
  ];
}

/** The matrix of `translate(x, y)`. */
export function translation(x: number, y: number): Matrix {
  return [1, 0, 0, 1, x, y];
}

/** The matrix of `scale(x, y)`. */
export function scaling(x: number, y: number): Matrix {
  return [x, 0, 0, y, 0, 0];
}

/** The matrix of `rotate(angle)`, the angle in radians. */
export function rotation(angle: number): Matrix {
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  return [cos, sin, -sin, cos, 0, 0];
}

export function applyX(m: Matrix, x: number, y: number): number {
  return m[0] * x + m[2] * y + m[4];
}

export function applyY(m: Matrix, x: number, y: number): number {
  return m[1] * x + m[3] * y + m[5];
}

/** The average axis scale of a matrix, used to scale stroke widths into device space. */
export function meanScale(m: Matrix): number {
  const sx = Math.hypot(m[0], m[1]);
  const sy = Math.hypot(m[2], m[3]);
  return (sx + sy) / 2;
}

export function isIdentity(m: Matrix): boolean {
  return m[0] === 1 && m[1] === 0 && m[2] === 0 && m[3] === 1 && m[4] === 0 && m[5] === 0;
}
