// @vitest-environment happy-dom
/**
 * The plugin scaffolding covers: the facade's registration, the wire-stub seams, the §7
 * config resolution, and the §8 merged 26-key catalog.
 *
 * The two implemented areas have their own suites (`test/capture/`, `test/print/`). What is left
 * over — to be replaced member by member as later areas land — is asserted here, so the seam is
 * pinned before anything is built on it.
 *
 * The happy-dom environment (added for the §11 subscription-count test below, which needs a real
 * `HTMLElement` — `guard.ts` reads `ctx.root.classList` unconditionally at dispose) does not affect
 * the tests above: `test/capture/_boot.ts` brings its own self-contained `FakeElement` doubles and
 * never touches the ambient `document` global either way.
 */
import { describe, expect, it } from "vitest";
import { definePlugin } from "@stargantt/core";
import type { AnyPlugin } from "@stargantt/core";
import { createTestHost } from "@stargantt/sdk";
import { dataStore } from "@stargantt/plugin-data-store";
import { resolveConfig } from "../src/config";
import { DEFAULT_MESSAGES, defaultIssueText, resolveMessages } from "../src/internal/messages";
import type { ExportMessages } from "../src/internal/messages";
import { exportPlugin } from "../src/index";
import type { AuxiliarySurfaceContribution, ExportService, ExportTile } from "../src/types";
import { boot } from "./capture/_boot";
import { idStub } from "./_boot";

/* ------------------------------------------------------------------ *
 * Registration (§1, §4, §10)
 * ------------------------------------------------------------------ */

describe("plugin registration", () => {
  it("provides `stargantt.export` with exactly the 17 facade members", () => {
    const booted = boot();
    try {
      // §1 — the member count is load-bearing: the spec's fold map resolves every member into
      // exactly these 17, so a member appearing or vanishing is a surface change, not a detail.
      const members: (keyof ExportService)[] = [
        "toPng",
        "toSvg",
        "toPdf",
        "pageCount",
        "printPreview",
        "exportCsv",
        "exportJson",
        "exportICal",
        "importCsv",
        "importJson",
        "toMsProjectXml",
        "applyMsProjectXml",
        "toXlsx",
        "snapshot",
        "applySnapshot",
        "isReadOnly",
        "setReadOnly",
      ];
      expect(Object.keys(booted.service).sort()).toEqual([...members].sort());
      for (const member of members) expect(typeof booted.service[member]).toBe("function");
    } finally {
      booted.dispose();
    }
  });

  it("paints nothing and touches nothing until a service member is called", () => {
    // §9 / §11 — with no service call and an all-default config a composition that includes this
    // plugin renders byte-identically to one without it. The embed area's one standing
    // `data/willApplyTransaction` subscription (§2.1, §11) is installed unconditionally at
    // `setup()` regardless — it is a background listener, not a paint or DOM effect, so it does
    // not disturb the byte-identical-rendering claim this test checks. See
    // `formats-pipeline.test.ts` / `embed-readonly.test.ts` for the subscription's own behavior,
    // and the §11 exactly-one-subscription regression test in this file below.
    const layers = [
      { layer: "background", width: 800, height: 600 },
      { layer: "main", width: 800, height: 600 },
    ] as const;
    const b = boot({ layers });
    try {
      expect(b.renders).toEqual([]);
      expect(b.invalidated).toEqual([]);
      expect(b.scrolls).toEqual([]);
      // The harness's root holds exactly one child — the chart pane, which in turn holds exactly
      // the layer canvases it was told to make. The plugin appends nothing of its own anywhere:
      // the print preview mounts only on demand, and disposes itself with the plugin.
      expect(b.root.children).toHaveLength(1);
      expect(b.root.children[0]?.children).toHaveLength(layers.length);
    } finally {
      b.dispose();
    }
  });

  it("defines `export/auxiliarySurfaces` and collects a contribution registered before it", () => {
    const tiles: ExportTile[] = [];
    const surface: AuxiliarySurfaceContribution = {
      side: "top",
      height: 24,
      drawTile: () => undefined,
      drawTileSVG: (tile) => {
        tiles.push(tile);
        return `<rect data-probe="1" width="${tile.width}" height="${tile.height}"/>`;
      },
    };
    // The contributor runs BEFORE the point's owner, which is the ordinary case for the official
    // contributors: view (Layer 2) sets up long before export (Layer 8). The core buffers the
    // contribution until `defineExtensionPoint` runs, so nothing is lost (§4).
    const probe = definePlugin({
      meta: { id: "test.aux-probe", dependsOn: [] },
      setup: (ctx) => ctx.contribute("export/auxiliarySurfaces", surface),
    });
    const b = boot({ extra: [probe] });
    return b.service
      .toSvg()
      .then((svg) => {
        expect(svg).toContain('data-probe="1"');
        // The band is stacked above the drawing layers and sized by its own height.
        expect(tiles.length).toBeGreaterThan(0);
        expect(tiles[0]?.height).toBe(24);
      })
      .finally(() => b.dispose());
  });
});

/* ------------------------------------------------------------------ *
 * §11 — the plugin's one standing footprint
 * ------------------------------------------------------------------ */

describe("§11 — exactly one data/willApplyTransaction subscription", () => {
  it("installs the shared guard's subscription exactly once, however many of the four areas ask for it", () => {
    const root = document.createElement("div");
    document.body.appendChild(root);
    const willApplyRegistrations: string[] = [];

    // A recording context: `ctx.on` is shadowed as an own property on this specific plugin
    // instance's `PluginContext` (never touching the class/prototype other plugins' contexts
    // share), so every `ctx.on("data/willApplyTransaction", ...)` call any of `wireFormats`'s /
    // `wireMsProject`'s / `wireExcel`'s / `wireEmbed`'s bodies make — directly or through
    // `guardFor`'s memoized install — is counted here.
    const real = exportPlugin();
    const spied: AnyPlugin = {
      meta: real.meta,
      setup(ctx, config) {
        const originalOn = ctx.on.bind(ctx);
        (ctx as { on: typeof ctx.on }).on = ((key: string, fn: never) => {
          if (key === "data/willApplyTransaction") willApplyRegistrations.push(key);
          return originalOn(key as never, fn);
        }) as typeof ctx.on;
        return real.setup(ctx, config);
      },
    };

    const services: Record<string, unknown> = {
      "stargantt.view": {
        viewport: { get: () => ({ scrollLeft: 0, scrollTop: 0, width: 800, height: 600 }) },
        chartPaneElement: () => root,
        renderTo: (): void => {},
      },
      "stargantt.timeline": {
        tToX: (t: number) => t,
        xToT: (x: number) => x,
        unitBoundaries: (): number[] => [],
      },
      "stargantt.theme": { colorScheme: () => "light" as const, setColorScheme: (): void => {} },
    };

    // The full plugin, all four areas composed together, over a real data-store (the
    // subscription's actual target) — not the capture-only harness above.
    const testHost = createTestHost({
      element: root,
      services,
      plugins: [dataStore(), idStub("stargantt.view"), spied],
    });
    try {
      expect(willApplyRegistrations).toHaveLength(1);
    } finally {
      testHost.dispose();
      root.remove();
    }
  });
});

/* ------------------------------------------------------------------ *
 * Config resolution (§7)
 * ------------------------------------------------------------------ */

describe("resolveConfig (§7)", () => {
  it("fills every nest's documented defaults from an omitted config", () => {
    const c = resolveConfig(undefined);
    expect(c.messages).toBeUndefined();
    expect(c.image).toEqual({});
    expect(c.print).toEqual({});
    expect(c.importExport).toEqual({ csvDelimiter: "," });
    expect(c.excel).toEqual({ sheetName: "Tasks" });
    expect(c.viewerEmbed).toEqual({
      readOnly: false,
      embed: false,
      snapshotParam: "sg-snapshot",
      autoRestore: false,
      readOnlyExemptOrigins: [],
    });
  });

  it("treats a non-object config, and a non-object nest, as absent", () => {
    for (const bad of [null, 7, "x", true]) {
      expect(resolveConfig(bad as never)).toEqual(resolveConfig(undefined));
    }
    expect(resolveConfig({ viewerEmbed: null as never }).viewerEmbed.snapshotParam).toBe(
      "sg-snapshot",
    );
  });

  it("takes `csvDelimiter` only as a single character", () => {
    expect(resolveConfig({ importExport: { csvDelimiter: ";" } }).importExport.csvDelimiter).toBe(
      ";",
    );
    expect(resolveConfig({ importExport: { csvDelimiter: "\t" } }).importExport.csvDelimiter).toBe(
      "\t",
    );
    for (const bad of ["", ";;", 5 as never, null as never]) {
      expect(resolveConfig({ importExport: { csvDelimiter: bad } }).importExport.csvDelimiter).toBe(
        ",",
      );
    }
  });

  it("takes a non-empty `sheetName` verbatim here — §1.8 sanitization belongs to `toXlsx`", () => {
    // The nest value is what an unusable one falls back to; the Excel-rule sanitization runs at the
    // call, because `XlsxExportOptions.sheetName` can override this per call.
    expect(resolveConfig({ excel: { sheetName: "Plan/2026" } }).excel.sheetName).toBe("Plan/2026");
    expect(resolveConfig({ excel: { sheetName: "" } }).excel.sheetName).toBe("Tasks");
    expect(resolveConfig({ excel: { sheetName: 9 as never } }).excel.sheetName).toBe("Tasks");
  });

  describe("viewerEmbed (§2.1, §2.3)", () => {
    it("lets `embed` flip the read-only DEFAULT only", () => {
      expect(resolveConfig({ viewerEmbed: { embed: true } }).viewerEmbed.readOnly).toBe(true);
      // An explicit `readOnly: false` keeps an editable embed — embed never forces read-only.
      expect(
        resolveConfig({ viewerEmbed: { embed: true, readOnly: false } }).viewerEmbed.readOnly,
      ).toBe(false);
      expect(
        resolveConfig({ viewerEmbed: { embed: false, readOnly: true } }).viewerEmbed.readOnly,
      ).toBe(true);
    });

    it("ignores a non-boolean `readOnly` / `embed` / `autoRestore`", () => {
      const c = resolveConfig({
        viewerEmbed: { readOnly: "yes" as never, embed: 1 as never, autoRestore: null as never },
      });
      expect(c.viewerEmbed.readOnly).toBe(false);
      expect(c.viewerEmbed.embed).toBe(false);
      expect(c.viewerEmbed.autoRestore).toBe(false);
    });

    it("drops non-string exempt origins per element and ignores a non-array wholesale", () => {
      expect(
        resolveConfig({
          viewerEmbed: { readOnlyExemptOrigins: ["mine", 5 as never, null as never, "yours"] },
        }).viewerEmbed.readOnlyExemptOrigins,
      ).toEqual(["mine", "yours"]);
      expect(
        resolveConfig({ viewerEmbed: { readOnlyExemptOrigins: "mine" as never } }).viewerEmbed
          .readOnlyExemptOrigins,
      ).toEqual([]);
    });
  });

  it("carries the `image` and `print` nests through unvalidated", () => {
    // Both are per-call overridable per key, so validation belongs to the merge that consumes them
    // (`resolveImageOptions` / `resolveOptions`). Validating here as well could only diverge.
    const image = { pixelRatio: Number.NaN, range: "nonsense" as never };
    const print = { scale: 10_000, paper: "a7" as never };
    expect(resolveConfig({ image, print }).image).toBe(image);
    expect(resolveConfig({ image, print }).print).toBe(print);
  });
});

/* ------------------------------------------------------------------ *
 * The merged catalog (§8)
 * ------------------------------------------------------------------ */

describe("ExportMessages (§8)", () => {
  it("merges the two catalogs into 26 keys with no collision", () => {
    const keys = Object.keys(DEFAULT_MESSAGES);
    expect(keys).toHaveLength(26);
    expect(new Set(keys).size).toBe(26);
    // 13 print/export keys + 13 import/export keys.
    const print = keys.filter((k) =>
      /^(pageNumber|legend|previewTitle|printButton|closeButton|column)/.test(k),
    );
    expect(print).toHaveLength(13);
  });

  it("keeps the English defaults verbatim", () => {
    expect(DEFAULT_MESSAGES.legendTitle).toBe("Legend");
    expect(DEFAULT_MESSAGES.legendCritical).toBe("Critical path");
    expect(DEFAULT_MESSAGES.previewTitle).toBe("Print preview");
    expect(DEFAULT_MESSAGES.dialogTitle).toBe("Import data");
    expect(DEFAULT_MESSAGES.noChanges).toBe("No changes to import");
    expect(DEFAULT_MESSAGES.pageNumber({ page: 3, pages: 7, date: 0 })).toBe("Page 3 of 7");
    expect(DEFAULT_MESSAGES.fieldLabel("parentId")).toBe("parentId");
  });

  it("shares one plural rule between the two count builders", () => {
    expect(DEFAULT_MESSAGES.issuesHeading(1)).toBe("1 issue");
    expect(DEFAULT_MESSAGES.issuesHeading(3)).toBe("3 issues");
    expect(DEFAULT_MESSAGES.issuesHeading(0)).toBe("0 issues");
    expect(DEFAULT_MESSAGES.applyButton(1)).toBe("Import 1 change");
    expect(DEFAULT_MESSAGES.applyButton(3)).toBe("Import 3 changes");
  });

  it("writes one English sentence per issue code", () => {
    expect(defaultIssueText({ code: "invalid-json", reason: "eof" })).toBe(
      "The JSON could not be read: eof",
    );
    expect(defaultIssueText({ code: "duplicate-id", taskId: "a", row: 4 })).toBe(
      'Duplicate task id "a" (row 4)',
    );
    expect(defaultIssueText({ code: "duplicate-id", taskId: "a" })).toBe('Duplicate task id "a"');
    expect(defaultIssueText({ code: "dependency-cycle", taskIds: ["a", "b"] })).toBe(
      "Dependency cycle: a → b",
    );
  });

  it("overrides per key and ignores a member of the wrong type", () => {
    const faults: string[] = [];
    const m = resolveMessages(
      {
        legendTitle: "Legende",
        closeButton: 42 as never,
        applyButton: (n) => `${n}!`,
      },
      (key) => faults.push(key),
    );
    expect(m.legendTitle).toBe("Legende");
    expect(m.closeButton).toBe("Close");
    expect(m.applyButton(2)).toBe("2!");
    expect(faults).toEqual([]);
  });

  it("latches a throwing builder back to its default after reporting it once", () => {
    const faults: (keyof ExportMessages & string)[] = [];
    const m = resolveMessages(
      {
        pageNumber: () => {
          throw new Error("boom");
        },
      },
      (key) => faults.push(key),
    );
    const info = { page: 1, pages: 2, date: 0 };
    expect(m.pageNumber(info)).toBe("Page 1 of 2");
    expect(m.pageNumber(info)).toBe("Page 1 of 2");
    // Reported once; the default answers that call and every later one for the catalog's lifetime.
    expect(faults).toEqual(["pageNumber"]);
  });
});
