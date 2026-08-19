// @vitest-environment happy-dom
// docs/specs/plugins/export.md §1.7 (export, apply). The standalone `apply(doc)` is not public
// (§1's fold map); the apply path is exercised here through `applyMsProjectXml(text, options)`, and
// its own parents-first reordering directly through the pure `planApply` (a raw document built by
// hand, so the test isolates apply's reordering from the parser's own hierarchy rebuild).
import { afterEach, describe, expect, it } from "vitest";
import type { PluginContext } from "@stargantt/core";
import type { ReadonlyDataView, Task, TaskId } from "@stargantt/plugin-data-store";
import { resolveConfig } from "../src/config";
import { resolveMessages } from "../src/internal/messages";
import { planApply } from "../src/internal/msproject/apply";
import { wireMsProject } from "../src/internal/msproject/wire";
import { DISPOSED_MESSAGE } from "../src/internal/wiring";
import type { ExportWiring } from "../src/internal/wiring";
import type { MsProjectDocument } from "../src/types";
import { boot, DAY } from "./_boot";
import type { Booted } from "./_boot";

let booted: Booted | undefined;
afterEach(() => {
  booted?.dispose();
  booted = undefined;
});

function sampleTasks(): Task[] {
  const t = (id: string, parentId: string | null, name: string, day: number, days: number, extra: Partial<Task> = {}): Task => ({
    id,
    parentId,
    name,
    start: day * DAY,
    end: (day + days) * DAY,
    ...extra,
  });
  return [
    t("a", null, "Design phase", 0, 8, { type: "summary" }),
    t("a1", "a", "Wireframes", 0, 3, { progress: 0.5 }),
    t("a2", "a", 'Visual, "final" & <bold>', 3, 5),
    t("m1", null, "Launch", 8, 0, { type: "milestone" }),
  ];
}

/** A small MSPDI fixture matching the msproject-parse.test.ts one (2-level WBS, link, resource). */
function fixtureXml(): string {
  return `<Project><Tasks>
    <Task><UID>1</UID><Name>Phase</Name><OutlineNumber>1</OutlineNumber>
      <Start>2026-01-01T00:00:00</Start><Finish>2026-01-10T00:00:00</Finish><Summary>1</Summary></Task>
    <Task><UID>2</UID><Name>Draft</Name><OutlineNumber>1.1</OutlineNumber>
      <Start>2026-01-01T00:00:00</Start><Finish>2026-01-05T00:00:00</Finish></Task>
    <Task><UID>3</UID><Name>Review</Name><OutlineNumber>1.2</OutlineNumber>
      <Start>2026-01-06T00:00:00</Start><Finish>2026-01-10T00:00:00</Finish>
      <PredecessorLink><PredecessorUID>2</PredecessorUID><Type>1</Type></PredecessorLink></Task>
  </Tasks>
  <Resources><Resource><UID>7</UID><Name>Bob</Name><MaxUnits>0.5</MaxUnits></Resource></Resources>
  <Assignments><Assignment><TaskUID>2</TaskUID><ResourceUID>7</ResourceUID><Units>0.5</Units></Assignment></Assignments>
  </Project>`;
}

/**
 * Builds a wiring identical to what `../../index.ts` hands `wireMsProject` at `setup()`, except
 * `ctx.useOptional` is stubbed to answer `"stargantt.baselines"` directly — a controllable double
 * for whatever real service `stargantt.tracking` (now in `exportPlugin`'s `meta.optional`) provides
 * under that key, so the baseline-embedding tests below don't depend on the tracking plugin's own
 * fixtures.
 */
function baselinesWiring(
  b: Booted,
  entries: readonly { id: string; tasks: ReadonlyMap<TaskId, { start: number; end: number }> }[],
): ExportWiring {
  const realCtx = b.testHost.ctxOf("stargantt.export");
  // `PluginContext`'s members are prototype methods on the real implementation, so they are bound
  // explicitly here rather than through an object-literal spread (which would only copy the real
  // ctx's own enumerable properties, dropping every method).
  const ctx: PluginContext = Object.create(realCtx) as PluginContext;
  ctx.useOptional = ((key: string) =>
    key === "stargantt.baselines"
      ? {
          // The real `BaselinesService`'s shape (tracking.md §1.1): the id list lives in the
          // observable `state` store (`state.get().baselines`), not a
          // method of its own.
          state: { get: () => ({ baselines: entries.map((e) => ({ id: e.id })), activeId: undefined }) },
          get: (id: string) => entries.find((e) => e.id === id),
        }
      : realCtx.useOptional(key as never)) as PluginContext["useOptional"];
  return {
    ctx,
    config: resolveConfig(undefined),
    messages: resolveMessages(undefined, () => {}),
    data: b.data,
    view: undefined as never,
    timeline: undefined as never,
    theme: undefined as never,
    reportError: () => {},
    disposed: () => false,
  };
}

describe("toMsProjectXml", () => {
  it("writes tasks depth-first with outline numbers, flags, progress and escaped names", () => {
    booted = boot({ tasks: sampleTasks() });
    const xml = booted.service.toMsProjectXml({ projectName: "My <plan>" });
    expect(xml.startsWith('<?xml version="1.0"')).toBe(true);
    expect(xml).toContain('<Project xmlns="http://schemas.microsoft.com/project">');
    expect(xml).toContain("<Name>My &lt;plan&gt;</Name>");
    // Depth-first order: a (1), a1 (1.1), a2 (1.2), m1 (2).
    const outlines = [...xml.matchAll(/<OutlineNumber>([^<]*)<\/OutlineNumber>/g)].map((m) => m[1]);
    expect(outlines).toEqual(["1", "1.1", "1.2", "2"]);
    expect(xml).toContain("<Summary>1</Summary>");
    expect(xml).toContain("<Milestone>1</Milestone>");
    expect(xml).toContain("<PercentComplete>50</PercentComplete>");
    expect(xml).toContain("Visual, &quot;final&quot; &amp; &lt;bold&gt;");
    expect(xml).toContain("<Start>1970-01-01T00:00:00</Start>");
  });

  it("writes predecessor links with the inverse type map and tenth-of-minute lag", () => {
    booted = boot({
      tasks: sampleTasks(),
      links: [{ id: "l1", sourceId: "a1", targetId: "a2", type: "FS", lag: DAY }],
    });
    const xml = booted.service.toMsProjectXml();
    expect(xml).toContain("<PredecessorUID>2</PredecessorUID>"); // a1 is UID 2
    expect(xml).toContain("<Type>1</Type>");
    expect(xml).toContain(`<LinkLag>${DAY / 6000}</LinkLag>`);
  });

  it("writes resources and assignments with minted UIDs", () => {
    booted = boot({
      tasks: sampleTasks(),
      resources: [{ id: "r1", name: "Alice", capacity: 0.5 }],
      assignments: [{ taskId: "a1", resourceId: "r1", units: 1 }],
    });
    const xml = booted.service.toMsProjectXml();
    expect(xml).toContain("<Name>Alice</Name>");
    expect(xml).toContain("<MaxUnits>0.5</MaxUnits>");
    expect(xml).toContain("<TaskUID>2</TaskUID>");
    expect(xml).toContain("<ResourceUID>1</ResourceUID>");
    expect(xml).toContain("<Units>1</Units>");
  });

  it("embeds saved baselines from a composed `stargantt.baselines`, and omits them on baselines: false", () => {
    booted = boot({ tasks: sampleTasks() });
    const view = new Map<TaskId, { start: number; end: number }>([["a", { start: 0, end: DAY }]]);
    const msp = wireMsProject(baselinesWiring(booted, [{ id: "plan-a", tasks: view }]));
    const xml = msp.toMsProjectXml();
    expect(xml).toContain("<Baseline>");
    expect(xml).toContain("<Number>0</Number>");
    expect(msp.toMsProjectXml({ baselines: false })).not.toContain("<Baseline>");
  });

  it("writes no baselines without `stargantt.baselines` composed", () => {
    booted = boot({ tasks: sampleTasks() });
    expect(booted.service.toMsProjectXml()).not.toContain("<Baseline>");
    expect(booted.errors).toEqual([]);
  });

  it("round-trips through applyMsProjectXml (dryRun): structure, dates and links survive", () => {
    booted = boot({
      tasks: sampleTasks(),
      links: [{ id: "l1", sourceId: "a1", targetId: "a2", type: "FS", lag: DAY }],
    });
    const result = booted.service.applyMsProjectXml(booted.service.toMsProjectXml(), { dryRun: true });
    expect(result.document.issues).toEqual([]);
    expect(result.document.tasks).toHaveLength(4);
    const byName = new Map(result.document.tasks.map((t) => [t.name, t]));
    const phase = byName.get("Design phase")!;
    const wire = byName.get("Wireframes")!;
    expect(wire.parentId).toBe(phase.id);
    expect(wire.start).toBe(0);
    expect(wire.end).toBe(3 * DAY);
    expect(result.document.links).toHaveLength(1);
    expect(result.document.links[0]!.lag).toBe(DAY);
  });
});

describe("applyMsProjectXml", () => {
  it("adds tasks parents-first, plus links, resources and assignments, and emits the event", () => {
    booted = boot();
    const result = booted.service.applyMsProjectXml(fixtureXml());
    expect(result.applied).toEqual({ tasksAdded: 3, tasksUpdated: 0, linksAdded: 1, resourcesAdded: 1, assignmentsSet: 1 });
    const view = booted.data.query();
    expect(view.byId.size).toBe(3);
    expect(view.byId.get("2")!.parentId).toBe("1");
    expect(view.children.get("1")).toEqual(["2", "3"]);
    expect(view.resources.get("7")!.name).toBe("Bob");
    expect(view.assignmentsByTask.get("2")).toEqual([{ taskId: "2", resourceId: "7", units: 0.5 }]);
    expect(booted.msApplied).toEqual([{ result: result.applied }]);
  });

  it("updates existing tasks minimally and never clears unstated optional fields", () => {
    booted = boot({ tasks: [{ id: "1", parentId: null, name: "Old name", start: 0, end: DAY, progress: 0.9 }] });
    const result = booted.service.applyMsProjectXml(
      `<Project><Tasks><Task><UID>1</UID><Name>New name</Name><Start>2026-01-01T00:00:00</Start><Finish>2026-01-03T00:00:00</Finish></Task></Tasks></Project>`,
    );
    expect(result.applied?.tasksAdded).toBe(0);
    expect(result.applied?.tasksUpdated).toBe(1);
    const task = booted.data.getTask("1")!;
    expect(task.name).toBe("New name");
    expect(task.progress).toBe(0.9); // absent in the document = not stated, never cleared
  });

  it("dryRun parses without dispatching: `applied` absent, store untouched", () => {
    booted = boot();
    const result = booted.service.applyMsProjectXml(fixtureXml(), { dryRun: true });
    expect(result.applied).toBeUndefined();
    expect(booted.data.query().byId.size).toBe(0);
    expect(booted.msApplied).toEqual([]);
  });

  it("dispatches nothing (and reports it) for a document that changes nothing further", () => {
    booted = boot();
    booted.service.applyMsProjectXml(fixtureXml());
    booted.msApplied.length = 0;
    const again = booted.service.applyMsProjectXml(fixtureXml());
    expect(again.applied).toEqual({ tasksAdded: 0, tasksUpdated: 0, linksAdded: 0, resourcesAdded: 0, assignmentsSet: 1 });
    expect(booted.errors).toEqual([]);
  });

  it("reshapes baselines into BaselineInit entries via the result", () => {
    booted = boot();
    const result = booted.service.applyMsProjectXml(
      `<Project><Tasks><Task><UID>1</UID><Name>N</Name><Start>2026-01-01T00:00:00</Start><Finish>2026-01-02T00:00:00</Finish>
        <Baseline><Number>0</Number><Start>2026-01-01T00:00:00</Start><Finish>2026-01-02T00:00:00</Finish></Baseline>
      </Task></Tasks></Project>`,
      { dryRun: true },
    );
    expect(result.baselineInits.map((b) => b.id)).toEqual(["msp-baseline-0"]);
    expect(result.baselineInits[0]!.name).toBe("Baseline");
    expect(result.baselineInits[0]!.tasks.map((t) => t.id)).toEqual(["1"]);
  });
});

describe("disposed-instance guard (review m1)", () => {
  it("toMsProjectXml throws the disposed-instance error once the plugin is torn down", () => {
    booted = boot({ tasks: sampleTasks() });
    booted.dispose();
    expect(() => booted?.service.toMsProjectXml()).toThrowError(DISPOSED_MESSAGE);
  });
});

describe("read-only interplay (§2.1, §1.7)", () => {
  it("applyMsProjectXml applies nothing, reports all-zero counts, and emits no event while read-only", () => {
    booted = boot({ config: { viewerEmbed: { readOnly: true } } });
    const result = booted.service.applyMsProjectXml(fixtureXml());
    expect(result.applied).toEqual({ tasksAdded: 0, tasksUpdated: 0, linksAdded: 0, resourcesAdded: 0, assignmentsSet: 0 });
    expect(booted.transactions).toHaveLength(0);
    expect(booted.msApplied).toHaveLength(0);
    expect(booted.data.query().byId.size).toBe(0);
  });
});

describe("planApply (unit — apply's own parents-first reordering)", () => {
  function viewOf(tasks: readonly Task[]): ReadonlyDataView {
    const byId = new Map<TaskId, Task>(tasks.map((t) => [t.id, t]));
    const children = new Map<TaskId | null, TaskId[]>();
    for (const t of tasks) {
      const list = children.get(t.parentId);
      if (list === undefined) children.set(t.parentId, [t.id]);
      else list.push(t.id);
    }
    return { byId, children, linksByTask: new Map(), calendars: new Map(), resources: new Map(), assignmentsByTask: new Map() } as ReadonlyDataView;
  }

  it("applies tasks parents-first even when the document lists a child before its parent", () => {
    const doc: MsProjectDocument = {
      tasks: [
        { id: "2", parentId: "1", name: "Child", start: 0, end: DAY },
        { id: "1", parentId: null, name: "Parent", start: 0, end: 5 * DAY },
      ],
      links: [],
      resources: [],
      assignments: [],
      baselines: [],
      issues: [],
    };
    const plan = planApply(doc, viewOf([]));
    expect(plan.taskAdds.map((t) => t.id)).toEqual(["1", "2"]);
  });

  it("defaults a missing or invalid assignment units to 1 instead of dropping it", () => {
    const doc: MsProjectDocument = {
      tasks: [],
      links: [],
      resources: [],
      assignments: [{ taskId: "1", resourceId: "7", units: Number.NaN }],
      baselines: [],
      issues: [],
    };
    const plan = planApply(doc, viewOf([]));
    expect(plan.assignmentSets).toEqual([{ taskId: "1", resourceId: "7", units: 1 }]);
  });

  it("skips assignments missing a taskId or resourceId instead of planning a broken one", () => {
    const doc: MsProjectDocument = {
      tasks: [],
      links: [],
      resources: [],
      assignments: [
        { taskId: undefined, resourceId: "7" } as never,
        { taskId: "2", resourceId: undefined } as never,
        { taskId: "2", resourceId: "7", units: 1 },
      ],
      baselines: [],
      issues: [],
    };
    const plan = planApply(doc, viewOf([]));
    expect(plan.assignmentSets).toHaveLength(1);
  });
});
