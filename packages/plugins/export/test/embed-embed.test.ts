// @vitest-environment happy-dom
// docs/specs/plugins/export.md §2.3 — embed mode.
import { afterEach, describe, expect, it } from "vitest";
import { boot } from "./_boot";
import type { Booted } from "./_boot";

let booted: Booted | undefined;
afterEach(() => {
  booted?.dispose();
  booted = undefined;
});

function styleTexts(b: Booted): string[] {
  return [...b.root.children].filter((c) => c.tagName === "STYLE").map((c) => c.textContent ?? "");
}

describe("embed mode", () => {
  it("is fully absent by default: no class, no style element", () => {
    booted = boot();
    expect(booted.root.classList.contains("sg-viewer-embed")).toBe(false);
    expect(styleTexts(booted)).toEqual([]);
  });

  it("adds the root class and one scoped stylesheet", () => {
    booted = boot({ config: { viewerEmbed: { embed: true } } });
    expect(booted.root.classList.contains("sg-viewer-embed")).toBe(true);
    const styles = styleTexts(booted);
    expect(styles).toHaveLength(1);
    // Everything is scoped to the embed class: no bare selector leaks into the host page.
    expect(styles[0]).toContain(".sg-viewer-embed{width:100%;height:100%;}");
    expect(styles[0]).toContain("user-select:none");
    for (const line of styles[0]!.split("\n")) expect(line.startsWith(".sg-viewer-embed")).toBe(true);
  });

  it("defaults read-only to on, overridable with an explicit readOnly: false", () => {
    booted = boot({ config: { viewerEmbed: { embed: true } } });
    expect(booted.service.isReadOnly()).toBe(true);
    booted.dispose();
    booted = boot({ config: { viewerEmbed: { embed: true, readOnly: false } } });
    expect(booted.service.isReadOnly()).toBe(false);
  });

  it("removes its class and stylesheet on dispose", () => {
    booted = boot({ config: { viewerEmbed: { embed: true } } });
    const root = booted.root;
    booted.dispose();
    booted = undefined;
    expect(root.classList.contains("sg-viewer-embed")).toBe(false);
    expect(root.classList.contains("sg-readonly")).toBe(false);
    expect([...root.children].some((c) => c.tagName === "STYLE")).toBe(false);
  });
});
