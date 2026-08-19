// @vitest-environment happy-dom
/**
 * `sdk/testing`'s document-defined headless branch (`headlessElement()`): everything else in
 * `testing.test.ts` runs under vitest's default `node` environment, where `document` is
 * undefined and the headless fallback is a type-only stand-in. This file runs under `happy-dom`
 * so `document` exists, exercising the "detached `<div>`" branch both `createTestHost` and
 * `expectDepsConsistency` share (`./element.ts`).
 */
import { definePlugin } from "@stargantt/core";
import { describe, expect, it } from "vitest";
import { createTestHost, expectDepsConsistency } from "../src/index";

declare module "@stargantt/core" {
  interface Services {
    "test.alpha": { name: string };
  }
}

describe("createTestHost headless root under a real DOM", () => {
  it("gives ctxOf(id).root a real, detached <div>", () => {
    const plugin = definePlugin({ meta: { id: "test.dom-headless" }, setup() {} });
    const t = createTestHost({ plugins: [plugin] });
    const root = t.ctxOf("test.dom-headless").root;
    expect(root).toBeInstanceOf(HTMLElement);
    expect(root.tagName).toBe("DIV");
    expect(root.isConnected).toBe(false);
    t.dispose();
  });
});

describe("expectDepsConsistency mock root under a real DOM", () => {
  it("regression: setup() can touch ctx.root (e.g. appendChild) without crashing", () => {
    // Before sharing `headlessElement()` with createTestHost, this context's `root` was a bare
    // `{}`, so any real DOM operation on it threw before the deps diff could run.
    const plugin = definePlugin({
      meta: { id: "test.root-touch" },
      setup(ctx) {
        ctx.root.appendChild(document.createElement("span"));
      },
    });
    expect(() => expectDepsConsistency(plugin)).not.toThrow();
  });
});
