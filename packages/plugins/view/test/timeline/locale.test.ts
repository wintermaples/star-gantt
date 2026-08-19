/**
 * `ctx.locale` is what every
 * `ScaleRow.format` call receives, and the built-in levels feed it to `Intl`.
 */
import { afterEach, describe, expect, it } from "vitest";
import type { ZoomLevel } from "../../src/internal/timeline/index";
import { boot, probe } from "./_boot";
import type { Booted } from "./_boot";

let booted: Booted | null = null;

afterEach(() => {
  booted?.dom.restore();
  booted = null;
});

/** A level whose rows record the `locale` argument they were handed. */
function recordingLevel(seen: string[]): ZoomLevel {
  return {
    id: "recording",
    pxPerDay: 40,
    scales: [
      {
        unit: "month",
        format: (_t, locale) => {
          seen.push(locale);
          return "m";
        },
      },
    ],
  };
}

/** Boots with `locale`, switches to a recording level and returns every locale argument seen. */
function localesSeen(locale?: string): string[] {
  const seen: string[] = [];
  booted = boot(
    [probe((ctx) => ctx.contribute("timeline/zoomLevels", recordingLevel(seen)), "test.rec")],
    {},
    { origin: 0 },
    locale,
  );
  booted.dom.flushFrames();
  seen.length = 0;
  booted.gantt.service("stargantt.timeline").setZoomLevel("recording");
  booted.dom.flushFrames();
  return seen;
}

/** Header label texts painted after the first frame. */
function headerTexts(locale?: string): string[] {
  booted = boot([], {}, { origin: 0 }, locale);
  booted.dom.flushFrames();
  return booted.header.context.texts.map((t) => t.text);
}

describe("ScaleRow.format receives ctx.locale", () => {
  it('passes "en" when the chart was created without a locale', () => {
    const seen = localesSeen();
    expect(seen.length).toBeGreaterThan(0);
    expect([...new Set(seen)]).toEqual(["en"]);
  });

  it("passes the configured language tag to every row", () => {
    const seen = localesSeen("ja-JP");
    expect(seen.length).toBeGreaterThan(0);
    expect([...new Set(seen)]).toEqual(["ja-JP"]);
  });

  it('falls back to "en" for a blank tag, matching the core normalization', () => {
    expect([...new Set(localesSeen("  "))]).toEqual(["en"]);
  });
});

describe("built-in levels reach Intl with that locale", () => {
  it("renders the default header in English when no locale is given", () => {
    const texts = headerTexts();
    expect(texts).toContain("January 1970");
  });

  it("renders the default header in the configured language", () => {
    const texts = headerTexts("ja-JP");
    expect(texts).toContain("1970年1月");
    expect(texts).not.toContain("January 1970");
  });

  it("keeps boundaries in UTC regardless of locale", () => {
    // `origin: 0` is 1970-01-01T00:00Z; a formatter in a non-UTC zone would label it 1969-12-31.
    expect(headerTexts("en-US")).toContain("January 1970");
  });
});
