/**
 * Unit tests for `src/internal/context-menu/link-source.ts` — the one-shot pending "start link from
 * here" state, driven directly through its named transitions with no host and no DOM.
 *
 * docs/specs/plugins/interaction.md §6.5 "Pending link source lifetime".
 */
import { describe, expect, it } from "vitest";
import { createLinkSource } from "../src/internal/context-menu/link-source";

describe("createLinkSource", () => {
  it("starts unarmed", () => {
    expect(createLinkSource().get()).toBeUndefined();
  });

  it("arms the source and carries it through an invocation that touches it", () => {
    const source = createLinkSource();
    source.beginInvocation();
    source.set("a");
    source.endInvocation();
    expect(source.get()).toBe("a");
  });

  it("expires an armed source when the next invocation never touches it", () => {
    const source = createLinkSource();
    source.beginInvocation();
    source.set("a");
    source.endInvocation(); // invocation 1: armed
    source.beginInvocation(); // invocation 2: never calls set()
    source.endInvocation();
    expect(source.get()).toBeUndefined();
  });

  it("does not expire the arming invocation itself", () => {
    const source = createLinkSource();
    source.beginInvocation();
    source.set("a");
    source.endInvocation();
    expect(source.get()).toBe("a");
  });

  it("re-arming in the consuming invocation carries the new source forward", () => {
    const source = createLinkSource();
    source.beginInvocation();
    source.set("a");
    source.endInvocation();

    source.beginInvocation();
    source.set("b"); // consumes a and re-arms on b, in the same invocation
    source.endInvocation();
    expect(source.get()).toBe("b");
  });

  it("re-arming on the same task still counts as touched", () => {
    const source = createLinkSource();
    source.beginInvocation();
    source.set("a");
    source.endInvocation();

    source.beginInvocation();
    source.set("a"); // same value, but an explicit re-arm
    source.endInvocation();
    expect(source.get()).toBe("a");

    source.beginInvocation(); // a third invocation that never touches it
    source.endInvocation();
    expect(source.get()).toBeUndefined();
  });

  it("consuming (set(undefined)) also counts as touched, and stays consumed", () => {
    const source = createLinkSource();
    source.beginInvocation();
    source.set("a");
    source.endInvocation();

    source.beginInvocation();
    source.set(undefined); // link-to consumes it
    source.endInvocation();
    expect(source.get()).toBeUndefined();
  });

  it("dropUnless clears an armed source whose task no longer exists", () => {
    const source = createLinkSource();
    source.beginInvocation();
    source.set("a");
    source.endInvocation();
    source.dropUnless((id) => id !== "a");
    expect(source.get()).toBeUndefined();
  });

  it("dropUnless leaves a still-existing source untouched", () => {
    const source = createLinkSource();
    source.beginInvocation();
    source.set("a");
    source.endInvocation();
    source.dropUnless((id) => id === "a");
    expect(source.get()).toBe("a");
  });

  it("dropUnless is a no-op while unarmed", () => {
    const source = createLinkSource();
    expect(() => source.dropUnless(() => false)).not.toThrow();
    expect(source.get()).toBeUndefined();
  });
});
