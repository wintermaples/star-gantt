// @vitest-environment happy-dom
// docs/specs/plugins/export.md §1.5 (validation, diff). `validate`/`diff` are not public
// (§1's fold map); exercised here as the pure internal functions against a real store view.
import { afterEach, describe, expect, it } from "vitest";
import { diffDocument, orderAddsParentsFirst } from "../src/internal/formats/diff";
import { validateDocument } from "../src/internal/formats/validate";
import type { ImportDocument } from "../src/types";
import { boot, DAY, sampleData } from "./_boot";
import type { Booted } from "./_boot";

let booted: Booted | undefined;
afterEach(() => {
  booted?.dispose();
  booted = undefined;
});

function docOf(partial: Partial<ImportDocument>): ImportDocument {
  return { format: "json", tasks: [], links: [], resources: [], assignments: [], issues: [], ...partial };
}

const t = (id: string, parentId: string | null, name: string, day: number, days: number) => ({
  id,
  parentId,
  name,
  start: day * DAY,
  end: (day + days) * DAY,
});

describe("validateDocument", () => {
  it("accepts a clean document (parents may live in the store)", () => {
    const { tasks } = sampleData();
    booted = boot({ tasks });
    const doc = docOf({ tasks: [t("new1", "a", "Under existing summary", 0, 1)] });
    expect(validateDocument(doc, booted.data.query())).toEqual([]);
  });

  it("flags unknown parents, parent cycles and dangling link ends", () => {
    booted = boot();
    const doc = docOf({
      tasks: [t("p1", "ghost", "Orphan", 0, 1), t("c1", "c2", "Loop A", 0, 1), t("c2", "c1", "Loop B", 0, 1)],
      links: [{ id: "l1", sourceId: "p1", targetId: "nowhere", type: "FS" }],
    });
    const issues = validateDocument(doc, booted.data.query());
    expect(issues).toContainEqual({ code: "unknown-parent", taskId: "p1", parentId: "ghost" });
    expect(issues.filter((i) => i.code === "parent-cycle")).toHaveLength(1);
    expect(issues).toContainEqual({ code: "unknown-link-end", linkId: "l1", taskId: "nowhere" });
  });

  it("detects dependency cycles, including ones closed through existing store links", () => {
    const { tasks } = sampleData();
    booted = boot({ tasks });
    const doc = docOf({
      tasks: [t("x", null, "X", 0, 1), t("y", null, "Y", 0, 1)],
      links: [
        { id: "l1", sourceId: "x", targetId: "y", type: "FS" },
        { id: "l2", sourceId: "y", targetId: "x", type: "FS" },
      ],
    });
    const issues = validateDocument(doc, booted.data.query());
    const cycle = issues.find((i) => i.code === "dependency-cycle");
    expect(cycle).toBeDefined();
    if (cycle?.code === "dependency-cycle") expect(new Set(cycle.taskIds)).toEqual(new Set(["x", "y"]));

    booted.dispatch("link/add", { sourceId: "a1", targetId: "a2", type: "FS" });
    const half = docOf({ tasks: [], links: [{ id: "l3", sourceId: "a2", targetId: "a1", type: "FS" }] });
    expect(validateDocument(half, booted.data.query()).map((i) => i.code)).toContain("dependency-cycle");
  });

  it("survives a 20k-task linear link chain without overflowing the call stack", () => {
    booted = boot();
    const N = 20_000;
    const tasks = [];
    const links = [];
    for (let i = 0; i < N; i++) {
      tasks.push(t(`n${i}`, null, `N${i}`, 0, 1));
      if (i > 0) links.push({ id: `l${i}`, sourceId: `n${i - 1}`, targetId: `n${i}`, type: "FS" as const });
    }
    links.push({ id: "loop", sourceId: `n${N - 1}`, targetId: "n0", type: "FS" as const });
    const issues = validateDocument(docOf({ tasks, links }), booted.data.query());
    expect(issues.filter((i) => i.code === "dependency-cycle")).toHaveLength(1);
  });
});

describe("diffDocument", () => {
  it("classifies adds, field-level updates and (opt-in) removes", () => {
    const { tasks } = sampleData();
    booted = boot({ tasks });
    const doc = docOf({
      tasks: [
        t("a1", "a", "Wireframes", 0, 4), // end moved: update
        { ...t("a2", "a", 'Visual, "final" design', 3, 5), progress: 0.4 }, // identical: no change
        t("brandNew", null, "Brand new", 20, 2), // add
      ],
    });
    expect(diffDocument(doc, booted.data.query())).toEqual([
      { kind: "add", task: t("brandNew", null, "Brand new", 20, 2) },
      { kind: "update", id: "a1", before: { end: 3 * DAY }, after: { end: 4 * DAY } },
    ]);
    const withRemoves = diffDocument(doc, booted.data.query(), { removeMissing: true });
    expect(withRemoves.filter((c) => c.kind === "remove").map((c) => (c.kind === "remove" ? c.id : ""))).toEqual([
      "a",
      "m1",
    ]);
  });

  it("does not treat an absent optional field as a clear", () => {
    const { tasks } = sampleData();
    booted = boot({ tasks });
    // a1 has progress 1 in the store; the incoming task states no progress.
    const doc = docOf({ tasks: [t("a1", "a", "Wireframes", 0, 3)] });
    expect(diffDocument(doc, booted.data.query())).toEqual([]);
  });

  it("a CSV without a parent column proposes no re-parenting of an existing hierarchy", () => {
    const { tasks } = sampleData();
    booted = boot({ tasks });
    // a1 is a child of "a" in the store. The CSV maps no parentId column, so its normalized
    // `parentId: null` means "not stated" — the diff must not flatten the hierarchy to the root.
    const same = booted.service.importCsv(`id,name,start,end\na1,Wireframes,0,${3 * DAY}\n`, { dryRun: true });
    expect(same.changes).toEqual([]);
    // A real change still surfaces, without a parentId term.
    const moved = booted.service.importCsv(`id,name,start,end\na1,Wireframes,0,${4 * DAY}\n`, { dryRun: true });
    expect(moved.changes).toEqual([{ kind: "update", id: "a1", before: { end: 3 * DAY }, after: { end: 4 * DAY } }]);
  });

  it("orders added tasks parents-first regardless of document order", () => {
    booted = boot();
    const doc = docOf({ tasks: [t("child", "parent", "Child", 0, 1), t("parent", null, "Parent", 0, 2)] });
    const changes = diffDocument(doc, booted.data.query());
    expect(changes.map((c) => (c.kind === "add" ? c.task.id : ""))).toEqual(["parent", "child"]);
  });
});

describe("orderAddsParentsFirst (unit)", () => {
  it("places a task before any batch add it is parented under, breaking cycles", () => {
    const adds = [
      { kind: "add" as const, task: t("c", "b", "C", 0, 1) },
      { kind: "add" as const, task: t("b", "a", "B", 0, 1) },
      { kind: "add" as const, task: t("a", null, "A", 0, 1) },
    ];
    expect(orderAddsParentsFirst(adds).map((c) => c.task.id)).toEqual(["a", "b", "c"]);
  });
});
