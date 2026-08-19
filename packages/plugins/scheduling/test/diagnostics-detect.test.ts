/**
 * Pure tests of the diagnostic pass — no host, just a hand-built `ReadonlyDataView`.
 *
 * docs/specs/plugins/scheduling.md §8. Excludes `analyzedTaskCount` / `linkCount` assertions —
 * those report fields are not part of this report shape (see `src/internal/diagnostics/diagnose.ts`'s
 * header note).
 */
import { describe, expect, it } from "vitest";
import type { Link, ReadonlyDataView, Task, TaskId } from "@stargantt/plugin-data-store";
import { diagnose, EMPTY_REPORT, lagInDays } from "../src/internal/diagnostics/diagnose";

const DAY = 86_400_000;

function view(tasks: Task[], links: Link[]): ReadonlyDataView {
  const byId = new Map<TaskId, Task>(tasks.map((t) => [t.id, t]));
  const linksByTask = new Map<TaskId, { in: Link[]; out: Link[] }>();
  const slot = (id: TaskId): { in: Link[]; out: Link[] } => {
    let s = linksByTask.get(id);
    if (s === undefined) {
      s = { in: [], out: [] };
      linksByTask.set(id, s);
    }
    return s;
  };
  for (const l of links) {
    slot(l.sourceId).out.push(l);
    slot(l.targetId).in.push(l);
  }
  return {
    byId,
    children: new Map(),
    linksByTask,
    calendars: new Map(),
    resources: new Map(),
    assignmentsByTask: new Map(),
  };
}

function task(id: string, day: number, extra: Partial<Task> = {}): Task {
  return { id, parentId: null, name: `Task ${id}`, start: day * DAY, end: (day + 1) * DAY, ...extra };
}

function link(id: string, sourceId: string, targetId: string, lag?: number): Link {
  return { id, sourceId, targetId, type: "FS", ...(lag === undefined ? {} : { lag }) };
}

describe("orphan detection", () => {
  it("reports tasks with neither an incoming nor an outgoing link", () => {
    const report = diagnose(view([task("a", 0), task("b", 1), task("c", 2)], [link("l1", "a", "b")]));
    expect(report.orphans).toEqual([{ kind: "orphanTask", taskId: "c" }]);
  });

  it("does not report tasks connected in only one direction", () => {
    const report = diagnose(view([task("a", 0), task("b", 1)], [link("l1", "a", "b")]));
    expect(report.orphans).toEqual([]);
  });

  it("excludes summary tasks from the check", () => {
    const report = diagnose(view([task("s", 0, { type: "summary" }), task("m", 1, { type: "milestone" })], []));
    expect(report.orphans).toEqual([{ kind: "orphanTask", taskId: "m" }]);
  });

  it("orders orphans by start ascending, insertion order breaking ties", () => {
    const report = diagnose(view([task("late", 5), task("x", 1), task("y", 1)], []));
    expect(report.orphans.map((o) => o.taskId)).toEqual(["x", "y", "late"]);
  });
});

describe("lead detection", () => {
  it("reports links with a finite negative lag, carrying endpoints and the lag", () => {
    const report = diagnose(
      view(
        [task("a", 0), task("b", 1), task("c", 2)],
        [link("l1", "a", "b", -2 * DAY), link("l2", "b", "c", DAY)],
      ),
    );
    expect(report.leads).toEqual([{ kind: "lead", linkId: "l1", sourceId: "a", targetId: "b", lag: -2 * DAY }]);
  });

  it("treats a missing, zero or non-finite lag as no lead", () => {
    const report = diagnose(
      view(
        [task("a", 0), task("b", 1), task("c", 2), task("d", 3)],
        [link("l1", "a", "b"), link("l2", "b", "c", 0), link("l3", "c", "d", Number.NEGATIVE_INFINITY)],
      ),
    );
    expect(report.leads).toEqual([]);
  });

  it("checks every link type", () => {
    const l: Link = { id: "l1", sourceId: "a", targetId: "b", type: "SS", lag: -DAY };
    const report = diagnose(view([task("a", 0), task("b", 1)], [l]));
    expect(report.leads).toHaveLength(1);
  });
});

describe("the report shape", () => {
  it("concatenates orphans then leads into issues", () => {
    const report = diagnose(view([task("a", 0), task("b", 1), task("c", 2)], [link("l1", "a", "b", -DAY)]));
    expect(report.issues.map((i) => i.kind)).toEqual(["orphanTask", "lead"]);
  });

  it("has the empty shape on an empty view", () => {
    expect(diagnose(view([], []))).toEqual(EMPTY_REPORT);
  });
});

describe("lagInDays", () => {
  it("converts with the fixed day and rounds to two decimals", () => {
    expect(lagInDays(-DAY)).toBe(-1);
    expect(lagInDays(-DAY * 1.5)).toBe(-1.5);
    expect(lagInDays(-DAY / 3)).toBe(-0.33);
  });
});
