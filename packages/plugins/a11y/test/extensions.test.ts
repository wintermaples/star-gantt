// @vitest-environment happy-dom
// docs/specs/plugins/a11y.md — the four opt-in features (dependency read-out, shortcut help,
// keyboard zoom, summary table) and the mirror's slot pool.
import { afterEach, describe, expect, it } from "vitest";
import type { Link } from "@stargantt/plugin-data-store";
import { listShortcuts } from "../src/internal/shortcut-help";
import { SUMMARY_ROW_CAP, allTaskIdsInTreeOrder } from "../src/internal/summary-table";
import { boot, flatTasks, treeTasks } from "./_boot";
import type { Booted } from "./_boot";

let booted: Booted | undefined;

afterEach(() => {
  booted?.dispose();
  booted = undefined;
});

/** Three flat tasks t0 → t1 → t2 linked FS, so t1 both depends and blocks. */
const LINKS: Link[] = [
  { id: "l0", sourceId: "t0", targetId: "t1", type: "FS" },
  { id: "l1", sourceId: "t1", targetId: "t2", type: "FS" },
];

function open(options: Parameters<typeof boot>[0] = {}): Booted {
  const b = boot(options);
  booted = b;
  b.flushFrames();
  return b;
}

/** The description node a row's `aria-describedby` points at. */
function descriptionOf(b: Booted, index: number): string | undefined {
  const id = b.rows()[index]?.getAttribute("aria-describedby");
  if (id === null || id === undefined) return undefined;
  return b.root.querySelector(`#${id}`)?.textContent ?? undefined;
}

describe("dependency read-out (`describeDependencies`)", () => {
  it("is off by default: no description container, no aria-describedby", () => {
    const b = open({ tasks: flatTasks(3), links: LINKS });
    expect(b.root.querySelector(".sg-a11y-desc")).toBeNull();
    for (const row of b.rows()) expect(row.getAttribute("aria-describedby")).toBeNull();
  });

  it("links each dependent row to a description naming both link directions", () => {
    const b = open({ tasks: flatTasks(3), links: LINKS, config: { describeDependencies: true } });
    expect(descriptionOf(b, 0)).toBe("Blocks: t1");
    expect(descriptionOf(b, 1)).toBe("Depends on: t0. Blocks: t2");
    expect(descriptionOf(b, 2)).toBe("Depends on: t1");
  });

  it("keeps the description nodes out of the treegrid rows, in their own hidden container", () => {
    const b = open({ tasks: flatTasks(3), links: LINKS, config: { describeDependencies: true } });
    const container = b.root.querySelector(".sg-a11y-desc") as HTMLElement | null;
    expect(container).not.toBeNull();
    expect(container?.style.position).toBe("absolute");
    expect(b.mirror.contains(container)).toBe(false);
    expect(container?.querySelectorAll(".sg-a11y-desc-item").length).toBeGreaterThan(0);
  });

  it("leaves rows without links unmarked, and clears a stale description on data change", () => {
    const b = open({ tasks: flatTasks(3), links: LINKS, config: { describeDependencies: true } });
    b.data.setLinks([]);
    b.flushFrames();
    for (const row of b.rows()) expect(row.getAttribute("aria-describedby")).toBeNull();
  });

  it("uses the `rowDependencies` catalog member for the wording", () => {
    const b = open({
      tasks: flatTasks(3),
      links: LINKS,
      config: {
        describeDependencies: true,
        messages: { rowDependencies: (p) => `after ${p.predecessors.join("/")}` },
      },
    });
    expect(descriptionOf(b, 1)).toBe("after t0");
  });
});

describe("shortcut-help dialog (`shortcutHelp`)", () => {
  it("is off by default: `?` opens nothing and is not claimed", () => {
    const b = open({ tasks: flatTasks(3) });
    expect(b.key("?", { shift: true })).toBe(false);
    expect(b.root.querySelector(".sg-a11y-help")).toBeNull();
  });

  it("opens a modal dialog listing the described bindings, and closes on Escape", () => {
    const b = open({ tasks: flatTasks(3), config: { shortcutHelp: true } });
    expect(b.key("?", { shift: true })).toBe(true);
    const dialog = b.root.querySelector(".sg-a11y-help");
    expect(dialog).not.toBeNull();
    expect(dialog?.getAttribute("role")).toBe("dialog");
    expect(dialog?.getAttribute("aria-modal")).toBe("true");
    expect(dialog?.getAttribute("aria-label")).toBe("Keyboard shortcuts");
    const texts = [...(dialog?.querySelectorAll(".sg-a11y-help-text") ?? [])].map(
      (n) => n.textContent,
    );
    expect(texts).toContain("Move focus down");
    expect(texts).toContain("Show keyboard shortcuts");
    expect(b.key("Escape")).toBe(true);
    expect(b.root.querySelector(".sg-a11y-help")).toBeNull();
  });

  it("keeps chart bindings inert while open — arrows scroll natively, focus does not move", () => {
    const b = open({ tasks: flatTasks(3), config: { shortcutHelp: true } });
    b.key("ArrowDown"); // place the focus on a real row first
    const before = b.focus.state.get().focused;
    b.key("?", { shift: true });
    // A scroll key is left to the browser (not prevented) so the dialog body can scroll natively,
    // but the chart binding behind the modal still never runs.
    expect(b.key("ArrowDown")).toBe(false);
    expect(b.focus.state.get().focused).toBe(before);
    // A plain non-dialog key is swallowed outright.
    expect(b.key("z")).toBe(true);
    b.key("?", { shift: true }); // `?` toggles it closed again
    expect(b.root.querySelector(".sg-a11y-help")).toBeNull();
  });

  it("passes modifier chords to the browser un-prevented while open", () => {
    const b = open({ tasks: flatTasks(3), config: { shortcutHelp: true } });
    b.key("ArrowDown");
    const before = b.focus.state.get().focused;
    b.key("?", { shift: true });
    expect(b.root.querySelector(".sg-a11y-help")).not.toBeNull();
    // Ctrl+'+' (page zoom) is neither claimed nor prevented…
    expect(b.key("+", { ctrl: true })).toBe(false);
    expect(b.key("-", { ctrl: true })).toBe(false);
    expect(b.key("f", { ctrl: true })).toBe(false);
    // …the dialog stays open, no chart binding ran, and Escape still closes it.
    expect(b.root.querySelector(".sg-a11y-help")).not.toBeNull();
    expect(b.focus.state.get().focused).toBe(before);
    expect(b.key("Escape")).toBe(true);
    expect(b.root.querySelector(".sg-a11y-help")).toBeNull();
  });

  it("cycles the focus between the panel and its close button on Tab / Shift+Tab", () => {
    const b = open({ tasks: flatTasks(3), config: { shortcutHelp: true } });
    b.key("?", { shift: true });
    const dialog = b.root.querySelector(".sg-a11y-help");
    const closeButton = b.root.querySelector(".sg-a11y-help-close");
    expect(dialog).not.toBeNull();
    expect(closeButton).not.toBeNull();
    expect(b.doc.activeElement).toBe(dialog);
    expect(b.key("Tab")).toBe(true);
    expect(b.doc.activeElement).toBe(closeButton);
    // Wrapping keeps the focus inside: forward from the last element returns to the panel.
    b.key("Tab");
    expect(b.doc.activeElement).toBe(dialog);
    b.key("Tab", { shift: true });
    expect(b.doc.activeElement).toBe(closeButton);
    // Tab neither closed the dialog nor reached a chart shortcut behind it.
    expect(b.root.querySelector(".sg-a11y-help")).not.toBeNull();
  });

  it("gives the close button an accessible name and a ≥24×24 px hit area", () => {
    const b = open({ tasks: flatTasks(3), config: { shortcutHelp: true } });
    b.key("?", { shift: true });
    const closeButton = b.root.querySelector(".sg-a11y-help-close") as HTMLElement | null;
    expect(closeButton?.getAttribute("aria-label")).toBe("Close");
    expect(closeButton?.style.minWidth).toBe("24px");
    expect(closeButton?.style.minHeight).toBe("24px");
  });

  it("restores the focus to where it sat before the dialog took it", () => {
    const b = open({ tasks: flatTasks(3), config: { shortcutHelp: true } });
    const outside = b.doc.createElement("button");
    b.root.appendChild(outside);
    outside.focus();
    b.key("?", { shift: true });
    expect(b.doc.activeElement).not.toBe(outside);
    b.key("Escape");
    expect(b.doc.activeElement).toBe(outside);
    outside.remove();
  });

  it("lists the dispatcher's winner per chord (last contribution wins)", () => {
    const list = listShortcuts([
      { key: "ArrowDown", description: "old", run: () => {} },
      { key: "Ctrl+Z", description: "Undo", run: () => {} },
      { key: "ArrowDown", description: "new", run: () => {} },
      { key: "Home", run: () => {} }, // undescribed: not listed
    ]);
    expect(list).toEqual([
      { key: "Ctrl+Z", description: "Undo" },
      { key: "ArrowDown", description: "new" },
    ]);
  });

  it("does not resurrect a shadowed description when the winner is undescribed", () => {
    const list = listShortcuts([
      { key: "Enter", description: "Edit", run: () => {} },
      { key: "Enter", run: () => {} },
    ]);
    expect(list).toEqual([]);
  });
});

// docs/specs/plugins/a11y.md § Keyboard zoom — the chords dispatch the view plugin's own
// `timeline/zoomIn` / `timeline/zoomOut` commands directly, which is a strictly downward edge and
// walks the full composed ladder.
describe("keyboard zoom (`zoomKeys`)", () => {
  it("is off by default: `+` still expands the focused row", () => {
    const b = open({ tasks: treeTasks() });
    b.key("+");
    expect(b.view.zoomSteps).toEqual([]);
  });

  it("steps the ladder through the view's commands and announces the resulting level", () => {
    const b = open({ tasks: flatTasks(3), config: { zoomKeys: true } });
    expect(b.key("+")).toBe(true);
    expect(b.view.zoomSteps).toEqual(["in"]);
    expect(b.live.textContent).toBe("Zoom: hour");
    expect(b.key("-")).toBe(true);
    expect(b.view.zoomSteps).toEqual(["in", "out"]);
    expect(b.live.textContent).toBe("Zoom: week");
  });

  // The chords are the plain keys, so the browser's own Ctrl+`+` / Ctrl+`-` page zoom (WCAG 1.4.4)
  // is never claimed or prevented.
  it("leaves Ctrl+`+` / Ctrl+`-` to the browser", () => {
    const b = open({ tasks: flatTasks(3), config: { zoomKeys: true } });
    expect(b.key("+", { ctrl: true })).toBe(false);
    expect(b.key("-", { ctrl: true })).toBe(false);
    expect(b.view.zoomSteps).toEqual([]);
  });

  // While the zoom chords are on they shadow the `+` / `-` expand-collapse aliases; the APG arrow
  // keys keep expand/collapse reachable, which is what keeps WCAG 2.1.1 satisfied.
  it("shadows +/- expand-collapse, which stays available on the arrow keys", () => {
    const b = open({ tasks: treeTasks(), config: { zoomKeys: true } });
    b.focus.focus("a");
    b.key("-");
    expect(b.grid.service.isExpanded("a")).toBe(true); // the keystroke zoomed instead of collapsing
    expect(b.view.zoomSteps).toEqual(["out"]);
    b.key("ArrowLeft");
    b.flushFrames();
    expect(b.grid.service.isExpanded("a")).toBe(false);
  });

  // The chords never stand down for a missing zoom-controls plugin, because the ladder they walk
  // is the view's own.
  it("is always active while enabled — the chords never fall back to expand/collapse", () => {
    const b = open({ tasks: treeTasks(), config: { zoomKeys: true } });
    b.focus.focus("a");
    expect(b.key("-")).toBe(true);
    expect(b.view.zoomSteps).toEqual(["out"]);
    expect(b.grid.toggles).toEqual([]);
  });
});

describe("screen-reader summary table (`summaryTable`)", () => {
  it("is off by default: the chord is not bound", () => {
    const b = open({ tasks: flatTasks(3) });
    expect(b.key("s", { ctrl: true, alt: true })).toBe(false);
    expect(b.root.querySelector(".sg-a11y-summary")).toBeNull();
  });

  it("builds the full task table on demand, collapsed branches included, and Escape removes it", () => {
    const b = open({ tasks: treeTasks(), config: { summaryTable: true } });
    // Collapse the parent with the keyboard, so the summary provably covers more than the visible
    // rows.
    b.focus.focus("a");
    b.key("-");
    b.flushFrames();
    expect(b.key("s", { ctrl: true, alt: true })).toBe(true);
    const wrap = b.root.querySelector(".sg-a11y-summary") as HTMLElement | null;
    expect(wrap).not.toBeNull();
    expect(wrap?.textContent).toContain("Gantt chart summary, 4 tasks");
    expect(wrap?.textContent).toContain("Name");
    // Every task appears even though the children's rows are collapsed away.
    expect(wrap?.textContent).toContain("a1");
    expect(wrap?.textContent).toContain("a2");
    expect(wrap?.textContent).toContain("1970-01-01");
    // Four `scope="col"` headers, one table, hidden but in the accessibility tree.
    expect(wrap?.querySelectorAll("th[scope='col']").length).toBe(4);
    expect(wrap?.style.position).toBe("absolute");
    expect(b.key("Escape")).toBe(true);
    expect(b.root.querySelector(".sg-a11y-summary")).toBeNull();
  });

  it("toggles closed on the same chord", () => {
    const b = open({ tasks: flatTasks(2), config: { summaryTable: true } });
    b.key("s", { ctrl: true, alt: true });
    expect(b.root.querySelector(".sg-a11y-summary")).not.toBeNull();
    b.key("s", { ctrl: true, alt: true });
    expect(b.root.querySelector(".sg-a11y-summary")).toBeNull();
  });

  it("leaves Escape to fall through while the table is closed", () => {
    const b = open({ tasks: flatTasks(2), config: { summaryTable: true } });
    expect(b.key("Escape")).toBe(false);
  });

  it("caps the table and says so in the caption", () => {
    const b = open({ tasks: flatTasks(SUMMARY_ROW_CAP + 5), config: { summaryTable: true } });
    b.key("s", { ctrl: true, alt: true });
    const wrap = b.root.querySelector(".sg-a11y-summary");
    expect(wrap?.textContent).toContain(
      `Gantt chart summary, first ${SUMMARY_ROW_CAP} of ${SUMMARY_ROW_CAP + 5} tasks`,
    );
    expect(wrap?.querySelectorAll("tbody tr").length).toBe(SUMMARY_ROW_CAP);
  });

  it("walks the tree depth-first, children under their parent", () => {
    const children = new Map<string | null, readonly string[]>([
      [null, ["a", "b"]],
      ["a", ["a1", "a2"]],
      ["a1", ["a1x"]],
    ]);
    expect(allTaskIdsInTreeOrder(children)).toEqual(["a", "a1", "a1x", "a2", "b"]);
  });
});

describe("mirror slot pool", () => {
  it("reuses released row elements when the window regrows", () => {
    const b = open({ tasks: flatTasks(50) });
    const before = b.rows();
    expect(before.length).toBeGreaterThan(3);
    // Shrink the list far below the window, then regrow it: the rebuilt rows must reuse the
    // released elements rather than allocating fresh ones.
    b.data.setTasks(flatTasks(2));
    b.flushFrames();
    const shrunk = b.rows();
    expect(shrunk.length).toBeLessThan(before.length);
    b.data.setTasks(flatTasks(50));
    b.flushFrames();
    const regrown = b.rows();
    expect(regrown.length).toBe(before.length);
    const reused = regrown.filter((row) => before.includes(row));
    expect(reused.length).toBe(regrown.length);
    // And the reused rows carry fresh state, not the pooled leftovers.
    expect(regrown.map((r) => Number(r.getAttribute("aria-rowindex")))).toEqual(
      regrown.map((_, i) => i + 1),
    );
  });
});
