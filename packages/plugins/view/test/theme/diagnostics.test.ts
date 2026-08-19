/**
 * Both warnings exist to name a mistake that is otherwise silent, so the property that matters is
 * that they are *quiet* on a healthy chart: a diagnostic that cries wolf is worse than none. The
 * rule is exercised through `diagnose`, which is where the decision lives — the DOM probe that
 * feeds it is a measurement, not a policy.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { diagnose } from "../../src/internal/theme/diagnostics";
import { RETIRED_TOKENS } from "../../src/internal/theme/registry";
import { boot } from "./_boot";
import type { Booted } from "./_boot";

/** The library's own defaults for a two-token palette, one scheme-dependent, one shared. */
const LIGHT: Record<string, string> = { "--sg-bg": "#ffffff", "--sg-bar-radius": "4px" };
const DARK: Record<string, string> = { "--sg-bg": "#1a1917", "--sg-bar-radius": "4px" };

function input(overrides: Partial<Parameters<typeof diagnose>[0]> = {}) {
  return {
    tokens: ["--sg-bg", "--sg-bar-radius"],
    readRoot: (token: string) => LIGHT[token] ?? "",
    readLight: (token: string) => LIGHT[token] ?? "",
    readDark: (token: string) => DARK[token] ?? "",
    schemePinned: false,
    retired: {},
    ...overrides,
  };
}

// The deferred timer that runs the probe pass.
describe("diagnostics scheduling", () => {
  let booted: Booted | undefined;
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    booted?.gantt.dispose();
    booted = undefined;
    warn.mockRestore();
  });

  it("config.diagnostics: false never schedules the probe pass", () => {
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    booted = boot([], {}, { diagnostics: false });
    // The plugin's own deferred-diagnostics `setTimeout(..., 0)` call never happens — no handle
    // is minted, so there is nothing for `runDiagnostics` to ever run from.
    expect(setTimeoutSpy).not.toHaveBeenCalled();
    setTimeoutSpy.mockRestore();
  });

  it("clears the deferred-diagnostics timer on dispose, before it can fire", () => {
    vi.useFakeTimers();
    try {
      const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
      booted = boot();
      const handle = setTimeoutSpy.mock.results[0]?.value;
      expect(handle).toBeDefined();

      const clearTimeoutSpy = vi.spyOn(globalThis, "clearTimeout");
      booted.gantt.dispose();
      booted = undefined;
      expect(clearTimeoutSpy).toHaveBeenCalledWith(handle);

      // Advancing the clock past when the timer would have fired must not run the probe pass —
      // ctx.own's dispose ran clearTimeout *before* this, so there is nothing left to fire.
      warn.mockClear();
      vi.runAllTimers();
      expect(warn).not.toHaveBeenCalled();
      setTimeoutSpy.mockRestore();
      clearTimeoutSpy.mockRestore();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("token catalog shape", () => {
  it("no currently-supported token is also listed as retired", async () => {
    const { CANVAS_READ_TOKENS } = await import("../../src/internal/theme/registry");
    const { FORCED_COLOR_TOKENS } = await import("../../src/internal/theme/forced-colors");
    const retired = new Set(Object.keys(RETIRED_TOKENS));

    // A token cannot be both "still read live" and "retired": the diagnostic would then warn
    // about a token the plugin itself still reads, which is a contradiction in the catalog.
    for (const token of CANVAS_READ_TOKENS) expect(retired.has(token)).toBe(false);
    // Same for the forced-colors override table — a retired token has no forced-colors value.
    for (const token of Object.keys(FORCED_COLOR_TOKENS)) expect(retired.has(token)).toBe(false);
  });
});

describe("retired tokens", () => {
  it("says nothing when the page declares none of them", () => {
    expect(diagnose(input({ retired: RETIRED_TOKENS }))).toEqual([]);
  });

  it("names the replacement when the page still declares one", () => {
    const messages = diagnose(
      input({
        retired: RETIRED_TOKENS,
        // The library declares nothing under this name, so a non-empty value is the host's.
        readRoot: (token) => (token === "--sg-progress-fill" ? "rgba(0,0,0,.6)" : LIGHT[token] ?? ""),
      }),
    );
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain("--sg-progress-fill");
    expect(messages[0]).toContain("--sg-bar-track-alpha");
  });
});

describe("partial palette on an unpinned chart", () => {
  it("says nothing when the page overrides nothing", () => {
    expect(diagnose(input())).toEqual([]);
  });

  it("says nothing when the page overrides every scheme-dependent token", () => {
    // A complete palette is safe unpinned: there is no token left to follow the OS.
    const messages = diagnose(
      input({ readRoot: (token) => (token === "--sg-bg" ? "#123456" : LIGHT[token] ?? "") }),
    );
    expect(messages).toEqual([]);
  });

  it("warns when part of the palette is overridden and the rest can still follow the OS", () => {
    const messages = diagnose(
      input({
        tokens: ["--sg-bg", "--sg-fg", "--sg-bar-radius"],
        readLight: (token) => ({ ...LIGHT, "--sg-fg": "#1c1917" })[token] ?? "",
        readDark: (token) => ({ ...DARK, "--sg-fg": "#e7e5e4" })[token] ?? "",
        // The host recoloured the background but left the foreground to the library.
        readRoot: (token) =>
          ({ "--sg-bg": "#123456", "--sg-fg": "#1c1917", "--sg-bar-radius": "4px" })[token] ?? "",
      }),
    );
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain("sg-scheme-dark");
  });

  it("says nothing about a partial palette once the scheme is pinned", () => {
    const messages = diagnose(
      input({
        schemePinned: true,
        readRoot: (token) => (token === "--sg-bg" ? "#123456" : LIGHT[token] ?? ""),
        tokens: ["--sg-bg", "--sg-fg"],
        readLight: (token) => ({ ...LIGHT, "--sg-fg": "#1c1917" })[token] ?? "",
        readDark: (token) => ({ ...DARK, "--sg-fg": "#e7e5e4" })[token] ?? "",
      }),
    );
    expect(messages).toEqual([]);
  });

  it("ignores scheme-shared tokens — they cannot land on the wrong side of a pair", () => {
    // Only `--sg-bar-radius` is left at its default, and it is identical in both schemes, so an
    // overridden `--sg-bg` alone must not be enough to raise the warning.
    const messages = diagnose(
      input({ readRoot: (token) => (token === "--sg-bg" ? "#123456" : LIGHT[token] ?? "") }),
    );
    expect(messages).toEqual([]);
  });
});
