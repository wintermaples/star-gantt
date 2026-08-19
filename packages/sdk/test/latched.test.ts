/**
 * The latched fault barriers and the message-catalog merge (docs/specs/sdk.md, Module: sdk/dom).
 */
import { describe, expect, it } from "vitest";
import { latchedBuilderBarrier, latchedSeam, resolveCatalog } from "../src/index";

describe("latchedSeam", () => {
  it("passes calls through and reports true while the seam behaves", () => {
    const seen: string[] = [];
    const seam = latchedSeam<string>((_host, ctx) => void seen.push(ctx), () => {});
    expect(seam({} as HTMLElement, "a")).toBe(true);
    expect(seam({} as HTMLElement, "b")).toBe(true);
    expect(seen).toEqual(["a", "b"]);
  });

  it("latches on the first throw: one fault report, then declines without calling through", () => {
    const faults: unknown[] = [];
    let calls = 0;
    const seam = latchedSeam<void>(
      () => {
        calls += 1;
        throw new Error("broken host");
      },
      (error) => void faults.push(error),
    );
    expect(seam({} as HTMLElement, undefined)).toBe(false);
    expect(seam({} as HTMLElement, undefined)).toBe(false);
    expect(calls).toBe(1);
    expect(faults).toHaveLength(1);
    expect((faults[0] as Error).message).toBe("broken host");
  });
});

describe("latchedBuilderBarrier", () => {
  it("passes string results through untouched", () => {
    const wrapped = latchedBuilderBarrier((n: number) => `n=${n}`, () => "fallback", () => {});
    expect(wrapped(7)).toBe("n=7");
  });

  it("latches on a throw: default answers, one report, builder never called again", () => {
    const faults: unknown[] = [];
    let calls = 0;
    const wrapped = latchedBuilderBarrier<[number]>(
      () => {
        calls += 1;
        throw new Error("boom");
      },
      (n) => `default ${n}`,
      (error) => void faults.push(error),
    );
    expect(wrapped(1)).toBe("default 1");
    expect(wrapped(2)).toBe("default 2");
    expect(calls).toBe(1);
    expect(faults).toHaveLength(1);
  });

  it("latches on a non-string return exactly like a throw", () => {
    const faults: unknown[] = [];
    let calls = 0;
    const wrapped = latchedBuilderBarrier<[]>(
      () => {
        calls += 1;
        return 5 as unknown as string;
      },
      () => "default",
      (error) => void faults.push(error),
    );
    expect(wrapped()).toBe("default");
    expect(wrapped()).toBe("default");
    expect(calls).toBe(1);
    expect(faults).toHaveLength(1);
    expect(faults[0]).toBeInstanceOf(TypeError);
  });
});

interface Catalog {
  title: string;
  hint: string;
  line: (n: number) => string;
}

const DEFAULTS: Catalog = {
  title: "Title",
  hint: "Hint",
  line: (n) => `line ${n}`,
};

describe("resolveCatalog", () => {
  it("returns the defaults for missing, non-object or partial overrides", () => {
    expect(resolveCatalog(DEFAULTS, undefined, () => {})).toEqual(DEFAULTS);
    expect(resolveCatalog(DEFAULTS, "no" as unknown as Partial<Catalog>, () => {}).title).toBe(
      "Title",
    );
    const merged = resolveCatalog(DEFAULTS, { hint: "custom" }, () => {});
    expect(merged.title).toBe("Title");
    expect(merged.hint).toBe("custom");
    expect(merged.line(3)).toBe("line 3");
  });

  it("takes usable members per key: the empty string is usable, a wrong type is not", () => {
    const merged = resolveCatalog(
      DEFAULTS,
      { title: "", hint: 5 as unknown as string, line: "nope" as unknown as Catalog["line"] },
      () => {},
    );
    expect(merged.title).toBe("");
    expect(merged.hint).toBe("Hint");
    expect(merged.line(1)).toBe("line 1");
  });

  it("wraps a supplied builder in the latched barrier, reporting the key it faulted under", () => {
    const faults: [string, unknown][] = [];
    const merged = resolveCatalog(
      DEFAULTS,
      {
        line: () => {
          throw new Error("host bug");
        },
      },
      (key, error) => void faults.push([key, error]),
    );
    expect(merged.line(9)).toBe("line 9");
    expect(merged.line(10)).toBe("line 10");
    expect(faults).toHaveLength(1);
    expect(faults[0]?.[0]).toBe("line");
  });

  it("does not mutate the defaults object", () => {
    resolveCatalog(DEFAULTS, { title: "x", line: () => "y" }, () => {});
    expect(DEFAULTS.title).toBe("Title");
    expect(DEFAULTS.line(1)).toBe("line 1");
  });
});
