/**
 * docs/specs/plugins/scheduling.md §3.1 — `schedule/constraintBounds` and
 * `schedule/propagationRule`.
 *
 * Both points compose with the "first" strategy: contributions are tried in registration order and
 * the first non-`undefined` result wins; when every one declines, the built-in behaviour applies.
 * These cases drive the engine directly with the composed hooks, so they cover the derivation rules;
 * `plugin-extension-points.test.ts` covers the wiring through the plugin host.
 */
import type { ConstraintType } from "@stargantt/plugin-data-store";
import { describe, expect, it, vi } from "vitest";
import { schedule } from "../src/engine/engine";
import type {
  ConstraintBoundsContribution,
  PropagationRuleContribution,
} from "../src/engine/types";
import { link, moves, task, view } from "./_helpers";

/** A constraint type outside the eight built-ins. */
const custom = (type: string): ConstraintType => type as ConstraintType;

describe("schedule/constraintBounds", () => {
  it("resolves an unknown constraint type as an early-side bound", () => {
    const bounds: ConstraintBoundsContribution = (_task, ctx) =>
      ctx.constraint.type === custom("QUARTER_START") ? { earliestStart: 50 } : undefined;
    const v = view(
      [
        task("a", 0, 10),
        task("b", 0, 5, { constraint: { type: custom("QUARTER_START"), date: 50 } }),
      ],
      [link("l1", "a", "b", "FS")],
    );
    expect(moves(schedule(v, new Set(["a"]), { constraintBounds: bounds }))).toEqual({
      b: [50, 55],
    });
  });

  it("resolves an unknown constraint type as a late-side bound, clamping like FNLT", () => {
    const bounds: ConstraintBoundsContribution = () => ({ latestEnd: 40 });
    const v = view(
      [task("a", 0, 10), task("b", 0, 5, { constraint: { type: custom("DEADLINE") } })],
      [link("l1", "a", "b", "FS")],
    );
    expect(moves(schedule(v, new Set(["a"]), { constraintBounds: bounds }))).toEqual({
      b: [35, 40],
    });
  });

  it("lets the early side win over a contributed late-side bound", () => {
    const bounds: ConstraintBoundsContribution = () => ({ earliestStart: 50, latestEnd: 30 });
    const v = view(
      [task("a", 0, 10), task("b", 0, 5, { constraint: { type: custom("WINDOW") } })],
      [link("l1", "a", "b", "FS")],
    );
    expect(moves(schedule(v, new Set(["a"]), { constraintBounds: bounds }))).toEqual({
      b: [50, 55],
    });
  });

  it("hands the task and the live view to the contribution", () => {
    const seen: string[] = [];
    const bounds: ConstraintBoundsContribution = (t, ctx) => {
      seen.push(`${String(t.id)}:${ctx.constraint.type}:${String(ctx.constraint.date)}`);
      expect(ctx.view.byId.has("a")).toBe(true);
      return undefined;
    };
    const v = view(
      [
        task("a", 0, 10),
        task("b", 0, 5, { constraint: { type: custom("QUARTER_START"), date: 7 } }),
      ],
      [link("l1", "a", "b", "FS")],
    );
    schedule(v, new Set(["a"]), { constraintBounds: bounds });
    expect(seen).toContain("b:QUARTER_START:7");
  });

  it("schedules the task unconstrained when the contribution declines", () => {
    const bounds = vi.fn<ConstraintBoundsContribution>(() => undefined);
    const v = view(
      [
        task("a", 0, 10),
        task("b", 0, 5, { constraint: { type: custom("QUARTER_START"), date: 50 } }),
      ],
      [link("l1", "a", "b", "FS")],
    );
    expect(moves(schedule(v, new Set(["a"]), { constraintBounds: bounds }))).toEqual({
      b: [10, 15],
    });
    expect(bounds).toHaveBeenCalled();
  });

  it("is never consulted for the eight built-in types", () => {
    const bounds = vi.fn<ConstraintBoundsContribution>(() => ({ earliestStart: 500 }));
    const v = view(
      [
        task("a", 0, 10),
        task("b", 0, 5, { constraint: { type: "ASAP" } }),
        task("c", 0, 5, { constraint: { type: "ALAP" } }),
        task("d", 0, 5, { constraint: { type: "SNET", date: 20 } }),
        task("e", 0, 5, { constraint: { type: "FNLT", date: 12 } }),
        task("f", 0, 5, { constraint: { type: "SNLT", date: 12 } }),
        task("g", 0, 5, { constraint: { type: "FNET", date: 12 } }),
        task("h", 0, 5, { constraint: { type: "MSO", date: 12 } }),
        task("i", 0, 5, { constraint: { type: "MFO", date: 20 } }),
      ],
      [
        link("l1", "a", "b", "FS"),
        link("l2", "a", "c", "FS"),
        link("l3", "a", "d", "FS"),
        link("l4", "a", "e", "FS"),
        link("l5", "a", "f", "FS"),
        link("l6", "a", "g", "FS"),
        link("l7", "a", "h", "FS"),
        link("l8", "a", "i", "FS"),
      ],
    );
    expect(moves(schedule(v, new Set(["a"]), { constraintBounds: bounds }))).toEqual({
      b: [10, 15],
      c: [10, 15],
      d: [20, 25],
      e: [10, 15],
      f: [12, 17],
      g: [10, 15],
      h: [12, 17],
      i: [15, 20],
    });
    expect(bounds).not.toHaveBeenCalled();
  });

  it("is not consulted for a task without a constraint", () => {
    const bounds = vi.fn<ConstraintBoundsContribution>(() => undefined);
    const v = view([task("a", 0, 10), task("b", 0, 5)], [link("l1", "a", "b", "FS")]);
    schedule(v, new Set(["a"]), { constraintBounds: bounds });
    expect(bounds).not.toHaveBeenCalled();
  });
});

describe("schedule/propagationRule", () => {
  it("replaces the built-in derivation for a task it claims", () => {
    const rule: PropagationRuleContribution = (t) =>
      t.id === "b" ? { start: 100, end: 130 } : undefined;
    const v = view(
      [task("a", 0, 10), task("b", 0, 5), task("c", 0, 5)],
      [link("l1", "a", "b", "FS"), link("l2", "b", "c", "FS")],
    );
    expect(moves(schedule(v, new Set(["a"]), { propagationRule: rule }))).toEqual({
      b: [100, 130],
      c: [130, 135],
    });
  });

  it("leaves declined tasks on the built-in rule", () => {
    const rule: PropagationRuleContribution = () => undefined;
    const v = view([task("a", 0, 10), task("b", 0, 5)], [link("l1", "a", "b", "FS")]);
    expect(moves(schedule(v, new Set(["a"]), { propagationRule: rule }))).toEqual({ b: [10, 15] });
  });

  it("receives the dates the built-in derivation proposes", () => {
    const proposals: [number, number][] = [];
    const rule: PropagationRuleContribution = (_t, ctx) => {
      proposals.push([ctx.proposed.start, ctx.proposed.end]);
      return undefined;
    };
    const v = view([task("a", 0, 10), task("b", 0, 5)], [link("l1", "a", "b", "FS")]);
    schedule(v, new Set(["a"]), { propagationRule: rule });
    expect(proposals).toEqual([[10, 15]]);
  });

  it("is consulted for a summary's roll-up too", () => {
    const rule: PropagationRuleContribution = (t) =>
      t.id === "p" ? { start: 0, end: 999 } : undefined;
    const v = view([task("p", 0, 0), task("a", 10, 20, { parentId: "p" })]);
    expect(moves(schedule(v, new Set(["a"]), { propagationRule: rule }))).toEqual({
      p: [0, 999],
    });
  });

  it("shifts a claimed span bodily when a SNET clamps it later", () => {
    const rule: PropagationRuleContribution = () => ({ start: 20, end: 50 });
    const v = view(
      [task("a", 0, 10), task("b", 0, 5, { constraint: { type: "SNET", date: 60 } })],
      [link("l1", "a", "b", "FS")],
    );
    expect(moves(schedule(v, new Set(["a"]), { propagationRule: rule }))).toEqual({
      b: [60, 90],
    });
  });

  it("declines a claim that is not a pair of finite instants", () => {
    const rule: PropagationRuleContribution = () => ({ start: Number.NaN, end: 5 });
    const v = view([task("a", 0, 10), task("b", 0, 5)], [link("l1", "a", "b", "FS")]);
    expect(moves(schedule(v, new Set(["a"]), { propagationRule: rule }))).toEqual({ b: [10, 15] });
  });

  it("names the anchor the relation pins", () => {
    const anchors: Record<string, string> = {};
    const rule: PropagationRuleContribution = (t, ctx) => {
      anchors[String(t.id)] = ctx.anchor;
      return undefined;
    };
    const v = view(
      [
        task("p", 0, 0),
        task("a", 0, 10, { parentId: "p" }),
        task("fs", 0, 5, { parentId: "p" }),
        task("ss", 0, 5, { parentId: "p" }),
        task("ff", 0, 5, { parentId: "p" }),
        task("sf", 0, 5, { parentId: "p" }),
      ],
      [
        link("l1", "a", "fs", "FS"),
        link("l2", "a", "ss", "SS"),
        link("l3", "a", "ff", "FF"),
        link("l4", "a", "sf", "SF"),
      ],
    );
    schedule(v, new Set(["a"]), { propagationRule: rule });
    // A summary rolls up from both sides at once; the start is the side a rule should hold.
    expect(anchors).toEqual({ fs: "start", ss: "start", ff: "end", sf: "end", p: "start" });
  });

  it("hands an end-anchored claim straight through, span and all", () => {
    // The claim is authoritative under `anchor: "end"`: the engine neither re-derives the end from
    // the returned start nor shifts the span, which is what let the two measures drift apart.
    const rule: PropagationRuleContribution = (t, ctx) =>
      t.id === "b" && ctx.anchor === "end" ? { start: 40, end: 100 } : undefined;
    const v = view([task("a", 0, 10), task("b", 0, 5)], [link("l1", "a", "b", "FF")]);
    expect(moves(schedule(v, new Set(["a"]), { propagationRule: rule }))).toEqual({ b: [40, 100] });
  });

  it("falls back to the start-anchored placement when the end-anchored one starts too early", () => {
    // Both bounds apply: the FF predecessor would finish `b` at 10, but the FS one cannot let it
    // begin before 30 — the early side wins, and the later start still finishes after the FF bound.
    const v = view(
      [task("a", 0, 10), task("c", 0, 30), task("b", 0, 5)],
      [link("l1", "a", "b", "FF"), link("l2", "c", "b", "FS")],
    );
    expect(moves(schedule(v, new Set(["a", "c"])))).toEqual({ b: [30, 35] });
  });

  it("is not consulted for a seed, which the pass never derives dates for", () => {
    const rule = vi.fn<PropagationRuleContribution>(() => undefined);
    const v = view([task("a", 0, 10), task("b", 0, 5)], [link("l1", "a", "b", "FS")]);
    schedule(v, new Set(["a"]), { propagationRule: rule });
    for (const call of rule.mock.calls) expect(call[0].id).not.toBe("a");
  });
});
