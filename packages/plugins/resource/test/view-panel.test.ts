// @vitest-environment happy-dom
/**
 * The resource-view strip's DOM (docs/specs/plugins/resource.md §3.4): the header band, team
 * bands, rows, opaque lanes and the one `pointer-events: none` track; the gutter-hosted name
 * column with the zero-width-gutter in-body fallback; vertical virtualization and horizontal
 * segment culling; the non-color overallocation signals; the `--target` drop mark; and the lane
 * geometry the `drag/lanes` seam answers from.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { resolveMessages } from "../src/internal/messages";
import { buildModel } from "../src/internal/view/model";
import type { RvGroup } from "../src/internal/view/model";
import { createPanelView } from "../src/internal/view/panel";
import type { PanelColumns, PanelContent, PanelView } from "../src/internal/view/panel";

const DAY = 86_400_000;
const T0 = Date.UTC(2024, 0, 1);
const ROW = 28;

const messages = resolveMessages(undefined, () => undefined);

/** A `tToX` of one pixel per day from the epoch anchor — enough to place segments predictably. */
const tToX = (t: number): number => (t - T0) / DAY;

function columns(): PanelColumns & { root: HTMLElement } {
  const root = document.createElement("div");
  const pane = document.createElement("div");
  const gutter = document.createElement("div");
  const body = document.createElement("div");
  const trailing = document.createElement("div");
  pane.append(gutter, body, trailing);
  root.append(pane);
  document.body.append(root);
  return { root, pane, gutter, body, trailing };
}

/** happy-dom reports no layout, so the box a test needs is stubbed explicitly. */
function stubBox(element: HTMLElement, box: { top?: number; height?: number; width?: number }): void {
  const rect = { top: box.top ?? 0, height: box.height ?? 0, width: box.width ?? 0, left: 0 };
  element.getBoundingClientRect = (): DOMRect => rect as unknown as DOMRect;
}

function stubMetric(element: HTMLElement, name: string, value: number): void {
  Object.defineProperty(element, name, { value, configurable: true });
}

function model(spec: {
  tasks?: { id: string; from: number; to: number; project?: string }[];
  assignments?: { taskId: string; resourceId: string; units: number }[];
  roster?: { id: string; name: string; capacity: number }[];
  teams?: { name: string; members: string[] }[];
}): RvGroup[] {
  const tasks = new Map(
    (spec.tasks ?? []).map((t) => [
      t.id,
      {
        id: t.id,
        parentId: null,
        name: t.id,
        start: T0 + t.from * DAY,
        end: T0 + t.to * DAY,
        ...(t.project === undefined ? {} : { meta: { project: t.project } }),
      },
    ]),
  );
  const byTask = new Map<string, { taskId: string; resourceId: string; units: number }[]>();
  for (const a of spec.assignments ?? []) {
    const bucket = byTask.get(a.taskId);
    if (bucket === undefined) byTask.set(a.taskId, [a]);
    else bucket.push(a);
  }
  return buildModel({
    tasks,
    assignmentsByTask: byTask,
    resources: spec.roster ?? [{ id: "a", name: "Ann", capacity: 1 }],
    teams: spec.teams ?? [],
    ungroupedName: "Other resources",
    projectOf: (t) => {
      const value = t.meta?.["project"];
      return typeof value === "string" && value !== "" ? value : null;
    },
  });
}

function content(groups: RvGroup[], over: Partial<PanelContent> = {}): PanelContent {
  return { groups, scrollLeft: 0, tToX, messages, ...over };
}

let panel: PanelView;
let cols: PanelColumns & { root: HTMLElement };

beforeEach(() => {
  document.body.innerHTML = "";
  cols = columns();
  panel = createPanelView({
    root: cols.root,
    metrics: () => ({ rowHeight: ROW, teamHeight: ROW, labelWidth: 160 }),
  });
});

const q = (selector: string): HTMLElement[] => [...cols.pane.querySelectorAll(selector)] as HTMLElement[];

describe("mount (§3.4 — the strip's structure)", () => {
  it("names the strip as a region and carries the title into the header band's text", () => {
    panel.describe("Resource view");
    panel.mount(cols);
    expect(cols.pane.getAttribute("role")).toBe("region");
    expect(cols.pane.getAttribute("aria-label")).toBe("Resource view");
    panel.render(content(model({})));
    expect(q(".sg-resource-view__body > .sg-resource-view__header")[0]?.textContent).toBe(
      "Resource view",
    );
  });

  it("makes the scroll surface keyboard-reachable and ships its scoped stylesheet", () => {
    panel.mount(cols);
    const body = q(".sg-resource-view__body")[0];
    expect(body?.getAttribute("tabindex")).toBe("0");
    const style = cols.pane.querySelector("style");
    expect(style?.textContent).toContain(".sg-resource-view__body:focus-visible");
    // The focus ring is a real 2 px outline, not a colour change.
    expect(style?.textContent).toContain("outline: 2px solid");
  });

  it("hides the presentational name column from assistive tech", () => {
    panel.mount(cols);
    expect(q(".sg-resource-view__names")[0]?.getAttribute("aria-hidden")).toBe("true");
  });

  it("returns the pane exactly as found on dispose", () => {
    panel.describe("Resource view");
    panel.mount(cols);
    panel.render(content(model({})));
    panel.dispose();
    expect(cols.pane.getAttribute("role")).toBeNull();
    expect(cols.pane.getAttribute("aria-label")).toBeNull();
    expect(cols.pane.classList.contains("sg-resource-view")).toBe(false);
    expect(cols.pane.querySelector("style")).toBeNull();
    expect(panel.isMounted()).toBe(false);
  });
});

describe("render (§3.4 — rows, bands and segments)", () => {
  it("stacks the header band, then one row per resource", () => {
    panel.mount(cols);
    panel.render(
      content(
        model({
          roster: [
            { id: "a", name: "Ann", capacity: 1 },
            { id: "b", name: "Bob", capacity: 1 },
          ],
        }),
      ),
    );
    expect(q(".sg-resource-view__row")).toHaveLength(2);
    expect(q(".sg-resource-view__label").map((e) => e.textContent)).toEqual(["Ann", "Bob"]);
  });

  it("paints one team band per configured group, with the summary sentence", () => {
    panel.mount(cols);
    panel.render(
      content(
        model({
          roster: [
            { id: "a", name: "Ann", capacity: 1 },
            { id: "b", name: "Bob", capacity: 1 },
          ],
          teams: [{ name: "Core", members: ["a"] }],
        }),
      ),
    );
    const bands = q(".sg-resource-view__body .sg-resource-view__team");
    expect(bands.map((e) => e.textContent?.split(":")[0])).toEqual(["Core", "Other resources"]);
    expect(bands[0]?.textContent).toContain("1 members");
  });

  it("paints no team band at all for the anonymous group", () => {
    panel.mount(cols);
    panel.render(content(model({})));
    expect(q(".sg-resource-view__team")).toHaveLength(0);
  });

  it("places a segment at its tToX minus the scroll, with a 2 px width floor", () => {
    panel.mount(cols);
    panel.render(
      content(
        model({
          tasks: [
            { id: "t1", from: 10, to: 20 },
            { id: "tiny", from: 30, to: 30.0001 },
          ],
          assignments: [
            { taskId: "t1", resourceId: "a", units: 1 },
            { taskId: "tiny", resourceId: "a", units: 1 },
          ],
        }),
        { scrollLeft: 4 },
      ),
    );
    const segs = q(".sg-resource-view__seg");
    expect(segs[0]?.style.left).toBe("6px");
    expect(segs[0]?.style.width).toBe("10px");
    expect(segs[1]?.style.width).toBe("2px");
  });

  it("keeps the track pointer-transparent and clipped by an opaque lane", () => {
    panel.mount(cols);
    panel.render(content(model({})));
    const style = cols.pane.querySelector("style")?.textContent ?? "";
    expect(style).toContain(".sg-resource-view__track {\n  pointer-events: none;\n}");
    expect(q(".sg-resource-view__lane")[0]?.style.overflow).toBe("hidden");
  });

  it("omits every segment while no timeline is composed, but still paints the rows", () => {
    panel.mount(cols);
    panel.render(
      content(
        model({
          tasks: [{ id: "t1", from: 0, to: 5 }],
          assignments: [{ taskId: "t1", resourceId: "a", units: 1 }],
        }),
        { tToX: null },
      ),
    );
    expect(q(".sg-resource-view__row")).toHaveLength(1);
    expect(q(".sg-resource-view__seg")).toHaveLength(0);
  });

  it("carries the segment label into the text and the title, so a clipped segment stays readable", () => {
    panel.mount(cols);
    panel.render(
      content(
        model({
          tasks: [{ id: "t1", from: 0, to: 5, project: "Apollo" }],
          assignments: [{ taskId: "t1", resourceId: "a", units: 0.5 }],
        }),
      ),
    );
    const seg = q(".sg-resource-view__seg")[0];
    expect(seg?.textContent).toBe("t1 50% [Apollo]");
    expect(seg?.title).toBe("t1 50% [Apollo]");
  });
});

describe("overallocation (§3.4 — never colour alone)", () => {
  beforeEach(() => {
    panel.mount(cols);
    panel.render(
      content(
        model({
          tasks: [
            { id: "t1", from: 0, to: 10 },
            { id: "t2", from: 4, to: 8 },
          ],
          assignments: [
            { taskId: "t1", resourceId: "a", units: 1 },
            { taskId: "t2", resourceId: "a", units: 1 },
          ],
        }),
      ),
    );
  });

  it("marks the row with a modifier class AND a data attribute", () => {
    const row = q(".sg-resource-view__row")[0];
    expect(row?.classList.contains("sg-resource-view__row--over")).toBe(true);
    expect(row?.getAttribute("data-over")).toBe("true");
  });

  it("says so in the row label's own text", () => {
    const label = q(".sg-resource-view__label")[0];
    expect(label?.textContent).toBe("Ann (overallocated)");
    expect(label?.getAttribute("data-over")).toBe("true");
    expect(label?.classList.contains("sg-resource-view__label--over")).toBe(true);
  });

  it("marks the overlapping segments and says so in their text too", () => {
    const segs = q(".sg-resource-view__seg");
    expect(segs).toHaveLength(2);
    for (const seg of segs) {
      expect(seg.getAttribute("data-over")).toBe("true");
      expect(seg.textContent).toContain("(over)");
    }
  });
});

describe("the name column (§3.4 — gutter, with the zero-width in-body fallback)", () => {
  it("puts the names in the gutter and lets the lane fill the body when the gutter has width", () => {
    stubBox(cols.gutter, { width: 200 });
    panel.mount(cols);
    panel.render(content(model({})));
    const names = q(".sg-resource-view__names")[0];
    expect(names?.querySelectorAll(".sg-resource-view__label")).toHaveLength(1);
    expect(q(".sg-resource-view__lane")[0]?.style.left).toBe("0px");
    expect(q(".sg-resource-view__track")[0]?.style.left).toBe("0px");
  });

  it("falls back to an in-body column of --sg-rv-label-width when the gutter is zero-width", () => {
    panel.mount(cols);
    panel.render(content(model({})));
    const names = q(".sg-resource-view__names")[0];
    expect(names?.querySelectorAll(".sg-resource-view__label")).toHaveLength(0);
    const label = q(".sg-resource-view__row .sg-resource-view__label")[0];
    expect(label?.style.width).toBe("160px");
    // The lane starts after the names, and the track cancels the offset so a segment's x is a
    // chart-pane x either way.
    expect(q(".sg-resource-view__lane")[0]?.style.left).toBe("160px");
    expect(q(".sg-resource-view__track")[0]?.style.left).toBe("-160px");
  });
});

describe("virtualization (§3.4 — cull the DOM, never the geometry)", () => {
  const roster = Array.from({ length: 50 }, (_, i) => ({
    id: `r${String(i)}`,
    name: `R${String(i)}`,
    capacity: 1,
  }));

  it("renders every row when the environment reports no layout", () => {
    panel.mount(cols);
    panel.render(content(model({ roster })));
    expect(q(".sg-resource-view__row")).toHaveLength(50);
    expect(q(".sg-resource-view__spacer")).toHaveLength(0);
  });

  it("replaces off-window rows with spacers while keeping every lane in the geometry", () => {
    panel.mount(cols);
    const body = q(".sg-resource-view__body")[0] as HTMLElement;
    stubMetric(body, "clientHeight", 5 * ROW);
    stubBox(body, { top: 0, height: 5 * ROW });
    panel.render(content(model({ roster })));
    const rows = q(".sg-resource-view__row");
    // Header (28) + a 5-row window + two rows of overscan on each side, so far fewer than 50.
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.length).toBeLessThan(20);
    expect(q(".sg-resource-view__spacer").length).toBeGreaterThan(0);
    // The seam still knows every row: the last one answers even though it has no element.
    const last = panel.laneOf("r49");
    expect(last).toEqual({ resourceId: "r49", y: ROW + 49 * ROW, height: ROW });
  });

  it("culls segments outside the body's own width by start and by end", () => {
    panel.mount(cols);
    const body = q(".sg-resource-view__body")[0] as HTMLElement;
    stubMetric(body, "clientWidth", 100);
    panel.render(
      content(
        model({
          tasks: [
            { id: "before", from: -50, to: -10 },
            { id: "visible", from: 10, to: 20 },
            { id: "after", from: 200, to: 300 },
          ],
          assignments: [
            { taskId: "before", resourceId: "a", units: 1 },
            { taskId: "visible", resourceId: "a", units: 1 },
            { taskId: "after", resourceId: "a", units: 1 },
          ],
        }),
      ),
    );
    expect(q(".sg-resource-view__seg").map((e) => e.textContent)).toEqual(["visible"]);
  });
});

describe("the lane seam (§3.4 / §4.2)", () => {
  function paintThree(): void {
    panel.mount(cols);
    const body = q(".sg-resource-view__body")[0] as HTMLElement;
    stubBox(body, { top: 100, height: 200 });
    stubBox(cols.root, { top: 0, height: 500 });
    panel.render(
      content(
        model({
          roster: [
            { id: "a", name: "Ann", capacity: 1 },
            { id: "b", name: "Bob", capacity: 1 },
            { id: "c", name: "Cid", capacity: 1 },
          ],
        }),
      ),
    );
  }

  it("answers undefined before anything is painted", () => {
    panel.mount(cols);
    stubBox(q(".sg-resource-view__body")[0] as HTMLElement, { top: 100, height: 200 });
    expect(panel.laneAt(150)).toBeUndefined();
  });

  it("names the lane under a root-relative y, past the header band", () => {
    paintThree();
    expect(panel.laneAt(100 + 10)).toBeUndefined(); // the header band is a gap
    expect(panel.laneAt(100 + ROW)).toEqual({ resourceId: "a", y: 128, height: ROW });
    expect(panel.laneAt(100 + 2 * ROW)?.resourceId).toBe("b");
  });

  it("forgets its geometry on clear, so a released strip names no lane", () => {
    paintThree();
    panel.clear();
    expect(panel.laneAt(100 + ROW)).toBeUndefined();
    expect(panel.laneOf("a")).toBeUndefined();
    expect(q(".sg-resource-view__row")).toHaveLength(0);
  });

  it("marks the drop target with a class AND a data attribute on both stacks", () => {
    stubBox(cols.gutter, { width: 200 });
    paintThree();
    panel.highlight("b");
    const marked = q("[data-target]");
    expect(marked).toHaveLength(2); // the row and its gutter-hosted label
    expect(marked.some((e) => e.classList.contains("sg-resource-view__row--target"))).toBe(true);
    expect(marked.some((e) => e.classList.contains("sg-resource-view__label--target"))).toBe(true);
  });

  it("clears the mark with null and with an id no row carries", () => {
    paintThree();
    panel.highlight("b");
    panel.highlight(null);
    expect(q("[data-target]")).toHaveLength(0);
    panel.highlight("b");
    panel.highlight("nobody");
    expect(q("[data-target]")).toHaveLength(0);
  });

  it("survives a repaint: the mark is re-applied to the rebuilt elements", () => {
    paintThree();
    panel.highlight("c");
    panel.render(
      content(
        model({
          roster: [
            { id: "a", name: "Ann", capacity: 1 },
            { id: "b", name: "Bob", capacity: 1 },
            { id: "c", name: "Cid", capacity: 1 },
          ],
        }),
      ),
    );
    expect(q("[data-target]").length).toBeGreaterThan(0);
    expect(q(`[data-sg-resource="c"][data-target]`)).toHaveLength(1);
  });
});
