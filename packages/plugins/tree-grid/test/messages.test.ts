/**
 * docs/specs/plugins/tree-grid.md § Messages — the column-header catalog, exercised through the
 * booted grid rather than the resolver in isolation (see `messages-resolve.test.ts` for that).
 */
import { afterEach, describe, expect, it } from "vitest";
import type { TreeGridConfig, TreeGridMessages } from "../src/index";
import { DEFAULT_MESSAGES } from "../src/internal/messages";
import { boot, probe } from "./_boot";
import type { Booted } from "./_boot";

let booted: Booted | undefined;

afterEach(() => {
  booted?.gantt.dispose();
  booted?.dom.restore();
  booted = undefined;
});

/** Header texts of the grid's header row, in column order. */
function headers(config?: TreeGridConfig): string[] {
  booted = boot([], {}, config);
  return booted.header
    .findAll("sg-grid-cell sg-grid-header-cell")
    .map((h) => h.textContent ?? "");
}

describe("TreeGridMessages defaults", () => {
  it("uses the built-in English headers when no catalog is supplied", () => {
    expect(headers()).toEqual(["Name", "Start", "End", "Progress"]);
  });

  it("reproduces the same headers for an empty catalog", () => {
    expect(headers({ messages: {} })).toEqual(["Name", "Start", "End", "Progress"]);
  });
});

describe("TreeGridMessages overrides", () => {
  it("replaces a supplied key and keeps every other default (per-key shallow merge)", () => {
    expect(headers({ messages: { nameColumn: "Aufgabe", endColumn: "Ende" } })).toEqual([
      "Aufgabe",
      "Start",
      "Ende",
      "Progress",
    ]);
  });

  it("replaces every key when the whole catalog is supplied", () => {
    const all: TreeGridMessages = {
      ...DEFAULT_MESSAGES,
      nameColumn: "N",
      startColumn: "S",
      endColumn: "E",
      progressColumn: "P",
      wbsColumn: "W",
      newTaskName: "T",
      paneResizeLabel: "R",
    };
    expect(headers({ messages: all })).toEqual(["N", "S", "E", "P"]);
  });

  it("takes the empty string verbatim", () => {
    expect(headers({ messages: { progressColumn: "" } })).toEqual(["Name", "Start", "End", ""]);
  });

  it("ignores an unusable member and uses its default", () => {
    // A member present but `undefined` counts as absent; a non-string is unusable. Both cases are
    // written as a cast because the declared type forbids them, which is the point of the test.
    const messages = {
      nameColumn: undefined,
      startColumn: 7,
      endColumn: () => "x",
    } as unknown as Partial<TreeGridMessages>;
    expect(headers({ messages })).toEqual(["Name", "Start", "End", "Progress"]);
  });

  it("ignores a non-object `messages`", () => {
    expect(headers({ messages: "nope" as unknown as Partial<TreeGridMessages> })).toEqual([
      "Name",
      "Start",
      "End",
      "Progress",
    ]);
  });

  it("resolves once at setup: mutating the catalog afterwards has no effect", () => {
    const messages: Partial<TreeGridMessages> = { nameColumn: "first" };
    booted = boot([], {}, { messages });
    messages.nameColumn = "second";
    const texts = booted.header
      .findAll("sg-grid-cell sg-grid-header-cell")
      .map((h) => h.textContent);
    expect(texts[0]).toBe("first");
  });

  it("leaves a column contributed by another plugin untouched", () => {
    booted = boot(
      [
        probe((ctx) => {
          ctx.contribute("grid/columns", {
            id: "note",
            header: "Note",
            width: 60,
            render: (el) => void (el.textContent = ""),
            getValue: () => undefined,
          });
        }),
      ],
      {},
      { messages: { nameColumn: "Aufgabe" } },
    );
    const texts = booted.header
      .findAll("sg-grid-cell sg-grid-header-cell")
      .map((h) => h.textContent);
    expect(texts).toEqual(["Aufgabe", "Start", "End", "Progress", "Note"]);
  });
});

// docs/specs/plugins/tree-grid.md § Messages — the grid pane's divider names itself through this
// plugin's own catalog.
describe("paneResizeLabel", () => {
  it("names the divider 'Resize pane' by default — the same text the fallback used", () => {
    booted = boot();
    expect(booted.divider.getAttribute("aria-label")).toBe("Resize pane");
  });

  it("uses a supplied override", () => {
    booted = boot([], {}, { messages: { paneResizeLabel: "Grid divider" } });
    expect(booted.divider.getAttribute("aria-label")).toBe("Grid divider");
  });

  it("falls back to the default for a blank override — a divider must always carry a name", () => {
    booted = boot([], {}, { messages: { paneResizeLabel: "   " } });
    expect(booted.divider.getAttribute("aria-label")).toBe("Resize pane");
  });

  it("falls back to the default for an empty-string override too", () => {
    booted = boot([], {}, { messages: { paneResizeLabel: "" } });
    expect(booted.divider.getAttribute("aria-label")).toBe("Resize pane");
  });
});
