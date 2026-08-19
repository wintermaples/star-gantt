/**
 * Contract §1.7.1 — `PluginContext.locale`: the one delivery mechanism for `GanttOptions.locale`.
 */
import { describe, expect, it } from "vitest";
import { Gantt } from "../src/index";
import { fakeRoot, plug } from "./_keys";

/** Boots a chart with the given `locale` option and returns what the plugin saw on its context. */
function localeSeenBy(options: { locale?: unknown }): string {
  let seen = "<not set>";
  const g = Gantt.create({
    element: fakeRoot(),
    plugins: [plug("test.locale", (ctx) => void (seen = ctx.locale))],
    ...(options as { locale?: string }),
  });
  g.dispose();
  return seen;
}

describe("PluginContext.locale (§1.7.1)", () => {
  it('defaults to "en" when the option is omitted', () => {
    expect(localeSeenBy({})).toBe("en");
  });

  it("passes a language tag through verbatim", () => {
    expect(localeSeenBy({ locale: "ja-JP" })).toBe("ja-JP");
  });

  it("passes an ill-formed tag through unvalidated", () => {
    expect(localeSeenBy({ locale: "not a tag" })).toBe("not a tag");
  });

  it('falls back to "en" for an empty or blank tag', () => {
    expect(localeSeenBy({ locale: "" })).toBe("en");
    expect(localeSeenBy({ locale: "   " })).toBe("en");
  });

  it('falls back to "en" for a non-string value', () => {
    expect(localeSeenBy({ locale: 42 })).toBe("en");
    expect(localeSeenBy({ locale: null })).toBe("en");
  });

  it("gives every plugin the same value, including a dependency-free one", () => {
    const seen: string[] = [];
    const g = Gantt.create({
      element: fakeRoot(),
      locale: "de-CH",
      plugins: [
        plug("test.a", (ctx) => void seen.push(ctx.locale)),
        plug("test.b", (ctx) => void seen.push(ctx.locale)),
      ],
    });
    expect(seen).toEqual(["de-CH", "de-CH"]);
    g.dispose();
  });

  it("keeps the value it was created with when the options object is mutated afterwards", () => {
    const options = { element: fakeRoot(), locale: "fr", plugins: [] as never[] };
    let seen = "<not set>";
    const g = Gantt.create({
      ...options,
      plugins: [plug("test.frozen", (ctx) => void (seen = ctx.locale))],
    });
    options.locale = "it";
    expect(seen).toBe("fr");
    g.dispose();
  });
});
