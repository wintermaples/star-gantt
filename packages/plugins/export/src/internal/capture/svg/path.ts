// docs/specs/plugins/export.md §9 — internal module: not part of the published surface.
/**
 * The recording proxy's path builder: Canvas2D path calls turned into an SVG `d` attribute.
 *
 * Every point is transformed by the matrix in force when the call is made, so the recorded geometry
 * is already in device space — which is what lets `fill()` and `stroke()` emit a `<path>` with no
 * `transform` attribute of its own, exact for any affine transform.
 *
 * Not part of the package's published surface.
 */
import { num } from "./format";
import { applyX, applyY } from "./matrix";
import type { Matrix } from "./matrix";

interface Point {
  x: number;
  y: number;
}

/** Accumulates SVG path segments in device space. One instance stands for one Canvas2D path. */
export class PathBuilder {
  private segments: string[] = [];
  private cursor: Point | null = null;
  private subpathStart: Point | null = null;

  /** `true` while nothing has been recorded, i.e. there is no geometry to fill or stroke. */
  get isEmpty(): boolean {
    return this.segments.length === 0;
  }

  /** The accumulated segments as an SVG `d` attribute value. */
  get d(): string {
    return this.segments.join("");
  }

  /** `beginPath()`: drops every recorded segment and forgets the current point. */
  begin(): void {
    this.segments = [];
    this.cursor = null;
    this.subpathStart = null;
  }

  moveTo(m: Matrix, x: number, y: number): void {
    const px = applyX(m, x, y);
    const py = applyY(m, x, y);
    this.segments.push(`M${num(px)} ${num(py)}`);
    this.cursor = { x: px, y: py };
    this.subpathStart = { x: px, y: py };
  }

  /** A `lineTo` without a current point starts the subpath instead, as Canvas2D does. */
  lineTo(m: Matrix, x: number, y: number): void {
    const px = applyX(m, x, y);
    const py = applyY(m, x, y);
    if (this.cursor === null) {
      this.segments.push(`M${num(px)} ${num(py)}`);
      this.subpathStart = { x: px, y: py };
    } else {
      this.segments.push(`L${num(px)} ${num(py)}`);
    }
    this.cursor = { x: px, y: py };
  }

  quadraticCurveTo(m: Matrix, cx: number, cy: number, x: number, y: number): void {
    this.segments.push(
      `Q${num(applyX(m, cx, cy))} ${num(applyY(m, cx, cy))} ${num(applyX(m, x, y))} ${num(applyY(m, x, y))}`,
    );
    this.cursor = { x: applyX(m, x, y), y: applyY(m, x, y) };
  }

  bezierCurveTo(
    m: Matrix,
    c1x: number,
    c1y: number,
    c2x: number,
    c2y: number,
    x: number,
    y: number,
  ): void {
    this.segments.push(
      `C${num(applyX(m, c1x, c1y))} ${num(applyY(m, c1x, c1y))}` +
        ` ${num(applyX(m, c2x, c2y))} ${num(applyY(m, c2x, c2y))}` +
        ` ${num(applyX(m, x, y))} ${num(applyY(m, x, y))}`,
    );
    this.cursor = { x: applyX(m, x, y), y: applyY(m, x, y) };
  }

  /**
   * Circular arcs, as the official dependency ports draw them.
   *
   * The arc is approximated by cubic Béziers of at most a quarter turn each and its control points
   * go through the matrix like every other path point, which is exact for any affine transform.
   */
  arc(
    m: Matrix,
    cx: number,
    cy: number,
    r: number,
    start: number,
    end: number,
    counter = false,
  ): void {
    let sweep = end - start;
    const full = Math.PI * 2;
    if (counter) {
      if (sweep > 0) sweep -= full * Math.ceil(sweep / full);
      if (sweep < -full) sweep = -full;
    } else {
      if (sweep < 0) sweep += full * Math.ceil(-sweep / full);
      if (sweep > full) sweep = full;
    }

    const at = (angle: number): Point => ({
      x: cx + r * Math.cos(angle),
      y: cy + r * Math.sin(angle),
    });
    const first = at(start);
    if (this.cursor === null) this.moveTo(m, first.x, first.y);
    else this.lineTo(m, first.x, first.y);

    const steps = Math.max(1, Math.ceil(Math.abs(sweep) / (Math.PI / 2)));
    const delta = sweep / steps;
    const k = (4 / 3) * Math.tan(delta / 4);
    let angle = start;
    for (let i = 0; i < steps; i += 1) {
      const p0 = at(angle);
      const p1 = at(angle + delta);
      this.bezierCurveTo(
        m,
        p0.x - k * r * Math.sin(angle),
        p0.y + k * r * Math.cos(angle),
        p1.x + k * r * Math.sin(angle + delta),
        p1.y - k * r * Math.cos(angle + delta),
        p1.x,
        p1.y,
      );
      angle += delta;
    }
  }

  /** `closePath()`: a no-op while no subpath has been started, as Canvas2D does. */
  close(): void {
    if (this.subpathStart === null) return;
    this.segments.push("Z");
    this.cursor = { ...this.subpathStart };
  }

  /** `rect()`: a closed four-point subpath, so a rotated rectangle stays exact. */
  rect(m: Matrix, x: number, y: number, w: number, h: number): void {
    this.moveTo(m, x, y);
    this.lineTo(m, x + w, y);
    this.lineTo(m, x + w, y + h);
    this.lineTo(m, x, y + h);
    this.close();
  }
}
