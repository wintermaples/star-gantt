// @vitest-environment happy-dom
// Covers the "bulk-update panel (hostless)" behavior of this area's `bulk-panel.ts` (built on
// `sdk/dialog`'s `createDialog`), using real happy-dom elements.
import { describe, expect, it } from "vitest";
import type { TaskId } from "@stargantt/plugin-data-store";
import { resolveMessages } from "../src/internal/messages";
import { createBulkPanel } from "../src/internal/progress/bulk-panel";
import type { BulkEdit, BulkRow } from "../src/internal/progress/bulk-panel";

const MS_DAY = 86_400_000;
const MS_HOUR = 3_600_000;
const MS_MINUTE = 60_000;
const MS_SECOND = 1_000;
const DEFAULT_MESSAGES = resolveMessages(undefined, () => undefined);

function mountBulk(
  rows: readonly BulkRow[] = [
    { id: "a", name: "Task A", progressPct: 20, remainingWork: 10 * MS_HOUR },
    { id: "b", name: "Task B", progressPct: undefined, remainingWork: undefined },
  ],
) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const applied: BulkEdit[][] = [];
  let closed = 0;
  const panel = createBulkPanel(host, rows, DEFAULT_MESSAGES, {
    apply: (edits) => void applied.push([...edits]),
    close: () => void (closed += 1),
  });
  const root = panel.root;
  // Children: header, body(table), grip (resizable: true), footer (lazy getter, appended last).
  const body = root.children[1] as HTMLElement;
  const table = body.children[0] as HTMLElement;
  const input = (row: number, column: 0 | 1): HTMLInputElement => {
    const line = table.children[row + 1] as HTMLElement;
    const cell = line.children[column + 1] as HTMLElement;
    return cell.children[0] as HTMLInputElement;
  };
  const footer = root.children[3] as HTMLElement;
  const cancel = footer.children[0] as HTMLButtonElement;
  const apply = footer.children[1] as HTMLButtonElement;
  return { panel, root, table, input, cancel, apply, applied, closedCount: () => closed };
}

describe("bulk-update panel (hostless)", () => {
  it("labels itself and pre-fills current values", () => {
    const p = mountBulk();
    expect(p.root.getAttribute("role")).toBe("dialog");
    expect(p.root.getAttribute("aria-label")).toBe("Update progress");
    expect(p.input(0, 0).value).toBe("20");
    expect(p.input(0, 1).getAttribute("type")).toBe("text");
    expect(p.input(0, 1).value).toBe("10h");
    expect(p.input(1, 0).value).toBe("");
    expect(p.input(1, 1).value).toBe("");
  });

  it("Apply gathers only changed, parsable, in-range values", () => {
    const p = mountBulk();
    p.input(0, 0).value = "55";
    p.input(0, 1).value = "10h"; // echoed value, re-entered unchanged
    p.input(1, 0).value = "junk";
    p.input(1, 1).value = "4"; // bare number means days
    p.apply.click();
    expect(p.applied).toEqual([[{ id: "a", progressPct: 55 }, { id: "b", remainingWork: 4 * MS_DAY }]]);
    expect(p.closedCount()).toBe(1);
  });

  it("parses every unit-suffixed form the grammar accepts", () => {
    for (const [entry, expected] of [
      ["2", 2 * MS_DAY],
      ["1.5d", 1.5 * MS_DAY],
      ["4 h", 4 * MS_HOUR],
      ["90m", 90 * MS_MINUTE],
      ["12s", 12 * MS_SECOND],
    ] as const) {
      const p = mountBulk();
      p.input(1, 1).value = entry;
      p.apply.click();
      expect(p.applied).toEqual([[{ id: "b", remainingWork: expected }]]);
    }
  });

  it("leaves the stored value untouched when the entry does not parse", () => {
    for (const entry of ["junk", "1.5w", "d", "1 2d", ""]) {
      const p = mountBulk();
      p.input(0, 1).value = entry;
      p.apply.click();
      expect(p.applied).toEqual([[]]);
    }
  });

  it("reports no edit for an untouched field whose stored value the display rounds", () => {
    const p = mountBulk([{ id: "a", name: "Task A", progressPct: 20, remainingWork: 12_000_000 }]);
    expect(p.input(0, 1).value).toBe("3.3h");
    p.apply.click();
    expect(p.applied).toEqual([[]]);
  });

  it("still gathers a genuine edit on a row whose display rounds", () => {
    const p = mountBulk([{ id: "a", name: "Task A", progressPct: 20, remainingWork: 12_000_000 }]);
    p.input(0, 1).value = "4h";
    p.apply.click();
    expect(p.applied).toEqual([[{ id: "a", remainingWork: 4 * MS_HOUR }]]);
  });

  it("rejects out-of-range progress and negative remaining work", () => {
    const p = mountBulk();
    p.input(0, 0).value = "150";
    p.input(0, 1).value = "-3";
    p.apply.click();
    expect(p.applied).toEqual([[]]);
  });

  it("Cancel closes without applying", () => {
    const p = mountBulk();
    p.input(0, 0).value = "99";
    p.cancel.click();
    expect(p.applied).toEqual([]);
    expect(p.closedCount()).toBe(1);
  });

  it("Escape closes without applying (the shared dialog's own containment)", () => {
    const p = mountBulk();
    p.root.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(p.applied).toEqual([]);
    expect(p.closedCount()).toBe(1);
  });

  it("labels every input with the task name and column (accessible name)", () => {
    const p = mountBulk();
    expect(p.input(0, 0).getAttribute("aria-label")).toBe("Task A — Progress %");
    expect(p.input(0, 1).getAttribute("aria-label")).toBe("Task A — Remaining work");
  });

  it("lists every task, parents included (an editing surface, not an aggregate)", () => {
    const rows: BulkRow[] = [
      { id: "p" as TaskId, name: "Parent", progressPct: 50, remainingWork: undefined },
      { id: "c" as TaskId, name: "Child", progressPct: 100, remainingWork: undefined },
    ];
    const p = mountBulk(rows);
    // Header row plus one row per task.
    expect(p.table.children).toHaveLength(3);
  });

  it("dispose removes the panel DOM and its listeners", () => {
    const p = mountBulk();
    p.panel.dispose();
    expect(p.root.isConnected).toBe(false);
    // Idempotent.
    expect(() => p.panel.dispose()).not.toThrow();
  });
});
