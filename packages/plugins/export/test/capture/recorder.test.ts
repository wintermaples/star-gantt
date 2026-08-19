import { describe, expect, it } from "vitest";
import { record, recordComposite } from "../../src/internal/capture/recorder";

// docs/specs/plugins/export.md §1.1 "True-vector SVG via a partial recording proxy"
describe("recording proxy: the implemented subset", () => {
  it("records filled rectangles with the fill style in force", () => {
    const r = record((g) => {
      g.fillStyle = "#123456";
      g.fillRect(4, 8, 20, 10);
    }, 100, 50);
    expect(r.ok).toBe(true);
    expect(r.svg).toBe(`<rect x="4" y="8" width="20" height="10" fill="#123456"/>`);
  });

  it("normalizes negative rectangle extents", () => {
    const r = record((g) => {
      g.fillStyle = "red";
      g.fillRect(30, 20, -10, -5);
    }, 100, 50);
    expect(r.svg).toContain(`x="20" y="15" width="10" height="5"`);
  });

  it("records stroked rectangles and lines with their stroke state", () => {
    const r = record((g) => {
      g.strokeStyle = "#0a0";
      g.lineWidth = 2;
      g.strokeRect(1, 1, 10, 10);
      g.beginPath();
      g.moveTo(0, 0);
      g.lineTo(50, 25);
      g.stroke();
    }, 100, 50);
    expect(r.ok).toBe(true);
    expect(r.svg).toContain(`<rect x="1" y="1" width="10" height="10" fill="none" stroke="#0a0" stroke-width="2"`);
    expect(r.svg).toContain(`<path d="M0 0L50 25" fill="none" stroke="#0a0" stroke-width="2"`);
  });

  it("emits dashes, caps and joins only when they differ from the canvas defaults", () => {
    const plain = record((g) => {
      g.beginPath();
      g.moveTo(0, 0);
      g.lineTo(1, 1);
      g.stroke();
    }, 10, 10);
    expect(plain.svg).not.toContain("stroke-linecap");
    expect(plain.svg).not.toContain("stroke-dasharray");

    const dashed = record((g) => {
      g.lineCap = "round";
      g.setLineDash([4, 2]);
      g.beginPath();
      g.moveTo(0, 0);
      g.lineTo(1, 1);
      g.stroke();
    }, 10, 10);
    expect(dashed.svg).toContain(`stroke-linecap="round"`);
    expect(dashed.svg).toContain(`stroke-dasharray="4 2"`);
  });

  it("fills closed paths, including the rect() and closePath() forms", () => {
    const r = record((g) => {
      g.fillStyle = "#fff";
      g.beginPath();
      g.rect(2, 2, 4, 4);
      g.fill();
    }, 10, 10);
    expect(r.ok).toBe(true);
    expect(r.svg).toBe(`<path d="M2 2L6 2L6 6L2 6Z" fill="#fff"/>`);
  });

  it("applies transforms: path points are baked, rectangles carry a matrix", () => {
    const r = record((g) => {
      g.translate(10, 5);
      g.beginPath();
      g.moveTo(0, 0);
      g.lineTo(2, 0);
      g.stroke();
      g.fillStyle = "#000";
      g.fillRect(0, 0, 3, 3);
    }, 100, 100);
    expect(r.ok).toBe(true);
    expect(r.svg).toContain(`d="M10 5L12 5"`);
    expect(r.svg).toContain(`transform="matrix(1 0 0 1 10 5)"`);
  });

  it("scales stroke widths of transformed paths into device space", () => {
    const r = record((g) => {
      g.scale(2, 2);
      g.lineWidth = 1;
      g.beginPath();
      g.moveTo(0, 0);
      g.lineTo(5, 0);
      g.stroke();
    }, 100, 100);
    expect(r.svg).toContain(`d="M0 0L10 0"`);
    expect(r.svg).toContain(`stroke-width="2"`);
  });

  it("save/restore restores both the style state and the transform", () => {
    const r = record((g) => {
      g.fillStyle = "#aaa";
      g.save();
      g.fillStyle = "#bbb";
      g.translate(50, 0);
      g.fillRect(0, 0, 1, 1);
      g.restore();
      g.fillRect(0, 0, 1, 1);
    }, 100, 100);
    expect(r.ok).toBe(true);
    expect(r.svg).toContain(`fill="#bbb"`);
    expect(r.svg).toContain(`transform="matrix(1 0 0 1 50 0)"`);
    expect(r.svg.endsWith(`<rect x="0" y="0" width="1" height="1" fill="#aaa"/>`)).toBe(true);
  });

  it("records text with its font, anchor and baseline", () => {
    const r = record((g) => {
      g.font = "12px sans-serif";
      g.textAlign = "center";
      g.textBaseline = "middle";
      g.fillStyle = "#222";
      g.fillText("A & B", 20, 10);
    }, 100, 50);
    expect(r.ok).toBe(true);
    expect(r.svg).toContain(`<text x="20" y="10" style="font: 12px sans-serif"`);
    expect(r.svg).toContain(`text-anchor="middle"`);
    expect(r.svg).toContain(`dominant-baseline="central"`);
    expect(r.svg).toContain(`>A &amp; B</text>`);
  });

  it("approximates measureText from the font size so layers can still lay text out", () => {
    const widths: number[] = [];
    const r = record((g) => {
      g.font = "20px sans-serif";
      widths.push(g.measureText("abcd").width);
    }, 100, 50);
    expect(r.ok).toBe(true);
    expect(widths[0]).toBeGreaterThan(0);
  });

  it("records circular arcs (the dependency ports) as Bézier path segments", () => {
    const r = record((g) => {
      g.fillStyle = "#000";
      g.beginPath();
      g.arc(10, 10, 4, 0, Math.PI * 2);
      g.fill();
    }, 50, 50);
    expect(r.ok).toBe(true);
    // A full turn is four quarter-turn cubics, starting at (cx + r, cy).
    expect(r.svg.startsWith(`<path d="M14 10C`)).toBe(true);
    expect(r.svg.match(/C/g)).toHaveLength(4);
    expect(r.svg).toContain(`fill="#000"`);
  });

  it("swallows clearRect, which an append-only SVG cannot express", () => {
    const r = record((g) => {
      g.clearRect(0, 0, 100, 50);
    }, 100, 50);
    expect(r.ok).toBe(true);
    expect(r.svg).toBe("");
  });

  it("escapes attribute values", () => {
    const r = record((g) => {
      g.fillStyle = `"><script>`;
      g.fillRect(0, 0, 1, 1);
    }, 10, 10);
    expect(r.svg).toContain(`fill="&quot;&gt;&lt;script&gt;"`);
  });

  it("carries globalAlpha through as opacity", () => {
    const r = record((g) => {
      g.globalAlpha = 0.5;
      g.fillStyle = "#000";
      g.fillRect(0, 0, 1, 1);
    }, 10, 10);
    expect(r.svg).toContain(`opacity="0.5"`);
  });
});

// §1.1 — per-pass fallback detection.
describe("recording proxy: fallback detection", () => {
  it("is usable for a pass that stays inside the subset", () => {
    const r = record((g) => {
      g.save();
      g.fillStyle = "#000";
      g.fillRect(0, 0, 5, 5);
      g.restore();
    }, 10, 10);
    expect(r).toMatchObject({ ok: true, unsupported: [] });
  });

  it("flags a pass that reaches for gradients", () => {
    const r = record((g) => {
      const grad = g.createLinearGradient(0, 0, 10, 0) as unknown as CanvasGradient;
      g.fillStyle = grad;
      g.fillRect(0, 0, 5, 5);
    }, 10, 10);
    expect(r.ok).toBe(false);
    expect(r.unsupported).toContain("createLinearGradient");
  });

  it("flags clipping, filters and image drawing", () => {
    for (const use of [
      (g: CanvasRenderingContext2D) => g.clip(),
      (g: CanvasRenderingContext2D) => {
        g.filter = "blur(2px)";
      },
      (g: CanvasRenderingContext2D) => g.drawImage({} as CanvasImageSource, 0, 0),
    ]) {
      const r = record(use, 10, 10);
      expect(r.ok).toBe(false);
      expect(r.unsupported.length).toBeGreaterThan(0);
    }
  });

  it("flags a non-string fill style (a pattern object) without throwing", () => {
    const r = record((g) => {
      g.fillStyle = { fake: true } as unknown as string;
      g.fillRect(0, 0, 1, 1);
    }, 10, 10);
    expect(r.ok).toBe(false);
    expect(r.unsupported).toContain("fillStyle(non-string)");
  });

  it("runs the whole pass so every unimplemented member is found in one go", () => {
    const r = record((g) => {
      g.clip();
      g.createPattern({} as CanvasImageSource, "repeat");
      g.fillRect(0, 0, 1, 1);
    }, 10, 10);
    expect(r.unsupported).toEqual(["clip", "createPattern"]);
  });

  it("reports a throwing pass as unusable rather than propagating", () => {
    const r = record(() => {
      throw new Error("boom");
    }, 10, 10);
    expect(r).toMatchObject({ ok: false });
    expect(r.unsupported).toContain("threw");
  });

  it("exposes a canvas stand-in so a size read does not force a fallback", () => {
    const seen: number[] = [];
    const r = record((g) => {
      seen.push(g.canvas.width, g.canvas.height);
    }, 120, 40);
    expect(r.ok).toBe(true);
    expect(seen).toEqual([120, 40]);
  });
});

// docs/specs/plugins/view.md — the render module's own composite split, one block per layer.
describe("recordComposite: per-layer blocks", () => {
  /** Mimics `ViewService.renderTo`: each layer bracketed in its own save/restore pair. */
  function composite(
    layers: readonly ((g: CanvasRenderingContext2D) => void)[],
  ): ReturnType<typeof recordComposite> {
    return recordComposite(
      (g) => {
        for (const layer of layers) {
          g.save();
          layer(g);
          g.restore();
        }
      },
      100,
      50,
    );
  }

  it("splits the pass into one block per top-level save/restore pair, in order", () => {
    const r = composite([
      (g) => {
        g.fillStyle = "#a00";
        g.fillRect(0, 0, 1, 1);
      },
      (g) => {
        g.fillStyle = "#0a0";
        g.fillRect(1, 1, 2, 2);
      },
    ]);
    expect(r.blocks).toHaveLength(2);
    expect(r.blocks.every((b) => b.ok)).toBe(true);
    expect(r.blocks[0]?.svg).toContain(`fill="#a00"`);
    expect(r.blocks[1]?.svg).toContain(`fill="#0a0"`);
    expect(r.loose).toEqual({ ok: true, svg: "", unsupported: [] });
  });

  it("flags only the block that left the subset", () => {
    const r = composite([
      (g) => g.fillRect(0, 0, 1, 1),
      (g) => g.clip(),
      (g) => g.fillRect(2, 2, 1, 1),
    ]);
    expect(r.blocks.map((b) => b.ok)).toEqual([true, false, true]);
    expect(r.blocks[1]?.unsupported).toEqual(["clip"]);
  });

  it("keeps an empty block for a layer that draws nothing, so indices stay aligned", () => {
    const r = composite([() => undefined, (g) => g.fillRect(0, 0, 1, 1)]);
    expect(r.blocks).toHaveLength(2);
    expect(r.blocks[0]?.svg).toBe("");
    expect(r.blocks[1]?.svg).not.toBe("");
  });

  it("counts nested save/restore inside a layer as part of that layer's block", () => {
    const r = composite([
      (g) => {
        g.save();
        g.fillRect(0, 0, 1, 1);
        g.restore();
        g.fillRect(1, 1, 1, 1);
      },
    ]);
    expect(r.blocks).toHaveLength(1);
    expect(r.blocks[0]?.svg.match(/<rect /g)).toHaveLength(2);
  });

  it("collects output made outside any block in `loose`", () => {
    const r = recordComposite(
      (g) => {
        g.fillStyle = "#00f";
        g.fillRect(0, 0, 1, 1);
      },
      10,
      10,
    );
    expect(r.blocks).toEqual([]);
    expect(r.loose.svg).toContain(`fill="#00f"`);
  });
});
