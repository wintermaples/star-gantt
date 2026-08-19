import { describe, expect, it } from "vitest";
import { num } from "../../src/internal/capture/svg/format";
import {
  IDENTITY,
  applyX,
  applyY,
  identity,
  isIdentity,
  meanScale,
  multiply,
  rotation,
  scaling,
  translation,
} from "../../src/internal/capture/svg/matrix";
import { BlockSink } from "../../src/internal/capture/svg/blocks";
import { PathBuilder } from "../../src/internal/capture/svg/path";
import { DrawStateStack, cloneState, initialState } from "../../src/internal/capture/svg/state";
import {
  alphaAttr,
  estimateTextWidth,
  fillPathElement,
  fillRectElement,
  rectGeometry,
  strokeAttrs,
  strokePathElement,
  strokeRectElement,
  textElement,
  transformAttr,
} from "../../src/internal/capture/svg/emit";

// The pieces the recording proxy is assembled from (docs/specs/plugins/export.md §1.1 "True-vector
// SVG"). `recorder.test.ts` pins the Canvas2D-facing behavior call by call; these tests pin each
// piece on its own so a failure names the piece that broke.

describe("num: fixed-precision formatting", () => {
  it("keeps up to three decimals and drops trailing zeros", () => {
    expect(num(1)).toBe("1");
    expect(num(1.5)).toBe("1.5");
    expect(num(1.0004)).toBe("1");
    expect(num(1.23456)).toBe("1.235");
    expect(num(-0.5)).toBe("-0.5");
  });

  it("formats a non-finite value as 0 so the markup stays valid", () => {
    expect(num(Number.NaN)).toBe("0");
    expect(num(Number.POSITIVE_INFINITY)).toBe("0");
  });
});

describe("matrix algebra", () => {
  it("hands out a fresh identity that callers may mutate", () => {
    const m = identity();
    expect(m).toEqual(IDENTITY);
    m[4] = 9;
    expect(IDENTITY[4]).toBe(0);
  });

  it("concatenates like Canvas2D: the new transform applies before the current one", () => {
    // translate(10, 5) then scale(2, 2) ⇒ a point at (3, 0) lands at (16, 5).
    const m = multiply(multiply(identity(), translation(10, 5)), scaling(2, 2));
    expect(applyX(m, 3, 0)).toBe(16);
    expect(applyY(m, 0, 1)).toBe(7);
  });

  it("rotates a quarter turn onto the y axis", () => {
    const m = rotation(Math.PI / 2);
    expect(applyX(m, 1, 0)).toBeCloseTo(0, 12);
    expect(applyY(m, 1, 0)).toBeCloseTo(1, 12);
  });

  it("reports the mean axis scale, which is what stroke widths are scaled by", () => {
    expect(meanScale(scaling(2, 2))).toBe(2);
    expect(meanScale(scaling(1, 3))).toBe(2);
    expect(meanScale(rotation(0.7))).toBeCloseTo(1, 12);
  });

  it("recognizes the identity, translations aside", () => {
    expect(isIdentity(identity())).toBe(true);
    expect(isIdentity(translation(0, 1))).toBe(false);
    expect(isIdentity(scaling(1, 1))).toBe(true);
  });
});

describe("DrawStateStack", () => {
  it("starts from the Canvas2D defaults", () => {
    expect(initialState()).toMatchObject({
      fillStyle: "#000",
      lineWidth: 1,
      lineCap: "butt",
      lineJoin: "miter",
      globalAlpha: 1,
      font: "10px sans-serif",
      textAlign: "start",
      textBaseline: "alphabetic",
      dash: [],
    });
  });

  it("copies the matrix and the dash pattern, not just the reference", () => {
    const a = initialState();
    a.dash = [4, 2];
    const b = cloneState(a);
    b.dash.push(1);
    b.ctm[4] = 7;
    expect(a.dash).toEqual([4, 2]);
    expect(a.ctm[4]).toBe(0);
  });

  it("restores styles and the transform saved earlier, innermost first", () => {
    const s = new DrawStateStack();
    s.state.fillStyle = "#a";
    s.save();
    s.state.fillStyle = "#b";
    s.state.ctm = translation(5, 0);
    s.save();
    s.state.fillStyle = "#c";
    s.restore();
    expect(s.state.fillStyle).toBe("#b");
    expect(s.state.ctm).toEqual([1, 0, 0, 1, 5, 0]);
    s.restore();
    expect(s.state.fillStyle).toBe("#a");
    expect(isIdentity(s.state.ctm)).toBe(true);
  });

  it("ignores an unbalanced restore, as Canvas2D does", () => {
    const s = new DrawStateStack();
    s.state.fillStyle = "#a";
    s.restore();
    s.restore();
    expect(s.state.fillStyle).toBe("#a");
  });
});

describe("PathBuilder: device-space path segments", () => {
  it("is empty until something is recorded", () => {
    const p = new PathBuilder();
    expect(p.isEmpty).toBe(true);
    expect(p.d).toBe("");
    p.moveTo(identity(), 1, 2);
    expect(p.isEmpty).toBe(false);
  });

  it("bakes every point through the matrix in force at the call", () => {
    const p = new PathBuilder();
    p.moveTo(translation(10, 5), 0, 0);
    p.lineTo(scaling(2, 2), 3, 4);
    expect(p.d).toBe("M10 5L6 8");
  });

  it("starts the subpath when lineTo has no current point", () => {
    const p = new PathBuilder();
    p.lineTo(identity(), 4, 4);
    p.lineTo(identity(), 5, 5);
    expect(p.d).toBe("M4 4L5 5");
  });

  it("records quadratic and cubic segments", () => {
    const p = new PathBuilder();
    p.moveTo(identity(), 0, 0);
    p.quadraticCurveTo(identity(), 1, 2, 3, 4);
    p.bezierCurveTo(identity(), 5, 6, 7, 8, 9, 10);
    expect(p.d).toBe("M0 0Q1 2 3 4C5 6 7 8 9 10");
  });

  it("closes back to the subpath start, and ignores closePath before any subpath", () => {
    const p = new PathBuilder();
    p.close();
    expect(p.isEmpty).toBe(true);
    p.moveTo(identity(), 2, 2);
    p.lineTo(identity(), 4, 2);
    p.close();
    p.lineTo(identity(), 6, 2);
    // After the close the current point is the subpath start again, so the next segment is an `L`.
    expect(p.d).toBe("M2 2L4 2ZL6 2");
  });

  it("expresses rect() as a closed four-point subpath so a rotation stays exact", () => {
    const p = new PathBuilder();
    p.rect(identity(), 2, 2, 4, 4);
    expect(p.d).toBe("M2 2L6 2L6 6L2 6Z");

    const rotated = new PathBuilder();
    rotated.rect(rotation(Math.PI / 2), 1, 0, 2, 0);
    expect(rotated.d).toBe("M0 1L0 3L0 3L0 1Z");
  });

  it("approximates an arc with at most quarter-turn cubics, in both directions", () => {
    const full = new PathBuilder();
    full.arc(identity(), 10, 10, 4, 0, Math.PI * 2);
    expect(full.d.startsWith("M14 10C")).toBe(true);
    expect(full.d.match(/C/g)).toHaveLength(4);

    const quarter = new PathBuilder();
    quarter.arc(identity(), 0, 0, 1, 0, Math.PI / 2);
    expect(quarter.d.match(/C/g)).toHaveLength(1);

    const counter = new PathBuilder();
    counter.arc(identity(), 0, 0, 1, 0, Math.PI / 2, true);
    // Counter-clockwise from 0 to π/2 is three quarters of a turn the other way round.
    expect(counter.d.match(/C/g)).toHaveLength(3);
  });

  it("connects an existing subpath to the arc's first point with a line", () => {
    const p = new PathBuilder();
    p.moveTo(identity(), 0, 0);
    p.arc(identity(), 10, 0, 2, 0, Math.PI / 2);
    expect(p.d.startsWith("M0 0L12 0C")).toBe(true);
  });

  it("drops everything on begin()", () => {
    const p = new PathBuilder();
    p.rect(identity(), 0, 0, 1, 1);
    p.begin();
    expect(p.isEmpty).toBe(true);
    p.lineTo(identity(), 3, 3);
    expect(p.d).toBe("M3 3");
  });
});

describe("emitters: state plus geometry to SVG", () => {
  it("omits opacity while the state is opaque or its alpha unusable", () => {
    const s = initialState();
    expect(alphaAttr(s)).toBe("");
    s.globalAlpha = Number.NaN;
    expect(alphaAttr(s)).toBe("");
    s.globalAlpha = 0.25;
    expect(alphaAttr(s)).toBe(`opacity="0.25"`);
  });

  it("omits the transform attribute for the identity", () => {
    const s = initialState();
    expect(transformAttr(s)).toBe("");
    s.ctm = translation(3, 4);
    expect(transformAttr(s)).toBe(`transform="matrix(1 0 0 1 3 4)"`);
  });

  it("normalizes negative rectangle extents into a positive box", () => {
    expect(rectGeometry(30, 20, -10, -5)).toBe(`x="20" y="15" width="10" height="5"`);
  });

  it("scales stroke width and dashes into device space, but not in transformed space", () => {
    const s = initialState();
    s.ctm = scaling(2, 2);
    s.dash = [4, 2];
    expect(strokeAttrs(s)).toBe(
      `stroke="#000" stroke-width="2" stroke-dasharray="8 4"`,
    );
    expect(strokeAttrs(s, true)).toBe(
      `stroke="#000" stroke-width="1" stroke-dasharray="4 2"`,
    );
  });

  it("writes caps and joins only when they differ from the canvas defaults", () => {
    const s = initialState();
    expect(strokeAttrs(s)).not.toContain("stroke-linecap");
    s.lineCap = "round";
    s.lineJoin = "bevel";
    expect(strokeAttrs(s)).toContain(`stroke-linecap="round"`);
    expect(strokeAttrs(s)).toContain(`stroke-linejoin="bevel"`);
  });

  it("emits filled and stroked paths without a transform (their geometry is already baked)", () => {
    const s = initialState();
    s.fillStyle = "#fff";
    s.ctm = translation(9, 9);
    expect(fillPathElement(s, "M0 0L1 1")).toBe(`<path d="M0 0L1 1" fill="#fff"/>`);
    expect(fillPathElement(s, "M0 0L1 1", "evenodd")).toContain(`fill-rule="evenodd"`);
    expect(strokePathElement(s, "M0 0L1 1")).toBe(
      `<path d="M0 0L1 1" fill="none" stroke="#000" stroke-width="1"/>`,
    );
  });

  it("emits rectangles carrying the matrix as a transform", () => {
    const s = initialState();
    s.fillStyle = "#123456";
    expect(fillRectElement(s, 4, 8, 20, 10)).toBe(
      `<rect x="4" y="8" width="20" height="10" fill="#123456"/>`,
    );
    s.ctm = translation(10, 5);
    expect(fillRectElement(s, 0, 0, 3, 3)).toContain(`transform="matrix(1 0 0 1 10 5)"`);
    expect(strokeRectElement(s, 1, 1, 2, 2)).toBe(
      `<rect x="1" y="1" width="2" height="2" fill="none" stroke="#000" stroke-width="1"` +
        ` transform="matrix(1 0 0 1 10 5)"/>`,
    );
  });

  it("escapes attribute values and text content", () => {
    const s = initialState();
    s.fillStyle = `"><script>`;
    expect(fillRectElement(s, 0, 0, 1, 1)).toContain(`fill="&quot;&gt;&lt;script&gt;"`);
    expect(textElement(s, "A & B", 0, 0, undefined, false)).toContain(`>A &amp; B</text>`);
  });

  it("maps textAlign and textBaseline, omitting the SVG defaults", () => {
    const s = initialState();
    s.font = "12px sans-serif";
    s.fillStyle = "#222";
    expect(textElement(s, "x", 20, 10, undefined, false)).toBe(
      `<text x="20" y="10" style="font: 12px sans-serif" fill="#222">x</text>`,
    );
    s.textAlign = "center";
    s.textBaseline = "middle";
    const centered = textElement(s, "x", 20, 10, undefined, false);
    expect(centered).toContain(`text-anchor="middle"`);
    expect(centered).toContain(`dominant-baseline="central"`);
  });

  it("turns a finite maxWidth into textLength, and stroked text into a stroke", () => {
    const s = initialState();
    expect(textElement(s, "x", 0, 0, 40, false)).toContain(
      `textLength="40" lengthAdjust="spacingAndGlyphs"`,
    );
    expect(textElement(s, "x", 0, 0, Number.POSITIVE_INFINITY, false)).not.toContain("textLength");
    const stroked = textElement(s, "x", 0, 0, undefined, true);
    expect(stroked).toContain(`fill="none"`);
    expect(stroked).toContain(`stroke="#000"`);
  });

  it("estimates text width from the font's pixel size", () => {
    expect(estimateTextWidth("20px sans-serif", "abcd")).toBeGreaterThan(0);
    expect(estimateTextWidth("20px sans-serif", "abcd")).toBeGreaterThan(
      estimateTextWidth("10px sans-serif", "abcd"),
    );
    // A font declaration without a pixel size falls back to the Canvas2D default size.
    expect(estimateTextWidth("bold small-caps", "ab")).toBe(estimateTextWidth("10px x", "ab"));
  });
});

describe("BlockSink: per-block output routing", () => {
  it("sends output to loose while no top-level block is open", () => {
    const sink = new BlockSink();
    sink.emit("<a/>");
    sink.flag("clip");
    expect(sink.blocks).toEqual([]);
    expect(sink.loose.parts).toEqual(["<a/>"]);
    expect([...sink.loose.unsupported]).toEqual(["clip"]);
  });

  it("opens one block per top-level enter, eagerly even when nothing is emitted", () => {
    const sink = new BlockSink();
    sink.enter();
    sink.exit();
    sink.enter();
    sink.emit("<b/>");
    sink.exit();
    expect(sink.blocks).toHaveLength(2);
    expect(sink.blocks[0]?.parts).toEqual([]);
    expect(sink.blocks[1]?.parts).toEqual(["<b/>"]);
  });

  it("keeps nested enter/exit inside the enclosing block", () => {
    const sink = new BlockSink();
    sink.enter();
    sink.enter();
    sink.emit("<inner/>");
    sink.exit();
    sink.emit("<outer/>");
    sink.exit();
    expect(sink.blocks).toHaveLength(1);
    expect(sink.blocks[0]?.parts).toEqual(["<inner/>", "<outer/>"]);
  });

  it("keeps a single emission order across blocks and loose output", () => {
    const sink = new BlockSink();
    sink.emit("<loose/>");
    sink.enter();
    sink.emit("<in/>");
    sink.exit();
    sink.emit("<after/>");
    expect(sink.ordered).toEqual(["<loose/>", "<in/>", "<after/>"]);
    expect(sink.loose.parts).toEqual(["<loose/>", "<after/>"]);
  });

  it("ignores an unbalanced exit and routes to loose again afterwards", () => {
    const sink = new BlockSink();
    sink.exit();
    sink.enter();
    sink.exit();
    sink.exit();
    sink.emit("<x/>");
    expect(sink.loose.parts).toEqual(["<x/>"]);
    expect(sink.blocks).toHaveLength(1);
  });
});
