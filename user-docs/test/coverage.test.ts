import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildSnapshot, serialize } from "../tools/extract-api";
import {
  buildIndex,
  buildManifest,
  serialize as serializeIndex,
  serializeManifest,
} from "../tools/build-content-index";
import { prepare, search } from "../src/lib/search";
import { segmentsOf, withoutMarks } from "../src/lib/inline";
import INDEX from "../src/generated/search-index.json";
import { expectedRoutes, routes } from "../src/content/registry";
// The eager import of every content module lives in the test tree, never in `src/` — see the note
// in `_all-content.ts`.
import { CORE_DOCS, GUIDE_DOCS, PLUGIN_DOCS } from "./_all-content";
import type { PluginDoc, PropertyDoc } from "../src/content/types";
import { API, PLUGINS, pluginById } from "../src/generated/api";

const HERE = dirname(fileURLToPath(import.meta.url));
const DOCS_ROOT = join(HERE, "..");
const documentedIds = new Set(PLUGIN_DOCS.map((doc) => doc.id));

/* ------------------------------------------------------------------ *
 * The snapshot must describe the library as it is now.
 * ------------------------------------------------------------------ */

describe("api.json", () => {
  it("matches what the extractor produces from the current sources", () => {
    const onDisk = readFileSync(join(DOCS_ROOT, "src/generated/api.json"), "utf8");
    const fresh = serialize(buildSnapshot());
    expect(
      onDisk === fresh
        ? "up to date"
        : "stale — run `node tools/extract-api.ts` and review the diff before committing",
    ).toBe("up to date");
  });

  it("found every plugin package", () => {
    // The library ships 15 official plugins — see docs/specs/architecture.md ch.3-4.
    expect(API.plugins.length).toBe(15);
    expect(API.plugins.filter((p) => p.factory === null)).toEqual([]);
  });

  it("gives every plugin a contract file to trace back to", () => {
    expect(API.plugins.filter((p) => p.contract === null).map((p) => p.id)).toEqual([]);
  });
});

/* ------------------------------------------------------------------ *
 * Coverage: every plugin is either documented or listed as debt.
 * ------------------------------------------------------------------ */

describe("plugin coverage", () => {
  // `docs-debt.json` and the tests that read it were deleted when the list reached zero, which is
  // what D-04 says to do with an empty debt list. What replaces them is stricter and simpler: a
  // plugin that exists must have a page, with no allowance and nothing to add yourself to.
  it("has a page for every plugin in the API snapshot", () => {
    const undocumented = PLUGINS.filter((p) => !documentedIds.has(p.id)).map((p) => p.id);
    expect(undocumented, "add a module under src/content/plugins/<category>/").toEqual([]);
  });

  it("documents no plugin that does not exist", () => {
    const ghosts = PLUGIN_DOCS.filter((doc) => !pluginById(doc.id)).map((doc) => doc.id);
    expect(ghosts).toEqual([]);
  });
});

/* ------------------------------------------------------------------ *
 * Per-plugin completeness.
 * ------------------------------------------------------------------ */

describe.each(PLUGIN_DOCS.map((doc) => [doc.id, doc] as const))("%s", (_id, doc: PluginDoc) => {
  const api = pluginById(doc.id)!;

  it("covers every option in the API snapshot, and invents none", () => {
    const documented = doc.properties.map((p) => p.name).sort();
    const actual = api.config.map((c) => c.name).sort();
    expect(documented).toEqual(actual);
  });

  it("names each option once", () => {
    const names = doc.properties.map((p) => p.name);
    expect(names.length).toBe(new Set(names).size);
  });

  it("has a summary, an overview and a reason to exist", () => {
    expect(doc.summary.trim().length).toBeGreaterThan(20);
    expect(doc.overview.length).toBeGreaterThanOrEqual(2);
    expect(doc.whenYouNeedIt.trim().length).toBeGreaterThan(20);
  });

  /**
   * The overview chart used to be the plugin at its defaults, and for about half the corpus that
   * was a chart with nothing of the plugin in it — a rule engine with no rules, an opt-in plugin
   * the spec never loaded. A reader could not tell the page apart from one about a plugin they do
   * not have (D-23).
   */
  it("shows the plugin doing something on the overview, or says why it cannot", () => {
    const overview = doc.overviewDemo;
    if (overview.kind === "none") {
      expect(
        overview.reason.trim().length,
        "a plugin with no chart needs a reason a reviewer can weigh",
      ).toBeGreaterThan(40);
      return;
    }
    expect(
      overview.caption.trim().length,
      "the caption names what to look at, which is the whole point of showing the chart",
    ).toBeGreaterThan(20);
    const { preset, plugins } = overview.spec;
    expect(
      Object.keys(preset ?? {}).length > 0 || plugins !== undefined,
      "an unconfigured overview chart shows the reader the same picture as the previous page",
    ).toBe(true);
    if (!api.inPresetStandard) {
      expect(
        plugins,
        "an opt-in plugin absent from its own overview chart is documenting the preset",
      ).toBeDefined();
    }
  });

  it("annotates only API members that exist", () => {
    const check = (kind: keyof NonNullable<PluginDoc["notes"]>, keys: readonly string[]): void => {
      const notes = Object.keys(doc.notes?.[kind] ?? {}).filter((key) => key !== "__empty");
      expect(notes.filter((key) => !keys.includes(key)), `${kind} notes for missing keys`).toEqual([]);
    };
    check("services", api.services.map((m) => m.key));
    check("events", api.events.map((m) => m.key));
    check("commands", api.commands.map((m) => m.key));
    check("extensionPoints", api.extensionPoints.map((m) => m.key));
  });

  it("explains every empty API surface rather than leaving a blank tab", () => {
    const empties: Array<[keyof NonNullable<PluginDoc["notes"]>, number]> = [
      ["services", api.services.length],
      ["events", api.events.length],
      ["commands", api.commands.length],
      ["extensionPoints", api.extensionPoints.length],
    ];
    for (const [kind, count] of empties) {
      if (count > 0) continue;
      const reason = doc.notes?.[kind]?.["__empty"];
      expect(reason?.trim().length ?? 0, `${kind} is empty and unexplained`).toBeGreaterThan(30);
    }
  });

  describe.each(doc.properties.map((p) => [p.name, p] as const))("%s", (_name, property: PropertyDoc) => {
    it("explains itself in prose, not in a restatement of the signature", () => {
      expect(property.prose.length).toBeGreaterThanOrEqual(2);
      for (const para of property.prose) expect(para.trim().length).toBeGreaterThan(40);
    });

    it("either demonstrates itself or says why it cannot", () => {
      if (property.demo.kind === "none") {
        expect(
          property.demo.reason.trim().length,
          "an exclusion needs a reason a reviewer can weigh",
        ).toBeGreaterThan(40);
        return;
      }
      const { values } = property.demo;
      expect(values.length, "a value picker with one entry demonstrates nothing").toBeGreaterThanOrEqual(2);
      const labels = values.map((v) => v.label);
      expect(labels.length).toBe(new Set(labels).size);
    });

    it("starts from the plugin's own default", () => {
      if (property.demo.kind !== "values") return;
      const first = property.demo.values[0]!;
      const configures =
        Object.keys(first.demo.preset ?? {}).length > 0 || first.demo.plugins !== undefined;
      expect(
        configures,
        "the first value must configure nothing, so an untouched page shows an unconfigured chart",
      ).toBe(false);
    });
  });
});

/* ------------------------------------------------------------------ *
 * Guides and core chapters.
 * ------------------------------------------------------------------ */

describe("guides", () => {
  it.each(GUIDE_DOCS.map((doc) => [doc.slug, doc] as const))("%s is runnable", (_slug, doc) => {
    expect(doc.title.trim()).not.toBe("");
    expect(doc.lede.trim().length).toBeGreaterThan(40);
    const runnable = doc.cells.filter((cell) => cell.kind === "runnable");
    expect(runnable.length, "a guide with no runnable cell is an article, not a guide").toBeGreaterThanOrEqual(1);
    const prose = doc.cells.filter((cell) => cell.kind === "prose");
    expect(prose.length).toBeGreaterThanOrEqual(1);
  });

  it("has unique slugs", () => {
    const slugs = GUIDE_DOCS.map((doc) => doc.slug);
    expect(slugs.length).toBe(new Set(slugs).size);
  });
});

describe("core chapters", () => {
  it.each(CORE_DOCS.map((doc) => [doc.slug, doc] as const))("%s is written", (_slug, doc) => {
    expect(doc.title.trim()).not.toBe("");
    expect(doc.lede.trim().length).toBeGreaterThan(40);
    expect(doc.cells.length).toBeGreaterThanOrEqual(2);
    expect(doc.cells.some((cell) => cell.kind === "code" || cell.kind === "demo")).toBe(true);
  });

  it("has unique slugs", () => {
    const slugs = CORE_DOCS.map((doc) => doc.slug);
    expect(slugs.length).toBe(new Set(slugs).size);
  });
});

/* ------------------------------------------------------------------ *
 * Inline code spans.
 * ------------------------------------------------------------------ */

describe("inline code spans", () => {
  it("splits a paragraph into text and code", () => {
    expect(segmentsOf("set `rowHeight` to 32")).toEqual([
      { text: "set ", code: false },
      { text: "rowHeight", code: true },
      { text: " to 32", code: false },
    ]);
  });

  it("leaves an unpaired mark alone rather than swallowing the rest", () => {
    expect(segmentsOf("a ` b")).toEqual([{ text: "a ` b", code: false }]);
  });

  it("does not let a span cross a line", () => {
    expect(segmentsOf("a `b\nc` d").every((segment) => !segment.code)).toBe(true);
  });

  it("strips the marks for the search index", () => {
    expect(withoutMarks("call `load()` first")).toBe("call load() first");
  });

  /**
   * A mark is prose markup, so it belongs in prose and nowhere else. This is here because a sweep
   * that added marks across the corpus put one inside a guide's `slug`, which turned a link into a
   * 404 — and the only reason that surfaced was another guide happening to link to it.
   */
  it("keeps marks out of slugs, titles and routes", () => {
    for (const doc of [...GUIDE_DOCS, ...CORE_DOCS]) {
      expect(doc.slug, `${doc.slug} slug`).not.toContain("`");
      expect(doc.title, `${doc.slug} title`).not.toContain("`");
    }
    for (const doc of GUIDE_DOCS) {
      for (const route of doc.next) expect(route, `${doc.slug} next`).not.toContain("`");
    }
    for (const doc of PLUGIN_DOCS) expect(doc.id, `${doc.id} id`).not.toContain("`");
  });

  it("leaves no unpaired mark in any authored string", () => {
    const unpaired: string[] = [];
    const check = (where: string, text: string): void => {
      if ((text.match(/`/g) ?? []).length % 2 !== 0) unpaired.push(`${where}: ${text.slice(0, 60)}`);
    };
    for (const doc of GUIDE_DOCS) {
      check(doc.slug, doc.lede);
      for (const cell of doc.cells) {
        if (cell.kind === "prose") cell.paragraphs.forEach((para) => check(doc.slug, para));
        if (cell.kind === "callout") check(doc.slug, cell.body);
        if (cell.kind !== "prose" && cell.kind !== "callout" && cell.caption) check(doc.slug, cell.caption);
      }
    }
    for (const doc of PLUGIN_DOCS) {
      check(doc.id, doc.summary);
      check(doc.id, doc.whenYouNeedIt);
      doc.overview.forEach((para) => check(doc.id, para));
      for (const property of doc.properties) property.prose.forEach((para) => check(doc.id, para));
    }
    expect(unpaired).toEqual([]);
  });

  /**
   * The mark is the *only* markup (D-19), and the failure mode of that rule is not a reader
   * missing an emphasis — it is `**milliseconds**` reaching the page with its asterisks on,
   * because an author reached for the syntax every other document they write supports. Ten of
   * these had accumulated across nine pages before anyone looked at a rendered paragraph closely
   * enough to notice. Emphasis that matters is carried by the sentence instead.
   */
  it("carries no markdown the renderer does not implement", () => {
    const leaked: string[] = [];
    const check = (where: string, text: string): void => {
      const found = [
        ...(text.match(/\*\*[^*]+\*\*/g) ?? []),
        ...(text.match(/\[[^\]]+\]\([^)]+\)/g) ?? []),
      ];
      if (found.length > 0) leaked.push(`${where}: ${found.join(" ")}`);
    };
    for (const doc of [...GUIDE_DOCS, ...CORE_DOCS]) {
      check(doc.slug, doc.lede);
      for (const cell of doc.cells) {
        if (cell.kind === "prose") cell.paragraphs.forEach((para) => check(doc.slug, para));
        if (cell.kind === "callout") check(doc.slug, cell.body);
        if (cell.kind !== "prose" && cell.kind !== "callout" && cell.caption) check(doc.slug, cell.caption);
      }
    }
    for (const doc of PLUGIN_DOCS) {
      check(doc.id, doc.summary);
      check(doc.id, doc.whenYouNeedIt);
      doc.overview.forEach((para) => check(doc.id, para));
      if (doc.overviewDemo.kind === "configured") check(doc.id, doc.overviewDemo.caption);
      for (const property of doc.properties) property.prose.forEach((para) => check(doc.id, para));
      for (const recipe of doc.recipes) check(doc.id, recipe.intent);
      for (const kind of ["services", "events", "commands", "extensionPoints"] as const) {
        for (const [key, note] of Object.entries(doc.notes?.[kind] ?? {})) check(`${doc.id} ${key}`, note);
      }
    }
    expect(leaked, "the only markup a page has is `code`; write the emphasis into the sentence").toEqual([]);
  });
});

/* ------------------------------------------------------------------ *
 * Recipe and code-cell samples.
 *
 * `recipe.code` and a guide/core `kind: "code"` cell's `source` are neither executed by the E2E
 * suite (they are static listings, not `DemoSpec` expressions a runnable cell can mount) nor
 * type-checked (they are template-literal strings, invisible to `tsc`). A wrong call signature in
 * one is therefore silent everywhere except a reviewer's own eyes — which is exactly how a stale
 * two-argument `downloadFile(blob, name)` call survived into a sample here once already.
 * This is a narrow, regex-based lint for exactly the known-arity calls most likely to drift: it
 * cannot replace type-checking these strings for real, but it costs nothing and catches the
 * specific mistake that already happened once.
 * ------------------------------------------------------------------ */

describe("recipe and code-cell samples", () => {
  /** Every source string an author can write a call into: recipes, and "code" cells. */
  function allSamples(): Array<{ where: string; source: string }> {
    const out: Array<{ where: string; source: string }> = [];
    for (const doc of PLUGIN_DOCS) {
      for (const recipe of doc.recipes) out.push({ where: `${doc.id} recipe "${recipe.title}"`, source: recipe.code });
    }
    for (const doc of [...GUIDE_DOCS, ...CORE_DOCS]) {
      for (const cell of doc.cells) {
        if (cell.kind === "code") out.push({ where: `${doc.slug} code cell`, source: cell.source });
      }
    }
    return out;
  }

  it("calls sdk/dom's downloadFile with its real 3-or-4-argument form, first argument `document`", () => {
    // Real signature (packages/sdk/src/dom/download.ts):
    //   downloadFile(doc: Document, data: Blob | ArrayBuffer | string, filename: string, mimeType?: string): void
    // The eight retired single-purpose `downloadX` members took no `Document` argument at all,
    // which is the exact shape a stale sample reverts to if nothing catches it.
    const wrong: string[] = [];
    for (const { where, source } of allSamples()) {
      for (const [, args] of source.matchAll(/\bdownloadFile\(([^)]*)\)/g)) {
        const first = (args ?? "").split(",")[0]?.trim();
        if (first !== "document") wrong.push(`${where}: downloadFile(${args}) — first argument must be "document"`);
      }
    }
    expect(wrong).toEqual([]);
  });
});

/* ------------------------------------------------------------------ *
 * Links.
 * ------------------------------------------------------------------ */

describe("links", () => {
  const reachable = new Set(expectedRoutes());

  it("points every guide's next-steps at a route the site serves", () => {
    for (const doc of GUIDE_DOCS) {
      for (const route of doc.next) {
        expect(reachable.has(route), `${doc.slug} links to ${route}`).toBe(true);
      }
    }
  });

  it("generates a route for every plugin, documented or not", () => {
    for (const plugin of PLUGINS) {
      expect(reachable.has(routes.plugin(plugin.id))).toBe(true);
      expect(reachable.has(routes.pluginConfig(plugin.id))).toBe(true);
    }
  });
});

/* ------------------------------------------------------------------ *
 * Search.
 * ------------------------------------------------------------------ */

describe("search-index.json", () => {
  it("matches what the builder produces from the current content", async () => {
    const onDisk = readFileSync(join(DOCS_ROOT, "src/generated/search-index.json"), "utf8");
    const fresh = serializeIndex(await buildIndex());
    expect(
      onDisk === fresh
        ? "up to date"
        : "stale — run `node tools/build-content-index.ts` and review the diff before committing",
    ).toBe("up to date");
  });

  it("sends every hit to a route the site serves", () => {
    const reachable = new Set(expectedRoutes());
    const unreachable = INDEX.entries
      .filter((entry) => !reachable.has(entry.path.split("?")[0] ?? ""))
      .map((entry) => `${entry.title} → ${entry.path}`);
    expect(unreachable).toEqual([]);
  });

  it("can find every plugin by its short name", () => {
    const prepared = prepare(INDEX.entries);
    for (const plugin of PLUGINS) {
      const name = plugin.id.replace(/^stargantt\./, "");
      const hits = search(prepared, name);
      expect(hits[0]?.entry.path, `searching "${name}"`).toBe(`/reference/${name}`);
    }
  });

  it("can find every option by name, on the page that documents it", () => {
    const prepared = prepare(INDEX.entries);
    for (const plugin of PLUGINS) {
      const name = plugin.id.replace(/^stargantt\./, "");
      for (const option of plugin.config) {
        const hits = search(prepared, `${name} ${option.name}`);
        const wanted = `/reference/${name}/config?p=${option.name}`;
        expect(
          hits.some((hit) => hit.entry.path === wanted),
          `searching "${name} ${option.name}"`,
        ).toBe(true);
      }
    }
  });

  it("indexes every guide and every core chapter", () => {
    const paths = new Set(INDEX.entries.map((entry) => entry.path));
    for (const doc of GUIDE_DOCS) expect(paths.has(routes.guide(doc.slug))).toBe(true);
    for (const doc of CORE_DOCS) expect(paths.has(routes.core(doc.slug))).toBe(true);
  });

  it("shows something under every title", () => {
    // A hit with no context line is a bare identifier the reader has to guess the meaning of.
    const bare = INDEX.entries
      .filter((entry) => entry.title.trim() === "" || entry.context.trim() === "")
      .map((entry) => entry.path);
    expect(bare).toEqual([]);
  });
});

describe("search ranking", () => {
  const prepared = prepare(INDEX.entries);
  const top = (query: string): string | undefined => search(prepared, query)[0]?.entry.path;

  it("finds a camelCase option from separate words", () => {
    // The reason there is a hand-written scorer at all: `row height` has to reach `rowHeight`.
    const hits = search(prepared, "row height");
    expect(hits.some((hit) => hit.entry.path === "/reference/tree-grid/config?p=rowHeight")).toBe(true);
  });

  it("finds a namespaced key from its bare name", () => {
    const hits = search(prepared, "rowToggle");
    expect(hits.some((hit) => hit.entry.title === "view/rowToggle")).toBe(true);
  });

  it("prefers an exact identifier over a page that merely mentions it", () => {
    expect(top("undo-redo")).toBe("/reference/undo-redo");
  });

  it("requires every term to match, so two words do not widen the result", () => {
    const one = search(prepared, "export");
    const two = search(prepared, "export zzzzznotathing");
    expect(one.length).toBeGreaterThan(0);
    expect(two).toEqual([]);
  });

  it("returns nothing for an empty query", () => {
    expect(search(prepared, "")).toEqual([]);
    expect(search(prepared, "   ")).toEqual([]);
  });

  it("caps the result list", () => {
    expect(search(prepared, "a", 5).length).toBeLessThanOrEqual(5);
  });
});

/* ------------------------------------------------------------------ *
 * The content manifest — page identity without page content.
 * ------------------------------------------------------------------ */

describe("content-manifest.json", () => {
  it("matches what the builder produces from the current content", async () => {
    const onDisk = readFileSync(join(DOCS_ROOT, "src/generated/content-manifest.json"), "utf8");
    const fresh = serializeManifest(await buildManifest());
    expect(
      onDisk === fresh
        ? "up to date"
        : "stale — run `node tools/build-content-index.ts` and review the diff before committing",
    ).toBe("up to date");
  });

  it("names a module for every documented plugin, guide and chapter", async () => {
    // The manifest is what the router loads from, so an entry missing here is a page that renders
    // "not documented yet" while its module sits on disk — the one failure the eager glob could
    // not produce and lazy loading can.
    const manifest = await buildManifest();
    expect(manifest.plugins.map((entry) => entry.id).sort()).toEqual(
      PLUGIN_DOCS.map((doc) => doc.id).sort(),
    );
    expect(manifest.guides.map((entry) => entry.slug)).toEqual(GUIDE_DOCS.map((doc) => doc.slug));
    expect(manifest.core.map((entry) => entry.slug)).toEqual(CORE_DOCS.map((doc) => doc.slug));
  });

  it("carries the title each page actually renders", async () => {
    // The sidebar reads titles from here rather than from the page, so a drift between the two
    // shows a reader one name in the nav and another on the page.
    const manifest = await buildManifest();
    const titles = new Map(manifest.guides.concat(manifest.core).map((p) => [p.slug, p.title]));
    for (const doc of [...GUIDE_DOCS, ...CORE_DOCS]) expect(titles.get(doc.slug)).toBe(doc.title);
  });
});
