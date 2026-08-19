/**
 * `TimelineConfig.zoomLevels` — replacing the built-in levels.
 *
 *
 * `timeline/zoomLevels` stays a purely additive collect point; the option changes only what *this*
 * plugin contributes to it. With the option absent the six built-in levels are contributed, with
 * `"day"` and `"week"` first so the active startup level — and the painted header — is unchanged.
 */
import { afterEach, describe, expect, it } from "vitest";
import type { ZoomLevel } from "../../src/internal/timeline/index";
import type { TimelineConfig } from "../../src/config";
import { MS_DAY } from "../../src/internal/timeline/scale";
import { boot, probe, watchZoom } from "./_boot";
import type { Booted } from "./_boot";

// contribution order.
const BUILT_INS = ["day", "week", "hour", "month", "quarter", "year"];

let booted: Booted | null = null;

afterEach(() => {
  booted?.dom.restore();
  booted = null;
});

function scale(b: Booted) {
  return b.gantt.service("stargantt.timeline");
}

/** A level whose rows format an instant as its raw epoch-ms value. */
function level(id: string, pxPerDay: number): ZoomLevel {
  return { id, pxPerDay, scales: [{ unit: "day", format: (t) => `${id}:${t}` }] };
}

/**
 * Boots with `config` and returns the composed `timeline/zoomLevels` list.
 *
 * The list is captured by re-defining the point with a pass-through reducer, which is the only
 * public way to observe every contribution at once; the `zoomLevel` store alone shows just the
 * active one.
 */
function composed(config: TimelineConfig, extra: ReturnType<typeof probe>[] = []): {
  b: Booted;
  levels: ZoomLevel[];
} {
  const captured: ZoomLevel[] = [];
  const b = boot(
    [
      ...extra,
      probe((ctx) => {
        ctx.defineExtensionPoint("timeline/zoomLevels", (inputs: ZoomLevel[]) => {
          captured.length = 0;
          captured.push(...inputs);
          return inputs;
        });
      }, "test.capture"),
    ],
    {},
    config,
  );
  booted = b;
  // Force one read of the point so the capturing reducer runs. `levelMetrics()` re-reads it on
  // every call, where the `zoomLevel` store only replays the snapshot taken at setup.
  scale(b).levelMetrics();
  return { b, levels: captured };
}

describe("absent — the built-ins are unchanged", () => {
  it("contributes the six built-ins, `day` and `week` first", () => {
    const { levels } = composed({ origin: 0 });
    expect(levels.map((l) => l.id)).toEqual(BUILT_INS);
    expect(levels[0]?.pxPerDay).toBe(40);
    expect(levels[1]?.pxPerDay).toBe(12);
  });

  it("keeps `day` a month row over a day row", () => {
    const { levels } = composed({ origin: 0 });
    expect(levels[0]?.scales.map((s) => s.unit)).toEqual(["month", "day"]);
    expect(levels[1]?.scales.map((s) => s.unit)).toEqual(["month", "week"]);
  });
});

describe("present and non-empty — replacement", () => {
  it("contributes the array's entries instead, in array order", () => {
    const { b, levels } = composed({ origin: 0, zoomLevels: [level("a", 10), level("b", 20)] });
    expect(levels.map((l) => l.id)).toEqual(["a", "b"]);
    expect(scale(b).zoomLevel.get().id).toBe("a");
    expect(scale(b).pxPerMs).toBe(10 / MS_DAY);
  });

  it("does not construct the built-ins at all", () => {
    const { b, levels } = composed({ origin: 0, zoomLevels: [level("a", 10)] });
    expect(levels.map((l) => l.id)).toEqual(["a"]);
    expect(() => scale(b).setZoomLevel("day")).toThrow(/unknown zoom level/);
  });

  it("leaves another plugin's levels alone, and lands before them", () => {
    const theirs = level("theirs", 99);
    const { levels } = composed({ origin: 0, zoomLevels: [level("mine", 10)] }, [
      probe((ctx) => {
        ctx.contribute("timeline/zoomLevels", theirs);
      }, "test.theirs"),
    ]);
    expect(levels.map((l) => l.id)).toEqual(["mine", "theirs"]);
  });
});

// §1.4 — unlike tree-grid's `columns`, an empty replacement here is *unusable*: a chart with no
// zoom level has no `pxPerDay`, so an empty list restores the built-ins.
describe("unusable values fall back to the built-ins", () => {
  it("restores the built-ins for the empty array", () => {
    const { levels } = composed({ origin: 0, zoomLevels: [] });
    expect(levels.map((l) => l.id)).toEqual(BUILT_INS);
  });

  it("ignores a `zoomLevels` that is not an array", () => {
    const config = { origin: 0, zoomLevels: "nope" } as unknown as TimelineConfig;
    expect(composed(config).levels.map((l) => l.id)).toEqual(BUILT_INS);
  });

  it("skips an unusable entry and contributes the rest", () => {
    const bad = [
      null,
      { id: "", pxPerDay: 10, scales: [{ unit: "day", format: () => "" }] },
      { id: "nan", pxPerDay: Number.NaN, scales: [{ unit: "day", format: () => "" }] },
      { id: "zero", pxPerDay: 0, scales: [{ unit: "day", format: () => "" }] },
      { id: "noScales", pxPerDay: 10, scales: [] },
      { id: "notArray", pxPerDay: 10, scales: "nope" },
      level("ok", 10),
    ] as unknown as ZoomLevel[];
    expect(composed({ origin: 0, zoomLevels: bad }).levels.map((l) => l.id)).toEqual(["ok"]);
  });

  it("restores the built-ins when every entry is skipped", () => {
    const bad = [null, 7] as unknown as ZoomLevel[];
    expect(composed({ origin: 0, zoomLevels: bad }).levels.map((l) => l.id)).toEqual(BUILT_INS);
  });

  it("leaves another plugin's level as the whole list when its own array is fully skipped", () => {
    // The rule is "the built-ins come back", so the composed list is built-ins plus theirs — the
    // plugin never ends up with no level of its own.
    const { levels } = composed({ origin: 0, zoomLevels: [] }, [
      probe((ctx) => {
        ctx.contribute("timeline/zoomLevels", level("theirs", 99));
      }, "test.theirs"),
    ]);
    expect(levels.map((l) => l.id)).toEqual([...BUILT_INS, "theirs"]);
  });
});

describe("interaction with initialZoom", () => {
  it("starts at the first configured entry when initialZoom is omitted", () => {
    const { b } = composed({ origin: 0, zoomLevels: [level("a", 10), level("b", 20)] });
    expect(scale(b).zoomLevel.get().id).toBe("a");
  });

  it("selects a configured level by id", () => {
    const { b } = composed({
      origin: 0,
      initialZoom: "b",
      zoomLevels: [level("a", 10), level("b", 20)],
    });
    expect(scale(b).zoomLevel.get().id).toBe("b");
    expect(scale(b).tToX(MS_DAY)).toBe(20);
  });

  // §1.2 / §1.4 — resolution happens against the *composed* list, not the configured array.
  //
  // The store's seed deliberately does not resolve `initialZoom`: a third-party contributor
  // necessarily runs after `stargantt.view` (the point is the merged plugin's), so a resolution
  // made during `setup()` could never see the level named here. The seed peeks at the partial
  // ladder and `lifecycle/ready` performs the real resolution against the composed one.
  it("selects a level another plugin contributed, alongside the configured ones", () => {
    const { b } = composed({ origin: 0, initialZoom: "theirs", zoomLevels: [level("a", 10)] }, [
      probe((ctx) => {
        ctx.contribute("timeline/zoomLevels", level("theirs", 99));
      }, "test.theirs"),
    ]);
    expect(scale(b).zoomLevel.get().id).toBe("theirs");
  });

  it("falls back silently to the first composed entry for an unmatched id", () => {
    const errors: unknown[] = [];
    const { b } = composed({ origin: 0, initialZoom: "no-such", zoomLevels: [level("a", 10)] }, [
      probe((ctx) => {
        ctx.on("core/pluginError", (e) => void errors.push(e));
      }, "test.errors"),
    ]);
    expect(scale(b).zoomLevel.get().id).toBe("a");
    expect(errors).toEqual([]);
  });

  it("lets setZoomLevel move freely across the composed list afterwards", () => {
    const { b } = composed({ origin: 0, zoomLevels: [level("a", 10), level("b", 20)] });
    scale(b).setZoomLevel("b");
    expect(scale(b).zoomLevel.get().id).toBe("b");
  });
});

describe("resolved once at setup", () => {
  it("ignores a mutation of the array made after startup", () => {
    const zoomLevels = [level("a", 10)];
    const captured: ZoomLevel[] = [];
    const b = boot(
      [
        probe((ctx) => {
          ctx.defineExtensionPoint("timeline/zoomLevels", (inputs: ZoomLevel[]) => {
            captured.length = 0;
            captured.push(...inputs);
            return inputs;
          });
        }, "test.capture"),
      ],
      {},
      { origin: 0, zoomLevels },
    );
    booted = b;
    zoomLevels.push(level("b", 20));

    scale(b).levelMetrics();
    expect(captured.map((l) => l.id)).toEqual(["a"]);
    expect(() => scale(b).setZoomLevel("b")).toThrow(/unknown zoom level/);
  });
});

describe("a configured level's format is foreign code", () => {
  it("reports a throwing `ScaleRow.format` with this plugin's id and keeps painting", () => {
    const b = boot([], {}, {
      origin: 0,
      zoomLevels: [
        {
          id: "boom",
          pxPerDay: 40,
          scales: [
            { unit: "day", format: () => "ok" },
            {
              unit: "month",
              format: () => {
                throw new Error("format exploded");
              },
            },
          ],
        },
      ],
    });
    booted = b;
    const faults: { pluginId: string; error: unknown }[] = [];
    b.gantt.on("core/pluginError", (e) => void faults.push(e));
    b.dom.flushFrames();

    expect(faults.length).toBeGreaterThan(0);
    expect(faults[0]?.pluginId).toBe("stargantt.view");
    expect(b.header.context.texts.map((t) => t.text)).toContain("ok");
  });
});

// the composed ladder, published read-only so a
// consumer never activates a level in order to measure it.
describe("levelMetrics — the composed ladder read-only", () => {
  it("reports the built-ins' ids and densities in composed order", () => {
    const { b } = composed({ origin: 0 });
    const metrics = scale(b).levelMetrics();
    expect(metrics.map((m) => m.id)).toEqual(BUILT_INS);
    expect(metrics[0]).toEqual({ id: "day", pxPerDay: 40 });
    expect(metrics[1]).toEqual({ id: "week", pxPerDay: 12 });
  });

  it("includes levels other plugins contributed, after this plugin's own", () => {
    const { b } = composed({ origin: 0, zoomLevels: [level("mine", 10)] }, [
      probe((ctx) => {
        ctx.contribute("timeline/zoomLevels", level("theirs", 99));
      }, "test.theirs"),
    ]);
    expect(scale(b).levelMetrics()).toEqual([
      { id: "mine", pxPerDay: 10 },
      { id: "theirs", pxPerDay: 99 },
    ]);
  });

  it("neither changes the active level nor notifies the `zoomLevel` store", () => {
    const { b } = composed({ origin: 0, zoomLevels: [level("a", 10), level("b", 20)] });
    const changes = watchZoom(b);
    scale(b).levelMetrics();
    scale(b).levelMetrics();
    expect(scale(b).zoomLevel.get().id).toBe("a");
    expect(changes).toEqual([]);
  });

  it("hands out a fresh snapshot a caller cannot use to reach the levels", () => {
    const { b } = composed({ origin: 0, zoomLevels: [level("a", 10)] });
    const first = scale(b).levelMetrics();
    (first as { id: string; pxPerDay: number }[])[0]!.pxPerDay = 999;
    (first as { id: string; pxPerDay: number }[]).push({ id: "injected", pxPerDay: 1 });
    expect(scale(b).levelMetrics()).toEqual([{ id: "a", pxPerDay: 10 }]);
    expect(scale(b).zoomLevel.get().pxPerDay).toBe(10);
  });
});
