/**
 * Contract §1.4 — the three standard reducers `collect` / `first` / `reduce`.
 * These are ordinary functions passed as the `reduce` argument of `defineExtensionPoint`;
 * the core has no strategy enum.
 */
import { describe, expect, it } from "vitest";
import { collect, first, reduce } from "../src/index";

describe("collect (§1.4)", () => {
  it("returns all contributions as an array, in order", () => {
    expect(collect<string>()(["a", "b", "c"])).toEqual(["a", "b", "c"]);
  });

  it("returns an empty array for no contributions", () => {
    expect(collect<string>()([])).toEqual([]);
  });

  it("preserves duplicate and identical contributions", () => {
    const fn = (): void => {};
    expect(collect<unknown>()([fn, fn, 1, 1])).toEqual([fn, fn, 1, 1]);
  });
});

describe("first (§1.4)", () => {
  it("produces a composite function of the same signature as the contributions", () => {
    const composed = first<[number], string>()([]);
    expect(typeof composed).toBe("function");
  });

  it("returns the first non-undefined RESULT, in startup order", () => {
    const composed = first<[number], string>()([
      (x) => (x > 10 ? "big" : undefined),
      (x) => (x > 5 ? "medium" : undefined),
      () => "fallback",
    ]);
    expect(composed(20)).toBe("big");
    expect(composed(7)).toBe("medium");
    expect(composed(1)).toBe("fallback");
  });

  it("stops invoking contributions once one answers (interception semantics)", () => {
    const calls: string[] = [];
    const composed = first<[], string>()([
      () => {
        calls.push("a");
        return undefined;
      },
      () => {
        calls.push("b");
        return "answer";
      },
      () => {
        calls.push("c");
        return "never";
      },
    ]);
    expect(composed()).toBe("answer");
    expect(calls).toEqual(["a", "b"]);
  });

  it("returns undefined when every contribution declines", () => {
    const composed = first<[number], string>()([() => undefined, () => undefined]);
    expect(composed(1)).toBeUndefined();
  });

  it("returns undefined when there are no contributions", () => {
    expect(first<[number], string>()([])(1)).toBeUndefined();
  });

  it("forwards every argument to each contribution", () => {
    const seen: unknown[][] = [];
    const composed = first<[number, string, boolean], string>()([
      (...args) => {
        seen.push(args);
        return undefined;
      },
      (...args) => {
        seen.push(args);
        return "ok";
      },
    ]);
    expect(composed(1, "two", true)).toBe("ok");
    expect(seen).toEqual([
      [1, "two", true],
      [1, "two", true],
    ]);
  });

  it("is re-evaluated on every call (call-time, not startup-time, semantics)", () => {
    let toggle = false;
    const composed = first<[], string>()([
      () => (toggle ? "on" : undefined),
      () => "off",
    ]);
    expect(composed()).toBe("off");
    toggle = true;
    expect(composed()).toBe("on");
  });

  it("does not swallow a contribution's throw — §1.9 makes that the point owner's job", () => {
    const composed = first<[], string>()([
      () => {
        throw new Error("hit-tester failed");
      },
    ]);
    expect(() => composed()).toThrowError(/hit-tester failed/);
  });

  it("treats null and other falsy results as answers (only `undefined` declines)", () => {
    const composed = first<[], string | null | 0 | "">()([
      () => null,
      () => "later",
    ]);
    expect(composed()).toBeNull();
    expect(first<[], 0 | 1>()([() => 0, () => 1])()).toBe(0);
    expect(first<[], "" | "x">()([() => "", () => "x"])()).toBe("");
  });
});

describe("reduce (§1.4)", () => {
  it("folds contributions to a single value using the seed", () => {
    expect(reduce<number, number>((acc, n) => acc + n, 0)([1, 2, 3])).toBe(6);
  });

  it("returns the seed for no contributions", () => {
    expect(reduce<number, number>((acc, n) => acc + n, 42)([])).toBe(42);
  });

  it("folds left-to-right in contribution order", () => {
    expect(reduce<string, string>((acc, s) => acc + s, "seed:")(["a", "b", "c"])).toBe("seed:abc");
  });

  it("supports a result type different from the contribution type", () => {
    const fold = reduce<number, string>((acc, n) => `${acc}${n},`, "");
    expect(fold([1, 2])).toBe("1,2,");
  });

  it("can implement 'last wins' (§1.4's row-height / zoom-level use cases)", () => {
    expect(reduce<number, number>((_acc, n) => n, 0)([10, 20, 30])).toBe(30);
  });
});
