/**
 * Plugin wiring for the engine's §2.4–§2.6 surface: the `schedule/reschedule` and
 * `schedule/setTaskMode` commands, the reschedule preview, `scheduleAsync`, and the opt-in mode
 * column. All in plain node against a `{}` root — the plugin stays headless.
 */
import type { GanttInstance } from "@stargantt/core";
import type { Task, Transaction } from "@stargantt/plugin-data-store";
import { afterEach, describe, expect, it } from "vitest";
import { buildModeColumn } from "../src/internal/mode-column";
import { resolveMessages } from "../src/internal/messages";
import type { SchedulingConfig } from "../src/index";
import { DAY, createGantt, dataOf, recordTransactions, task, times } from "./_helpers";

let gantt: GanttInstance | undefined;

function boot(input: Parameters<ReturnType<typeof dataOf>["load"]>[0], config?: SchedulingConfig) {
  gantt = createGantt([], config);
  dataOf(gantt).load(input as never);
  return gantt;
}

afterEach(() => {
  gantt?.dispose();
  gantt = undefined;
});

describe("schedule/reschedule command", () => {
  it("moves past unstarted work to the status date and propagates downstream, in one transaction", () => {
    const g = boot({
      tasks: [task("a", 0, 2 * DAY), task("b", 2 * DAY, 3 * DAY)],
      links: [{ id: "l1", sourceId: "a", targetId: "b", type: "FS" }],
    });
    const settled = recordTransactions(g);

    g.dispatch("schedule/reschedule", { statusDate: 5 * DAY });

    expect(times(dataOf(g))).toEqual({ a: [5 * DAY, 7 * DAY], b: [7 * DAY, 8 * DAY] });
    expect(settled).toHaveLength(1);
  });

  it("keeps the start of in-progress work and only pushes the remainder out", () => {
    const g = boot({ tasks: [task("a", 0, 4 * DAY, { progress: 0.5 })] });
    g.dispatch("schedule/reschedule", { statusDate: 10 * DAY });
    expect(times(dataOf(g))).toEqual({ a: [0, 12 * DAY] });
  });

  it("reports the dropped plan through core/pluginError when another will-handler cancels", () => {
    // §2.6 — a cancelled reschedule transaction drops the whole plan; the drop is reported, never
    // silent. Commitment is observed through the settle signal, which cannot fire for a cancelled
    // apply.
    const g = boot({
      tasks: [task("a", 0, 2 * DAY), task("b", 2 * DAY, 3 * DAY)],
      links: [{ id: "l1", sourceId: "a", targetId: "b", type: "FS" }],
    });
    const errors: { pluginId: string; error: unknown }[] = [];
    g.on("core/pluginError", (e) => errors.push(e));
    g.on("data/willApplyTransaction", (e) => e.preventDefault());

    g.dispatch("schedule/reschedule", { statusDate: 5 * DAY });

    // Nothing moved and exactly one report names this plugin and the dropped plan.
    expect(times(dataOf(g))).toEqual({ a: [0, 2 * DAY], b: [2 * DAY, 3 * DAY] });
    expect(errors).toHaveLength(1);
    expect(errors[0]?.pluginId).toBe("stargantt.scheduling");
    expect(String((errors[0]?.error as Error).message)).toMatch(/cancelled.*dropped/);
  });

  it("reports nothing through core/pluginError when the reschedule commits", () => {
    const g = boot({ tasks: [task("a", 0, 2 * DAY)] });
    const errors: unknown[] = [];
    g.on("core/pluginError", (e) => errors.push(e));
    g.dispatch("schedule/reschedule", { statusDate: 5 * DAY });
    expect(times(dataOf(g))).toEqual({ a: [5 * DAY, 7 * DAY] });
    expect(errors).toEqual([]);
  });

  it("ignores an unusable status date and a run that moves nothing", () => {
    const g = boot({ tasks: [task("a", 5 * DAY, 6 * DAY)] });
    g.dispatch("schedule/reschedule", { statusDate: Number.NaN });
    g.dispatch("schedule/reschedule", { statusDate: 0 });
    expect(times(dataOf(g))).toEqual({ a: [5 * DAY, 6 * DAY] });
  });

  it("skips manually scheduled tasks", () => {
    const g = boot({ tasks: [task("a", 0, DAY, { meta: { scheduleMode: "manual" } })] });
    g.dispatch("schedule/reschedule", { statusDate: 5 * DAY });
    expect(times(dataOf(g))).toEqual({ a: [0, DAY] });
  });
});

describe("previewReschedule", () => {
  it("returns the command's exact patches without applying anything", () => {
    const g = boot({
      tasks: [task("a", 0, 2 * DAY), task("b", 2 * DAY, 3 * DAY)],
      links: [{ id: "l1", sourceId: "a", targetId: "b", type: "FS" }],
    });
    const scheduler = g.service("stargantt.scheduler");
    const preview = scheduler.previewReschedule(5 * DAY);
    // Preview mutates nothing.
    expect(times(dataOf(g))).toEqual({ a: [0, 2 * DAY], b: [2 * DAY, 3 * DAY] });
    // Applying the command lands exactly where the preview said.
    g.dispatch("schedule/reschedule", { statusDate: 5 * DAY });
    const landed = times(dataOf(g));
    for (const patch of preview) {
      if (patch.op !== "task/update") continue;
      expect(landed[String(patch.id)]).toEqual([patch.after.start, patch.after.end]);
    }
    expect(preview.length).toBeGreaterThan(1);
    expect(scheduler.previewReschedule(Number.POSITIVE_INFINITY)).toEqual([]);
  });

  it("includes the §2.5 effort follow-on patches the real dispatch appends", () => {
    // Regression: a preview that skipped `effortFollowOn` missed a fixed-units task's `meta.work`
    // re-derivation, so it stopped being the "exact patch list" the member promises.
    const g = boot({
      tasks: [task("a", 0, 2 * DAY, { meta: { effortMode: "fixed-units", work: DAY } })],
      resources: [{ id: "r", name: "R" }],
      assignments: [{ taskId: "a", resourceId: "r", units: 1 }],
    });
    const scheduler = g.service("stargantt.scheduler");
    const preview = scheduler.previewReschedule(5 * DAY);

    const settled = recordTransactions(g);
    g.dispatch("schedule/reschedule", { statusDate: 5 * DAY });

    expect(settled).toHaveLength(1);
    // The preview is the exact patch list the command put into the store.
    expect(preview).toEqual(settled[0]?.patches);
    // And it does carry the effort follow-on (a meta-bearing task/update).
    expect(preview.some((p) => p.op === "task/update" && p.after.meta !== undefined)).toBe(true);
  });

  it("omits downstream propagation when propagation is disabled", () => {
    const g = boot(
      {
        tasks: [task("a", 0, 2 * DAY), task("b", 2 * DAY, 3 * DAY)],
        links: [{ id: "l1", sourceId: "a", targetId: "b", type: "FS" }],
      },
      { autoSchedule: { enabled: false } },
    );
    const preview = g.service("stargantt.scheduler").previewReschedule(5 * DAY);
    expect(preview.map((p) => (p.op === "task/update" ? p.id : p.op))).toEqual(["a", "b"]);
  });
});

describe("schedule/setTaskMode command", () => {
  it("switches a task to manual and back through undoable meta updates", () => {
    const g = boot({ tasks: [task("a", 0, DAY)] });
    const scheduler = g.service("stargantt.scheduler");
    expect(scheduler.taskScheduleMode("a")).toBe("auto");

    g.dispatch("schedule/setTaskMode", { id: "a", mode: "manual" });
    expect(scheduler.taskScheduleMode("a")).toBe("manual");
    expect(dataOf(g).getTask("a")?.meta).toEqual({ scheduleMode: "manual" });

    g.dispatch("schedule/setTaskMode", { id: "a", mode: "auto" });
    expect(scheduler.taskScheduleMode("a")).toBe("auto");
    // The emptied meta is fully removed, not left as {}.
    expect(dataOf(g).getTask("a")?.meta).toBeUndefined();
  });

  it("preserves unrelated meta keys and ignores unusable input", () => {
    const g = boot({ tasks: [task("a", 0, DAY, { meta: { color: "red" } })] });
    g.dispatch("schedule/setTaskMode", { id: "a", mode: "manual" });
    expect(dataOf(g).getTask("a")?.meta).toEqual({ color: "red", scheduleMode: "manual" });
    g.dispatch("schedule/setTaskMode", { id: "a", mode: "auto" });
    expect(dataOf(g).getTask("a")?.meta).toEqual({ color: "red" });
    g.dispatch("schedule/setTaskMode", { id: "missing", mode: "manual" });
    g.dispatch("schedule/setTaskMode", { id: "a", mode: "sideways" as never });
    expect(dataOf(g).getTask("a")?.meta).toEqual({ color: "red" });
    expect(g.service("stargantt.scheduler").taskScheduleMode("missing")).toBe("auto");
  });

  it("a manual task stays put when its predecessor moves", () => {
    const g = boot({
      tasks: [task("a", 0, 2 * DAY), task("b", 2 * DAY, 3 * DAY)],
      links: [{ id: "l1", sourceId: "a", targetId: "b", type: "FS" }],
    });
    g.dispatch("schedule/setTaskMode", { id: "b", mode: "manual" });
    g.dispatch("task/move", { id: "a", start: 5 * DAY, end: 7 * DAY });
    expect(times(dataOf(g))["b"]).toEqual([2 * DAY, 3 * DAY]);
  });
});

describe("scheduleAsync", () => {
  it("resolves with the same patches a synchronous call produces", async () => {
    const g = boot({
      tasks: [task("a", 0, 2 * DAY), task("b", 0, DAY)],
      links: [{ id: "l1", sourceId: "a", targetId: "b", type: "FS" }],
    });
    const scheduler = g.service("stargantt.scheduler");
    const viewNow = dataOf(g).query();
    const sync = scheduler.schedule(viewNow, new Set(["a"]));
    const async = await scheduler.scheduleAsync(viewNow, new Set(["a"]));
    expect(async).toEqual(sync);
    expect(async.length).toBeGreaterThan(0);
  });

  it("resolves pending calls with an empty list on dispose", async () => {
    const g = boot({ tasks: [task("a", 0, DAY)] });
    const scheduler = g.service("stargantt.scheduler");
    const pending = scheduler.scheduleAsync(dataOf(g).query(), new Set(["a"]));
    g.dispose();
    gantt = undefined;
    expect(await pending).toEqual([]);
  });
});

describe("mode column", () => {
  const fakeCell = () => ({ textContent: "" }) as unknown as HTMLElement;
  const noFault = (): void => {};

  it("labels tasks by their scheduling mode with catalog text", () => {
    const column = buildModeColumn(resolveMessages(undefined, noFault));
    expect(column.id).toBe("scheduling.mode");
    expect(column.header).toBe("Mode");
    expect(column.setValue).toBeUndefined();

    const auto = task("a", 0, DAY);
    const manual = task("b", 0, DAY, { meta: { scheduleMode: "manual" } }) as Task;
    const cell = fakeCell();
    column.render(cell, auto);
    expect(cell.textContent).toBe("Auto");
    column.render(cell, manual);
    expect(cell.textContent).toBe("Manual");
    expect(column.getValue(auto)).toBe("Auto");
    expect(column.compare?.(auto, manual)).toBeLessThan(0);
  });

  it("honors per-key message overrides and ignores non-strings", () => {
    const messages = resolveMessages({ modeManual: "Pinned", modeAuto: 7 as never }, noFault);
    const column = buildModeColumn(messages);
    expect(column.header).toBe("Mode");
    expect(column.getValue(task("b", 0, DAY, { meta: { scheduleMode: "manual" } }))).toBe("Pinned");
    expect(column.getValue(task("a", 0, DAY))).toBe("Auto");
  });
});

describe("effort tri-state through the store", () => {
  it("fixed-work: changing assignments re-derives the duration in the same transaction", () => {
    const g = boot({
      tasks: [task("a", 0, 2 * DAY, { meta: { effortMode: "fixed-work", work: 2 * DAY } })],
      resources: [{ id: "r", name: "R" }],
    });
    g.dispatch("assignment/set", { taskId: "a", resourceId: "r", units: 2 });
    // 2 days of work at 2 units → 1 day duration.
    expect(times(dataOf(g))["a"]).toEqual([0, DAY]);
  });

  it("fixed-duration: changing assignments re-derives the stored work", () => {
    const g = boot({
      tasks: [task("a", 0, 2 * DAY, { meta: { effortMode: "fixed-duration", work: 0 } })],
      resources: [{ id: "r", name: "R" }],
    });
    g.dispatch("assignment/set", { taskId: "a", resourceId: "r", units: 2 });
    expect(dataOf(g).getTask("a")?.meta?.["work"]).toBe(4 * DAY);
    expect(times(dataOf(g))["a"]).toEqual([0, 2 * DAY]);
  });

  it("fixed-units: moving the task re-derives the stored work", () => {
    const g = boot({
      tasks: [task("a", 0, DAY, { meta: { effortMode: "fixed-units", work: DAY } })],
      resources: [{ id: "r", name: "R" }],
    });
    g.dispatch("assignment/set", { taskId: "a", resourceId: "r", units: 1 });
    g.dispatch("task/move", { id: "a", start: 0, end: 3 * DAY });
    expect(dataOf(g).getTask("a")?.meta?.["work"]).toBe(3 * DAY);
  });

  it("tasks without effort meta are untouched", () => {
    const g = boot({
      tasks: [task("a", 0, 2 * DAY)],
      resources: [{ id: "r", name: "R" }],
    });
    g.dispatch("assignment/set", { taskId: "a", resourceId: "r", units: 2 });
    expect(times(dataOf(g))["a"]).toEqual([0, 2 * DAY]);
    expect(dataOf(g).getTask("a")?.meta).toBeUndefined();
  });

  it("appends the effort follow-on into the very same transaction (one undo step)", () => {
    const g = boot({
      tasks: [task("a", 0, 2 * DAY, { meta: { effortMode: "fixed-work", work: 2 * DAY } })],
      resources: [{ id: "r", name: "R" }],
    });
    const settled = recordTransactions(g);
    g.dispatch("assignment/set", { taskId: "a", resourceId: "r", units: 2 });
    expect(settled).toHaveLength(1);
    const tx = settled[0] as Transaction;
    expect(tx.patches.some((p) => p.op === "assignment/add")).toBe(true);
    expect(tx.patches.some((p) => p.op === "task/update" && p.after.end === DAY)).toBe(true);
  });
});
