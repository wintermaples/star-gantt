/**
 * The roster page's hand-written data, checked against the API snapshot.
 *
 * `guides/17-what-the-standard-preset-loads.ts` cannot import `generated/api.json`: content modules
 * are imported by `tools/build-content-index.ts` under plain Node, where a JSON import without an
 * attribute fails. So the roster is written out in the page and verified here instead — a plugin
 * that joins or leaves the standard preset, or a factory that is renamed, fails by name rather than
 * leaving the page quietly disagreeing with the library.
 *
 * The composition *order* has no field in `api.json` (it is normative in
 * `packages/preset-standard/src/index.ts`'s own import order and doc comment — "data store, view
 * ..., row model, task bars, interaction, undo/redo, accessibility, scheduling, export"), so
 * membership is what this can check; the page owns the sequence.
 */
import { describe, expect, it } from "vitest";
import { PLUGINS } from "../src/generated/api";
import doc, {
  CONFIG_KEYS,
  OPT_IN_BY_CATEGORY,
} from "../src/content/guides/17-what-the-standard-preset-loads";

const preset = PLUGINS.filter((p) => p.inPresetStandard);
const optIn = PLUGINS.filter((p) => !p.inPresetStandard && p.factory !== null);

describe("the standard-preset roster page", () => {
  it("lists exactly the plugins the snapshot says are in the preset", () => {
    expect(Object.keys(CONFIG_KEYS).sort()).toEqual(preset.map((p) => p.id).sort());
  });

  it("names each preset plugin's PresetStandardConfig key as its factory name", () => {
    // One documented exception: `export` is a reserved word as an identifier but not as an object
    // property key, so the exported *factory* is named `exportPlugin` while `PresetStandardConfig`
    // keeps the property `export` (packages/preset-standard/src/index.ts says so explicitly). Every
    // other preset plugin's config key is its factory name verbatim.
    const RESERVED_WORD_KEYS: Readonly<Record<string, string>> = { "stargantt.export": "export" };
    for (const plugin of preset) {
      const expected = RESERVED_WORD_KEYS[plugin.id] ?? plugin.factory;
      expect(CONFIG_KEYS[plugin.id], `config key for ${plugin.id}`).toBe(expected);
    }
  });

  it("lists exactly the opt-in factories, in the categories the snapshot puts them in", () => {
    const expected: Record<string, string[]> = {};
    for (const plugin of optIn) {
      (expected[plugin.category] ??= []).push(plugin.factory as string);
    }
    for (const names of Object.values(expected)) names.sort();

    const actual: Record<string, string[]> = {};
    for (const [category, names] of Object.entries(OPT_IN_BY_CATEGORY)) {
      actual[category] = [...names].sort();
    }
    expect(actual).toEqual(expected);
  });

  it("renders the roster into the page's own listing, one line per preset plugin", () => {
    const listing = doc.cells.find(
      (cell) => cell.kind === "code" && cell.source.startsWith("presetStandard({"),
    );
    expect(listing, "the roster code cell").toBeDefined();
    const source = (listing as { source: string }).source;
    for (const plugin of preset) {
      expect(source, `${plugin.id} in the roster listing`).toContain(plugin.id);
      // The listing is what a reader writes into `presetStandard({ ... })`, so it uses the
      // PresetStandardConfig property key (CONFIG_KEYS), not necessarily the factory's own export
      // name — see the reserved-word exception in the test above.
      expect(source, `${CONFIG_KEYS[plugin.id] ?? ""} key in the roster listing`).toContain(
        `${CONFIG_KEYS[plugin.id] ?? ""}: {}`,
      );
    }
  });
});
