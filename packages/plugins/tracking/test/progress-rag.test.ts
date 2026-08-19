// Covers the "RAG badge renderer (decor)" behavior of this area's `rag.ts`, plus a style-provider
// coverage pass.
import { describe, expect, it } from "vitest";
import type { Task } from "@stargantt/plugin-data-store";
import {
  BADGE_RADIUS,
  RAG_FALLBACKS,
  makeRagBadgeRenderer,
  makeRagStyleProvider,
  ragColor,
} from "../src/internal/progress/rag";

function withMeta(meta: unknown): Task {
  return { id: "t", parentId: null, name: "t", start: 0, end: 1, meta } as unknown as Task;
}

function recordingContext(): {
  g: CanvasRenderingContext2D;
  fills: string[];
  letters: string[];
  arcs: number[];
} {
  const fills: string[] = [];
  const letters: string[] = [];
  const arcs: number[] = [];
  const g = {
    set fillStyle(value: string) {
      fills.push(value);
    },
    font: "",
    textAlign: "",
    textBaseline: "",
    beginPath() {},
    arc(cx: number) {
      arcs.push(cx);
    },
    fill() {},
    fillText(text: string) {
      letters.push(text);
    },
  } as unknown as CanvasRenderingContext2D;
  return { g, fills, letters, arcs };
}

describe("makeRagStyleProvider (taskbars/style, §3.2, colorBars-gated)", () => {
  it("returns a color for classified tasks, declines for the rest", () => {
    const provider = makeRagStyleProvider({ ragOf: (t) => (t.id === "red-task" ? "red" : undefined), themeGet: undefined });
    expect(provider({ id: "red-task" } as unknown as Task)).toEqual({ color: RAG_FALLBACKS.red });
    expect(provider({ id: "other" } as unknown as Task)).toBeUndefined();
  });

  it("reads the theme token when available", () => {
    const provider = makeRagStyleProvider({
      ragOf: () => "green",
      themeGet: (token) => (token === "--sg-rag-green" ? "#00ff00" : ""),
    });
    expect(provider({} as unknown as Task)).toEqual({ color: "#00ff00" });
  });
});

describe("ragColor", () => {
  it("falls back to the documented default without a theme", () => {
    expect(ragColor("amber", undefined)).toBe(RAG_FALLBACKS.amber);
  });
});

describe("makeRagBadgeRenderer (taskbars/overlays)", () => {
  const task = withMeta({ progressTracking: { rag: "red" } });
  const bar = { id: "t", x: 100, y: 10, width: 40, height: 20, gutterStart: 0, gutterEnd: 0 };
  const deps = { ragOf: () => "red" as const, taskOf: () => task };

  it("paints the badge fill then the letter through --sg-rag-badge-fg", () => {
    const themeGet = (token: string): string =>
      token === "--sg-rag-red" ? "#c62828" : token === "--sg-rag-badge-fg" ? "#ffffff" : "unexpected";
    const { g, fills, letters } = recordingContext();
    makeRagBadgeRenderer({ ...deps, themeGet })(g, bar);
    expect(fills).toEqual(["#c62828", "#ffffff"]);
    expect(letters).toEqual(["R"]);
  });

  it("falls back to white when the theme plugin is absent", () => {
    const { g, fills } = recordingContext();
    makeRagBadgeRenderer({ ...deps, themeGet: undefined })(g, bar);
    expect(fills).toEqual([RAG_FALLBACKS.red, "#ffffff"]);
  });

  it("centers the badge at bar.x - 8 when the gutter is zero", () => {
    const { g, arcs } = recordingContext();
    makeRagBadgeRenderer({ ...deps, themeGet: undefined })(g, bar);
    expect(arcs).toEqual([bar.x - 8]);
  });

  it("clears a non-zero resolved start gutter: badge centers at bar.x - gutterStart - 8", () => {
    const gutteredBar = { ...bar, gutterStart: 17 };
    const { g, arcs } = recordingContext();
    makeRagBadgeRenderer({ ...deps, themeGet: undefined })(g, gutteredBar);
    expect(arcs).toEqual([gutteredBar.x - gutteredBar.gutterStart - 8]);
  });

  // The badge's own footprint (its right-edge arc, `arcs[0] + BADGE_RADIUS`) must stay strictly
  // outside the resolved start gutter, never just its center point — this is what actually proves
  // no overlap with whatever `taskbars/endGutter` reserves there, for both a zero and a non-zero
  // gutter.
  it("keeps the badge's whole footprint clear of the resolved start gutter", () => {
    for (const testBar of [bar, { ...bar, gutterStart: 17 }]) {
      const { g, arcs } = recordingContext();
      makeRagBadgeRenderer({ ...deps, themeGet: undefined })(g, testBar);
      expect((arcs[0] as number) + BADGE_RADIUS).toBeLessThan(testBar.x - testBar.gutterStart);
    }
  });

  it("skips unclassified tasks", () => {
    const { g, fills } = recordingContext();
    makeRagBadgeRenderer({ ragOf: () => undefined, taskOf: () => task, themeGet: undefined })(g, bar);
    expect(fills).toEqual([]);
  });

  it("skips bars under 12px tall", () => {
    const { g, fills } = recordingContext();
    makeRagBadgeRenderer({ ...deps, themeGet: undefined })(g, { ...bar, height: 11 });
    expect(fills).toEqual([]);
  });

  it("skips when the task cannot be resolved by id", () => {
    const { g, fills } = recordingContext();
    makeRagBadgeRenderer({ ragOf: () => "red", taskOf: () => undefined, themeGet: undefined })(g, bar);
    expect(fills).toEqual([]);
  });
});
