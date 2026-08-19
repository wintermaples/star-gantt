// @vitest-environment happy-dom
// docs/specs/plugins/export.md §2.1 — the read-only transaction veto.
import { afterEach, describe, expect, it } from "vitest";
import { boot, DAY, sampleData } from "./_boot";
import type { Booted } from "./_boot";

let booted: Booted | undefined;
afterEach(() => {
  booted?.dispose();
  booted = undefined;
});

describe("read-only mode", () => {
  it("is off by default: edits go through and no class is set", () => {
    const { tasks } = sampleData();
    booted = boot({ tasks });
    expect(booted.service.isReadOnly()).toBe(false);
    expect(booted.root.classList.contains("sg-readonly")).toBe(false);
    booted.dispatch("task/update", { id: "a1", after: { name: "Renamed" } });
    expect(booted.data.getTask("a1")?.name).toBe("Renamed");
  });

  it("vetoes every command-driven mutation when configured on", () => {
    const { tasks } = sampleData();
    booted = boot({ tasks, config: { viewerEmbed: { readOnly: true } } });
    expect(booted.service.isReadOnly()).toBe(true);
    expect(booted.root.classList.contains("sg-readonly")).toBe(true);
    booted.dispatch("task/update", { id: "a1", after: { name: "Renamed" } });
    booted.dispatch("task/move", { id: "a1", start: 5 * DAY, end: 8 * DAY });
    booted.dispatch("task/remove", { ids: ["m1"] });
    expect(booted.data.getTask("a1")?.name).toBe("Wireframes");
    expect(booted.data.getTask("a1")?.start).toBe(0);
    expect(booted.data.getTask("m1")).toBeDefined();
    expect(booted.transactions).toHaveLength(0);
  });

  it("still allows load() while read-only (load runs outside the transaction system)", () => {
    booted = boot({ config: { viewerEmbed: { readOnly: true } } });
    booted.data.load({ tasks: [{ id: "x", name: "Loaded", start: 0, end: DAY }] });
    expect(booted.data.getTask("x")?.name).toBe("Loaded");
  });

  it("setReadOnly toggles at runtime, syncs the class and emits one change event per change", () => {
    const { tasks } = sampleData();
    booted = boot({ tasks });
    booted.service.setReadOnly(true);
    expect(booted.service.isReadOnly()).toBe(true);
    expect(booted.root.classList.contains("sg-readonly")).toBe(true);
    booted.dispatch("task/update", { id: "a1", after: { name: "Nope" } });
    expect(booted.data.getTask("a1")?.name).toBe("Wireframes");

    booted.service.setReadOnly(false);
    booted.dispatch("task/update", { id: "a1", after: { name: "Yes" } });
    expect(booted.data.getTask("a1")?.name).toBe("Yes");
    expect(booted.root.classList.contains("sg-readonly")).toBe(false);
    expect(booted.readOnlyChanges).toEqual([
      { readOnly: true, cause: "api" },
      { readOnly: false, cause: "api" },
    ]);
  });

  it("ignores no-op and non-boolean setReadOnly arguments silently", () => {
    booted = boot({ config: { viewerEmbed: { readOnly: true } } });
    booted.service.setReadOnly(true); // no change
    booted.service.setReadOnly("off" as unknown as boolean); // unusable — ignored
    expect(booted.service.isReadOnly()).toBe(true);
    expect(booted.readOnlyChanges).toEqual([]);
    expect(booted.errors).toEqual([]);
  });

  it("ignores an unusable readOnly config value", () => {
    const { tasks } = sampleData();
    booted = boot({ tasks, config: { viewerEmbed: { readOnly: "yes" as unknown as boolean } } });
    expect(booted.service.isReadOnly()).toBe(false);
    booted.dispatch("task/update", { id: "a1", after: { name: "Editable" } });
    expect(booted.data.getTask("a1")?.name).toBe("Editable");
  });

  it("initial config state emits no readOnlyChanged event", () => {
    booted = boot({ config: { viewerEmbed: { readOnly: true } } });
    expect(booted.readOnlyChanges).toEqual([]);
  });

  describe("exempt data-layer origins", () => {
    it("lets built-in data-layer origins through while vetoing everything else", () => {
      const { tasks } = sampleData();
      booted = boot({ tasks, config: { viewerEmbed: { readOnly: true } } });
      booted.dispatch("task/update", { id: "a1", after: { name: "From data-source" }, origin: "data-source" });
      expect(booted.data.getTask("a1")?.name).toBe("From data-source");

      booted.dispatch("task/update", { id: "a1", after: { name: "From realtime-sync" }, origin: "realtime-sync" });
      expect(booted.data.getTask("a1")?.name).toBe("From realtime-sync");

      booted.dispatch("task/update", { id: "a1", after: { name: "From lazy-load" }, origin: "lazy-load" });
      expect(booted.data.getTask("a1")?.name).toBe("From lazy-load");

      // A non-exempt origin (including the default "user" and a synthetic "schedule") stays vetoed.
      booted.dispatch("task/update", { id: "a1", after: { name: "User edit" } });
      expect(booted.data.getTask("a1")?.name).toBe("From lazy-load");
      booted.dispatch("task/update", { id: "a1", after: { name: "From schedule" }, origin: "schedule" });
      expect(booted.data.getTask("a1")?.name).toBe("From lazy-load");
    });

    it("adds configured origins on top of the built-in set without narrowing it", () => {
      const { tasks } = sampleData();
      booted = boot({
        tasks,
        config: { viewerEmbed: { readOnly: true, readOnlyExemptOrigins: ["custom-sync"] } },
      });
      booted.dispatch("task/update", { id: "a1", after: { name: "Custom" }, origin: "custom-sync" });
      expect(booted.data.getTask("a1")?.name).toBe("Custom");

      // Built-in exemption is still active alongside the configured addition.
      booted.dispatch("task/update", { id: "a1", after: { name: "Still data-source" }, origin: "data-source" });
      expect(booted.data.getTask("a1")?.name).toBe("Still data-source");

      booted.dispatch("task/update", { id: "a1", after: { name: "Not exempt" } });
      expect(booted.data.getTask("a1")?.name).toBe("Still data-source");
    });

    it("ignores an unusable readOnlyExemptOrigins config value silently", () => {
      const { tasks } = sampleData();
      booted = boot({
        tasks,
        config: { viewerEmbed: { readOnly: true, readOnlyExemptOrigins: "data-source" as unknown as string[] } },
      });
      booted.dispatch("task/update", { id: "a1", after: { name: "Still built-in" }, origin: "data-source" });
      expect(booted.data.getTask("a1")?.name).toBe("Still built-in");
      expect(booted.errors).toEqual([]);
    });

    it("drops non-string entries in readOnlyExemptOrigins but keeps the usable ones", () => {
      const { tasks } = sampleData();
      booted = boot({
        tasks,
        config: {
          viewerEmbed: {
            readOnly: true,
            readOnlyExemptOrigins: [42 as unknown as string, "custom-sync", null as unknown as string],
          },
        },
      });
      booted.dispatch("task/update", { id: "a1", after: { name: "Custom" }, origin: "custom-sync" });
      expect(booted.data.getTask("a1")?.name).toBe("Custom");
      expect(booted.errors).toEqual([]);
    });
  });
});
