// docs/specs/plugins/a11y.md § Messages — the 12-key catalog, its byte-for-byte English defaults,
// and the per-key merge.
import { describe, expect, it } from "vitest";
import { DEFAULT_MESSAGES, resolveMessages } from "../src/messages";
import type { A11yMessages } from "../src/types";

const DAY = 86_400_000;

describe("the built-in catalog", () => {
  it("carries exactly the twelve documented keys, all builders", () => {
    const keys = Object.keys(DEFAULT_MESSAGES).sort();
    expect(keys).toEqual(
      [
        "editCommitted",
        "rowCollapsed",
        "rowDependencies",
        "rowExpanded",
        "rowText",
        "selectionCount",
        "shortcutHelpClose",
        "shortcutHelpTitle",
        "sortChanged",
        "summaryHeader",
        "summaryTitle",
        "zoomChanged",
      ].sort(),
    );
    for (const key of keys) {
      expect(typeof DEFAULT_MESSAGES[key as keyof A11yMessages]).toBe("function");
    }
  });

  it("renders the row text with ISO days around a spaced en dash", () => {
    expect(DEFAULT_MESSAGES.rowText({ name: "design", start: 0, end: DAY })).toBe(
      "design, 1970-01-01 – 1970-01-02",
    );
    expect(DEFAULT_MESSAGES.rowText({ name: "design", start: 0, end: DAY, progress: 0.256 })).toBe(
      "design, 1970-01-01 – 1970-01-02, 26%",
    );
  });

  it("renders the toggle, selection, sort, edit and zoom announcements", () => {
    expect(DEFAULT_MESSAGES.rowExpanded("a")).toBe("a, expanded");
    expect(DEFAULT_MESSAGES.rowExpanded(undefined)).toBe("expanded");
    expect(DEFAULT_MESSAGES.rowCollapsed("a")).toBe("a, collapsed");
    expect(DEFAULT_MESSAGES.rowCollapsed(undefined)).toBe("collapsed");
    expect(DEFAULT_MESSAGES.selectionCount(3)).toBe("3 selected");
    expect(DEFAULT_MESSAGES.sortChanged({ header: "Name", direction: "ascending" })).toBe(
      "Name, sorted ascending",
    );
    expect(DEFAULT_MESSAGES.sortChanged({ header: "Name", direction: "descending" })).toBe(
      "Name, sorted descending",
    );
    expect(DEFAULT_MESSAGES.sortChanged({ header: "Name", direction: null })).toBe("Name, sort off");
    expect(DEFAULT_MESSAGES.editCommitted("a")).toBe("a, updated");
    expect(DEFAULT_MESSAGES.editCommitted(undefined)).toBe("updated");
    expect(DEFAULT_MESSAGES.zoomChanged("week")).toBe("Zoom: week");
  });

  it("renders the dependency read-out, leaving an empty segment out", () => {
    expect(DEFAULT_MESSAGES.rowDependencies({ predecessors: ["a"], successors: ["b", "c"] })).toBe(
      "Depends on: a. Blocks: b, c",
    );
    expect(DEFAULT_MESSAGES.rowDependencies({ predecessors: [], successors: ["b"] })).toBe(
      "Blocks: b",
    );
    expect(DEFAULT_MESSAGES.rowDependencies({ predecessors: ["a"], successors: [] })).toBe(
      "Depends on: a",
    );
  });

  it("renders the dialog chrome and the summary table's caption and headers", () => {
    expect(DEFAULT_MESSAGES.shortcutHelpTitle()).toBe("Keyboard shortcuts");
    expect(DEFAULT_MESSAGES.shortcutHelpClose()).toBe("Close");
    expect(DEFAULT_MESSAGES.summaryTitle({ total: 4, shown: 4 })).toBe("Gantt chart summary, 4 tasks");
    expect(DEFAULT_MESSAGES.summaryTitle({ total: 1200, shown: 1000 })).toBe(
      "Gantt chart summary, first 1000 of 1200 tasks",
    );
    expect(DEFAULT_MESSAGES.summaryHeader("name")).toBe("Name");
    expect(DEFAULT_MESSAGES.summaryHeader("start")).toBe("Start");
    expect(DEFAULT_MESSAGES.summaryHeader("end")).toBe("End");
    expect(DEFAULT_MESSAGES.summaryHeader("progress")).toBe("Progress");
  });
});

describe("resolveMessages", () => {
  const noFault = (): void => {};

  it("returns the defaults for an absent, null or non-object override", () => {
    expect(resolveMessages(undefined, noFault).selectionCount(2)).toBe("2 selected");
    expect(resolveMessages(null as never, noFault).selectionCount(2)).toBe("2 selected");
    expect(resolveMessages(7 as never, noFault).selectionCount(2)).toBe("2 selected");
  });

  it("replaces one key at a time and ignores a member that is not a function", () => {
    const resolved = resolveMessages(
      { selectionCount: (n) => `${n}!`, rowExpanded: "nope" as never },
      noFault,
    );
    expect(resolved.selectionCount(2)).toBe("2!");
    expect(resolved.rowExpanded("a")).toBe("a, expanded");
  });

  it("guards a throwing builder per call, reporting the key and answering with the default", () => {
    const faults: { key: string; cause: unknown }[] = [];
    const resolved = resolveMessages(
      {
        selectionCount: () => {
          throw new Error("boom");
        },
      },
      (key, cause) => faults.push({ key, cause }),
    );
    expect(resolved.selectionCount(2)).toBe("2 selected");
    expect(resolved.selectionCount(3)).toBe("3 selected");
    // Per call, not latched: both calls were reported and both answered.
    expect(faults.length).toBe(2);
    expect(faults[0]?.key).toBe("selectionCount");
  });
});
