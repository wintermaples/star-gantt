/**
 * `TreeGridConfig` — the factory conversion and the three geometry options.
 *
 * docs/specs/plugins/tree-grid.md § Config
 *
 * Each option's default is asserted to reproduce the built-in constant exactly, so a default chart
 * stays pixel-identical, and each out-of-range value is asserted to fall back to it.
 */
import { createTestHost, mockStore } from "@stargantt/sdk";
import type { AnyPlugin } from "@stargantt/core";
import type { Task } from "@stargantt/plugin-data-store";
import { afterEach, describe, expect, it } from "vitest";
import { treeGrid } from "../src/index";
import type { TreeGridConfig } from "../src/index";
import { fakeData, task } from "./_data";
import { asElement, installDom } from "./_harness/index";
import { boot, expectHeaderParity, flatTasks, probe, treeTasks } from "./_boot";
import type { Booted } from "./_boot";

let booted: Booted | undefined;

afterEach(() => {
  booted?.gantt.dispose();
  booted?.dom.restore();
  booted = undefined;
});

/** Boots with the given config and the given tasks already loaded. */
function withConfig(config: TreeGridConfig | undefined, tasks: Partial<Task>[]): Booted {
  const b = boot([], {}, config);
  booted = b;
  b.data.load(tasks);
  b.dom.flushFrames();
  return b;
}

/** The mock service record a headless `createTestHost` composition needs to run `setup()`. */
function mockServices(): Record<string, unknown> {
  return {
    "stargantt.data": fakeData([task("t0", null)]),
    "stargantt.view": {
      invalidate: () => {},
      refreshInsets: () => {},
      direction: () => "ltr",
      reducedMotion: () => false,
      textWidth: () => 0,
      bidiIsolate: (text: string) => text,
      firstPaintMs: () => undefined,
      batchRead: (fn: () => void) => fn(),
      batchWrite: (fn: () => void) => fn(),
      predictedViewport: () => undefined,
      chartPaneElement: () => undefined as unknown as HTMLElement,
      wheelSpeedFactor: () => 1,
      scrollTo: () => {},
      renderTo: () => {},
      viewport: mockStore({ scrollTop: 0, scrollLeft: 0, width: 800, height: 600 }),
      viewMode: mockStore("split"),
    },
    "stargantt.timeline": {
      tToX: (t: number) => t,
      xToT: (x: number) => x,
      pxPerMs: 1,
      setZoomLevel: () => {},
      setOrigin: () => {},
      requestOriginExtension: () => {},
      releaseOriginExtension: () => {},
      levelMetrics: () => [],
      firstDayOfWeek: () => 1,
      unitBoundaries: () => [],
      formatDate: () => "",
      gridCellAt: (t: number) => ({ start: t, end: t + 86_400_000 }),
      zoomLevel: mockStore({ id: "day", pxPerDay: 24, scales: [] }),
    },
    "stargantt.theme": {
      get: () => "",
      audit: () => [],
      setPreset: () => {},
      preset: () => null,
      presets: () => [],
      setColorScheme: () => {},
      colorScheme: () => "auto",
      refresh: () => {},
      tokens: mockStore({}),
    },
  };
}

describe("factory shape", () => {
  it("is a factory, not a plain plugin const", () => {
    expect(typeof treeGrid).toBe("function");
    expect(typeof treeGrid().setup).toBe("function");
  });

  it("accepts an omitted and an empty config alike, producing independent instances", () => {
    const a = treeGrid();
    const b = treeGrid({});
    expect(a).not.toBe(b);
    expect(a.meta.id).toBe("stargantt.tree-grid");
    expect(b.meta.id).toBe("stargantt.tree-grid");
    expect(a.meta.dependsOn).toEqual(["stargantt.data-store", "stargantt.view"]);
  });

  it("snapshots the config, so mutating the caller's object afterwards changes nothing", () => {
    const config: TreeGridConfig = { rowHeight: 40 };
    const plugin = treeGrid(config);
    // Mutated after the factory ran but before the plugin is ever set up.
    config.rowHeight = 90;

    // The declared providers must exist for the host's `dependsOn` resolution; the services
    // themselves come from the mocks. A real (fake) DOM element is supplied because the grid pane
    // creates its inline editor element at setup time.
    const provider = (id: string): AnyPlugin => ({ meta: { id }, setup: () => {} });
    const dom = installDom();
    const host = createTestHost({
      element: asElement(dom.root),
      plugins: [provider("stargantt.data-store"), provider("stargantt.view"), plugin],
      services: mockServices(),
    });
    try {
      expect(host.host.service("stargantt.rows").rowHeight(0)).toBe(40);
    } finally {
      host.dispose();
      dom.restore();
    }
  });
});

describe("rowHeight", () => {
  it("defaults to 28, the previous built-in constant", () => {
    const b = withConfig(undefined, flatTasks(3));
    expect(b.rows.rowHeight(0)).toBe(28);
    expect(b.rows.yOf(2)).toBe(56);
    expect(b.rows.totalHeight()).toBe(84);
  });

  it("replaces the default height everywhere the row geometry uses it", () => {
    const b = withConfig({ rowHeight: 40 }, flatTasks(3));
    expect(b.rows.rowHeight(0)).toBe(40);
    expect(b.rows.yOf(2)).toBe(80);
    expect(b.rows.rowAtY(85)).toBe(2);
    expect(b.rows.totalHeight()).toBe(120);
  });

  it("is the `defaultHeight` handed to `rows/height` contributions", () => {
    const seen: number[] = [];
    const b = boot(
      [
        probe((ctx) =>
          ctx.contribute("rows/height", (_task, defaultHeight) => {
            seen.push(defaultHeight);
            return undefined;
          }),
        ),
      ],
      {},
      { rowHeight: 33 },
    );
    booted = b;
    b.data.load(flatTasks(2));
    b.rows.totalHeight();
    expect(seen.length).toBeGreaterThan(0);
    expect([...new Set(seen)]).toEqual([33]);
  });

  it("still lets a `rows/height` contribution override it per row", () => {
    const b = boot([probe((ctx) => ctx.contribute("rows/height", () => 50))], {}, { rowHeight: 40 });
    booted = b;
    b.data.load(flatTasks(2));
    expect(b.rows.rowHeight(0)).toBe(50);
    expect(b.rows.totalHeight()).toBe(100);
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    "ignores the out-of-range value %s and uses 28",
    (value) => {
      const b = withConfig({ rowHeight: value }, flatTasks(2));
      expect(b.rows.rowHeight(0)).toBe(28);
      expect(b.rows.totalHeight()).toBe(56);
    },
  );
});

describe("paneWidth", () => {
  it("defaults to 580, wide enough for the default column track", () => {
    const b = withConfig(undefined, flatTasks(1));
    expect(b.pane.style["width"]).toBe("580px");
  });

  it("sets the grid pane's initial width", () => {
    const b = withConfig({ paneWidth: 200 }, flatTasks(1));
    expect(b.pane.style["width"]).toBe("200px");
  });

  it.each([0, -5, Number.NaN, Number.POSITIVE_INFINITY])(
    "ignores the out-of-range value %s and uses 580",
    (value) => {
      const b = withConfig({ paneWidth: value }, flatTasks(1));
      expect(b.pane.style["width"]).toBe("580px");
    },
  );
});

// docs/specs/plugins/tree-grid.md § Config — indent widens the toggle gutter and narrows the first
// column's cell by the same amount, so total row width — and every column after the first — stays
// constant across depths. `treeTasks(1, 1)` builds a two-level tree; the built-in `name` column (the
// first column of the default composition) declares `width: 220`.
describe("indent", () => {
  function toggleWidths(b: Booted): (string | undefined)[] {
    return b.visibleRows().map((r) => r.find("sg-grid-toggle")?.style["width"]);
  }
  function firstCellWidths(b: Booted): (string | undefined)[] {
    return b.visibleRows().map((r) => r.findAll("sg-grid-cell")[0]?.style["width"]);
  }

  it("defaults to 16 per level, the previous built-in constant", () => {
    const b = withConfig(undefined, treeTasks(1, 1));
    expect(toggleWidths(b)).toEqual(["24px", "40px"]);
    expect(firstCellWidths(b)).toEqual(["220px", "204px"]);
  });

  it("scales the per-level inset, leaving depth 0 unindented", () => {
    const b = withConfig({ indent: 24 }, treeTasks(1, 1));
    expect(toggleWidths(b)).toEqual(["24px", "48px"]);
    expect(firstCellWidths(b)).toEqual(["220px", "196px"]);
  });

  it("accepts 0 as a legitimate value meaning `do not indent at all`", () => {
    const b = withConfig({ indent: 0 }, treeTasks(1, 1));
    expect(toggleWidths(b)).toEqual(["24px", "24px"]);
    expect(firstCellWidths(b)).toEqual(["220px", "220px"]);
  });

  it.each([-1, Number.NaN, Number.POSITIVE_INFINITY])(
    "ignores the out-of-range value %s and uses 16",
    (value) => {
      const b = withConfig({ indent: value }, treeTasks(1, 1));
      expect(toggleWidths(b)[1]).toBe("40px");
      expect(firstCellWidths(b)[1]).toBe("204px");
    },
  );

  // docs/specs/plugins/tree-grid.md § Config — header parity and the usable minimum: the inset
  // saturates rather than the cell shrinking past its 24 px content box, and the gutter saturates
  // with it so the row's total width still equals the header's.
  it("saturates the tree column's inset on a deep tree", () => {
    // A 20-level chain at the default indent (16) would shrink the 220px name column well below
    // zero without the saturation; the floor is 24 px of content box plus 2 x 8 px of padding. A
    // tall fake viewport keeps every level materialized so the deepest row is actually painted.
    const deep: Partial<Task>[] = [];
    let parent: string | null = null;
    for (let i = 0; i < 20; i += 1) {
      const id = `d${i}`;
      deep.push({ id, parentId: parent, name: id, start: 0, end: 1 });
      parent = id;
    }
    const b = boot([], { height: 700 });
    booted = b;
    b.data.load(deep);
    b.dom.flushFrames();
    const rows = b.visibleRows();
    const deepest = rows[rows.length - 1];
    expect(deepest?.getAttribute("data-row-index")).toBe("19");
    expect(deepest?.findAll("sg-grid-cell")[0]?.style["width"]).toBe("40px");
    // 220 - 40 = 180: the deepest gutter stops there instead of reaching 19 x 16 = 304.
    expect(deepest?.find("sg-grid-toggle")?.style["width"]).toBe("204px");
    for (const row of rows) expectHeaderParity(b, row);
  });

  // docs/specs/plugins/tree-grid.md § Config — the parity invariant across depths, stated on the
  // default composition where every column declares a width.
  it("keeps every column under its own header at every depth", () => {
    const b = withConfig(undefined, treeTasks(2, 2));
    for (const row of b.visibleRows()) expectHeaderParity(b, row);
  });
});

// docs/specs/plugins/tree-grid.md § Config — `readOnly: true` treats every composed column as
// `editable: false`, whatever its own `setValue`, and changes nothing else about the columns.
describe("readOnly", () => {
  it("defaults to false: a `setValue`-bearing column stays editable", () => {
    const b = withConfig(undefined, flatTasks(1));
    b.gantt.dispatch("view/editStart", { id: "t0" });
    expect(b.editor()).toBeDefined();
  });

  it("treats every column as non-editable, whatever its `setValue`", () => {
    const b = withConfig({ readOnly: true }, flatTasks(1));
    b.gantt.dispatch("view/editStart", { id: "t0" });
    expect(b.editor()).toBeUndefined();
  });

  it("leaves headers, widths and rendering untouched", () => {
    const b = withConfig({ readOnly: true }, flatTasks(1));
    const headers = b.header.findAll("sg-grid-cell sg-grid-header-cell");
    expect(headers.map((h) => h.textContent)).toEqual(["Name", "Start", "End", "Progress"]);
    expect(headers.map((h) => h.style["width"])).toEqual(["220px", "110px", "110px", "90px"]);
  });

  it("ignores a non-boolean value and uses the default (false)", () => {
    const b = withConfig({ readOnly: "yes" as unknown as boolean }, flatTasks(1));
    b.gantt.dispatch("view/editStart", { id: "t0" });
    expect(b.editor()).toBeDefined();
  });
});
