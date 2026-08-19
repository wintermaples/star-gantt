/**
 * `src/internal/style.ts` — colour precedence and the latched `taskbars/style` barrier, without a
 * host: the point wins over `task.meta.color`, which wins over the type's theme token, which falls
 * back to the built-in constant.
 */
import { describe, expect, it, vi } from "vitest";
import type { BarStyleProvider } from "../src/index";
import {
  DEFAULT_BAR_COLOR,
  DEFAULT_MILESTONE_COLOR,
  DEFAULT_SUMMARY_COLOR,
  DEFAULT_TRACK_ALPHA,
  TRACK_ALPHA_TOKEN,
} from "../src/internal/paint";
import { guardStyleProvider, resolveBarColor, resolveTrackAlpha } from "../src/internal/style";
import { themeOf, task } from "./_fakes";

const plain = task({ id: "a" });

describe("resolveBarColor", () => {
  it("prefers the style provider's colour over everything else", () => {
    const styled = task({ id: "a", meta: { color: "meta" } });
    const provider: BarStyleProvider = () => ({ color: "point" });
    expect(resolveBarColor(styled, provider, themeOf({ "--sg-bar-fill": "token" }))).toBe("point");
  });

  it("falls through to task.meta.color when the provider declines", () => {
    const styled = task({ id: "a", meta: { color: "meta" } });
    expect(resolveBarColor(styled, () => undefined, themeOf({ "--sg-bar-fill": "token" }))).toBe(
      "meta",
    );
    expect(resolveBarColor(styled, () => ({}), themeOf())).toBe("meta");
  });

  it("ignores an empty or non-string override at either level", () => {
    const empty = task({ id: "a", meta: { color: "" } });
    const numeric = task({ id: "b", meta: { color: 42 } });
    expect(resolveBarColor(empty, () => ({ color: "" }), themeOf())).toBe(DEFAULT_BAR_COLOR);
    expect(
      resolveBarColor(numeric, () => ({ color: 7 as unknown as string }), themeOf()),
    ).toBe(DEFAULT_BAR_COLOR);
  });

  it("reads the token of the task's own type", () => {
    const theme = themeOf({
      "--sg-bar-fill": "bar",
      "--sg-summary-fill": "summary",
      "--sg-milestone-fill": "milestone",
    });
    expect(resolveBarColor(plain, undefined, theme)).toBe("bar");
    expect(resolveBarColor(task({ id: "s", type: "summary" }), undefined, theme)).toBe("summary");
    expect(resolveBarColor(task({ id: "m", type: "milestone" }), undefined, theme)).toBe(
      "milestone",
    );
  });

  it("falls back to the built-in constant when the token resolves to the empty string", () => {
    expect(resolveBarColor(plain, undefined, themeOf())).toBe(DEFAULT_BAR_COLOR);
    expect(resolveBarColor(task({ id: "s", type: "summary" }), undefined, themeOf())).toBe(
      DEFAULT_SUMMARY_COLOR,
    );
    expect(resolveBarColor(task({ id: "m", type: "milestone" }), undefined, themeOf())).toBe(
      DEFAULT_MILESTONE_COLOR,
    );
  });

  it("tolerates a provider that is not a function, which is what a faulting reducer yields", () => {
    const notAFunction = {} as unknown as BarStyleProvider;
    expect(resolveBarColor(plain, notAFunction, themeOf())).toBe(DEFAULT_BAR_COLOR);
    expect(resolveBarColor(plain, undefined, themeOf())).toBe(DEFAULT_BAR_COLOR);
  });
});

describe("resolveTrackAlpha", () => {
  it("parses the token, and falls back to the built-in alpha when it is unset", () => {
    expect(resolveTrackAlpha(themeOf({ [TRACK_ALPHA_TOKEN]: "0.4" }))).toBe(0.4);
    expect(resolveTrackAlpha(themeOf())).toBe(DEFAULT_TRACK_ALPHA);
    expect(resolveTrackAlpha(themeOf({ [TRACK_ALPHA_TOKEN]: "" }))).toBe(DEFAULT_TRACK_ALPHA);
  });

  // An unusable value is ignored rather than propagated. A zero or negative alpha would erase the
  // uncompleted part entirely, which reads as "no bar" rather than "not started".
  it("ignores values that are not a usable fraction", () => {
    for (const bad of ["nonsense", "0", "-0.5", "NaN"]) {
      expect(resolveTrackAlpha(themeOf({ [TRACK_ALPHA_TOKEN]: bad }))).toBe(DEFAULT_TRACK_ALPHA);
    }
    expect(resolveTrackAlpha(themeOf({ [TRACK_ALPHA_TOKEN]: "3" }))).toBe(1);
  });
});

describe("guardStyleProvider", () => {
  it("passes the task through and returns the contribution's style untouched", () => {
    const style = { color: "red" };
    const guarded = guardStyleProvider((t) => (t.id === "a" ? style : undefined), () => {
      throw new Error("must not fault");
    });
    expect(guarded(plain)).toBe(style);
    expect(guarded(task({ id: "other" }))).toBeUndefined();
  });

  it("latches after the first throw: reported once, then declines without calling again", () => {
    const fault = vi.fn();
    let calls = 0;
    const guarded = guardStyleProvider(() => {
      calls += 1;
      throw new Error("boom");
    }, fault);

    expect(guarded(plain)).toBeUndefined();
    expect(guarded(plain)).toBeUndefined();
    expect(guarded(plain)).toBeUndefined();
    expect(calls).toBe(1);
    expect(fault).toHaveBeenCalledTimes(1);
    expect((fault.mock.calls[0]?.[0] as Error).message).toBe("boom");
  });

  it("latches per wrapper, so one broken contribution does not silence another", () => {
    const fault = vi.fn();
    const broken = guardStyleProvider(() => {
      throw new Error("boom");
    }, fault);
    const good = guardStyleProvider(() => ({ color: "green" }), fault);
    broken(plain);
    expect(good(plain)).toEqual({ color: "green" });
  });
});
