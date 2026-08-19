/**
 * docs/specs/plugins/scheduling.md §3.1 — the two points as seen through the plugin host: a
 * third-party plugin contributes, and the contribution reaches the propagation that runs inside the
 * user's own transaction.
 */
import { definePlugin } from "@stargantt/core";
import type { AnyPlugin, GanttInstance } from "@stargantt/core";
import type {
  ConstraintBoundsContribution,
  PropagationRuleContribution,
} from "../src/engine/types";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createGantt, dataOf, times } from "./_helpers";

let gantt: GanttInstance | undefined;

afterEach(() => {
  gantt?.dispose();
  gantt = undefined;
});

/** A third-party plugin that contributes to one of the scheduling points. */
function contributor(
  id: string,
  bounds?: ConstraintBoundsContribution,
  rule?: PropagationRuleContribution,
): AnyPlugin {
  return definePlugin<void>({
    meta: { id },
    setup(ctx) {
      if (bounds !== undefined) ctx.contribute("schedule/constraintBounds", bounds);
      if (rule !== undefined) ctx.contribute("schedule/propagationRule", rule);
    },
  });
}

function boot(extra: readonly AnyPlugin[], raw: unknown[]): GanttInstance {
  gantt = createGantt(extra);
  dataOf(gantt).load(raw);
  return gantt;
}

const CUSTOM = [
  { id: "a", name: "A", start: 0, end: 10 },
  { id: "b", name: "B", start: 10, end: 15, constraint: { type: "QUARTER_START", date: 50 } },
  { id: "L1", sourceId: "a", targetId: "b", type: "FS" },
];

describe("schedule/constraintBounds — through the host", () => {
  it("applies a contributed bound to the propagation of a user edit", () => {
    const g = boot(
      [contributor("test.bounds", (_task, ctx) => ({ earliestStart: ctx.constraint.date ?? 0 }))],
      CUSTOM,
    );
    g.dispatch("task/move", { id: "a", start: 0, end: 20 });
    expect(times(dataOf(g))).toEqual({ a: [0, 20], b: [50, 55] });
  });

  it("takes the first contribution that does not decline", () => {
    const first = vi.fn<ConstraintBoundsContribution>(() => undefined);
    const g = boot(
      [
        contributor("test.first", first),
        contributor("test.second", () => ({ earliestStart: 70 })),
        contributor("test.third", () => ({ earliestStart: 90 })),
      ],
      CUSTOM,
    );
    g.dispatch("task/move", { id: "a", start: 0, end: 20 });
    expect(times(dataOf(g))["b"]).toEqual([70, 75]);
    expect(first).toHaveBeenCalled();
  });

  it("reports a throwing contribution as a plugin fault and schedules without it", () => {
    const errors: string[] = [];
    const g = boot(
      [
        contributor("test.throws", () => {
          throw new Error("boom");
        }),
        contributor("test.ok", () => ({ earliestStart: 80 })),
      ],
      CUSTOM,
    );
    g.on("core/pluginError", (e) => errors.push(e.pluginId));
    g.dispatch("task/move", { id: "a", start: 0, end: 20 });
    expect(errors).toEqual(["stargantt.scheduling"]);
    expect(times(dataOf(g))["b"]).toEqual([80, 85]);
  });

  it("leaves an unknown constraint inert when nothing is contributed", () => {
    const g = boot([], CUSTOM);
    g.dispatch("task/move", { id: "a", start: 0, end: 20 });
    expect(times(dataOf(g))).toEqual({ a: [0, 20], b: [20, 25] });
  });
});

describe("schedule/propagationRule — through the host", () => {
  const PLAIN = [
    { id: "a", name: "A", start: 0, end: 10 },
    { id: "b", name: "B", start: 10, end: 15 },
    { id: "L1", sourceId: "a", targetId: "b", type: "FS" },
  ];

  it("lets a contributed rule place the tasks it claims", () => {
    const g = boot(
      [
        contributor("test.rule", undefined, (task, ctx) =>
          task.id === "b" ? { start: ctx.proposed.start + 5, end: ctx.proposed.end + 5 } : undefined,
        ),
      ],
      PLAIN,
    );
    g.dispatch("task/move", { id: "a", start: 0, end: 20 });
    expect(times(dataOf(g))).toEqual({ a: [0, 20], b: [25, 30] });
  });

  it("falls back to the built-in derivation for tasks no rule claims", () => {
    const g = boot([contributor("test.rule", undefined, () => undefined)], PLAIN);
    g.dispatch("task/move", { id: "a", start: 0, end: 20 });
    expect(times(dataOf(g))).toEqual({ a: [0, 20], b: [20, 25] });
  });

  it("reaches a host that calls the published engine itself", () => {
    const g = boot([contributor("test.rule", undefined, () => ({ start: 300, end: 305 }))], PLAIN);
    const scheduler = g.service("stargantt.scheduler");
    const patches = scheduler.schedule(dataOf(g).query(), new Set(["a"]));
    expect(patches).toEqual([
      {
        op: "task/update",
        id: "b",
        before: { start: 10, end: 15 },
        after: { start: 300, end: 305 },
      },
    ]);
  });
});
