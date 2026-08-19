/**
 * The package's published surface: the plugin value, its public types, and the key-space
 * augmentation. The type-level assertions here are compile-time checks that also read as
 * documentation of what the augmentation is supposed to allow and forbid.
 */
import { describe, expect, it } from "vitest";
import { definePlugin } from "@stargantt/core";
import type { ContributionOf, ResultOf, Services } from "@stargantt/core";
import type { Task } from "@stargantt/plugin-data-store";
import * as entry from "../src/index";
import { taskBars } from "../src/index";
import type {
  BarBox,
  BarLabelProvider,
  BarOverlayRenderer,
  BarStyle,
  BarStyleProvider,
  EndGutterContribution,
  ResolvedEndGutter,
  TaskBarsConfig,
  TaskBarsMessages,
  TaskBarsService,
} from "../src/index";

type Expect<T extends true> = T;
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
  ? true
  : false;

describe("entry exports", () => {
  it("exports the plugin factory and nothing else at runtime", () => {
    expect(Object.keys(entry)).toEqual(["taskBars"]);
    expect(typeof taskBars().setup).toBe("function");
  });

  it("is a factory producing a Plugin<void>, not a plain plugin const", () => {
    expect(typeof taskBars).toBe("function");
    type _ = Expect<Equal<ReturnType<typeof taskBars>, ReturnType<typeof definePlugin<void>>>>;
  });

  it("accepts an omitted and an empty config alike, producing independent instances", () => {
    const a = taskBars();
    const b = taskBars({});
    expect(a).not.toBe(b);
    expect(a.meta.id).toBe("stargantt.task-bars");
    expect(b.meta.id).toBe("stargantt.task-bars");
  });
});

describe("extension point declarations", () => {
  it("declares taskbars/overlays as a collect point", () => {
    type _c = Expect<Equal<ContributionOf<"taskbars/overlays">, BarOverlayRenderer>>;
    type _r = Expect<Equal<ResultOf<"taskbars/overlays">, BarOverlayRenderer[]>>;
    expect(true).toBe(true);
  });

  it("declares taskbars/style as a first point, reducing to a single provider", () => {
    type _c = Expect<Equal<ContributionOf<"taskbars/style">, BarStyleProvider>>;
    type _r = Expect<Equal<ResultOf<"taskbars/style">, BarStyleProvider>>;
    expect(true).toBe(true);
  });

  it("declares taskbars/endGutter as a reduce point over the resolved pair", () => {
    type _c = Expect<Equal<ContributionOf<"taskbars/endGutter">, EndGutterContribution>>;
    type _r = Expect<Equal<ResultOf<"taskbars/endGutter">, ResolvedEndGutter>>;
    expect(true).toBe(true);
  });
});

describe("service declaration", () => {
  it("augments the service key space with the geometry service", () => {
    type _ = Expect<Equal<Services["stargantt.task-bars"], TaskBarsService>>;
    expect(true).toBe(true);
  });

  it("keeps TaskBarsService to the three geometry queries and the presentation one", () => {
    type _ = Expect<
      Equal<keyof TaskBarsService, "barBoxOf" | "visibleBoxes" | "barRect" | "hasOwnBar">
    >;
    const stub: TaskBarsService = {
      barBoxOf: () => undefined,
      visibleBoxes: () => [],
      barRect: () => undefined,
      hasOwnBar: () => false,
    };
    expect(stub.barBoxOf("t")).toBeUndefined();
    expect(stub.visibleBoxes()).toEqual([]);
    expect(stub.barRect("t")).toBeUndefined();
    expect(stub.hasOwnBar("t")).toBe(false);
  });
});

describe("public type shapes", () => {
  it("keeps BarBox to an id, a rectangle and the two end gutters", () => {
    const box: BarBox = {
      id: "t",
      x: 1,
      y: 2,
      width: 3,
      height: 4,
      gutterStart: 0,
      gutterEnd: 0,
    };
    type _ = Expect<
      Equal<keyof BarBox, "id" | "x" | "y" | "width" | "height" | "gutterStart" | "gutterEnd">
    >;
    expect(box.id).toBe("t");
  });

  it("keeps BarStyle to an optional colour", () => {
    type _ = Expect<Equal<keyof BarStyle, "color">>;
    const empty: BarStyle = {};
    const coloured: BarStyle = { color: "#fff" };
    expect(empty.color).toBeUndefined();
    expect(coloured.color).toBe("#fff");
  });

  it("keeps TaskBarsConfig to the documented optional fields", () => {
    type _ = Expect<
      Equal<
        keyof TaskBarsConfig,
        | "label"
        | "labelBackdrop"
        | "messages"
        | "durationLabel"
        | "progressLabel"
        | "renderBar"
        | "milestoneShape"
        | "patternFill"
        | "barRadius"
        | "barIcons"
        | "avatar"
        | "collapsedSummary"
        | "expandedHitArea"
      >
    >;
    const empty: TaskBarsConfig = {};
    const labelled: TaskBarsConfig = { label: (task) => task.name };
    const messaged: TaskBarsConfig = { messages: { empty: "Nothing here" } };
    expect(empty.label).toBeUndefined();
    expect(typeof labelled.label).toBe("function");
    expect(messaged.messages?.empty).toBe("Nothing here");
  });

  it("keeps TaskBarsMessages to the single empty-state key", () => {
    type _ = Expect<Equal<keyof TaskBarsMessages, "empty">>;
    const messages: TaskBarsMessages = { empty: "No tasks" };
    expect(messages.empty).toBe("No tasks");
  });

  it("lets a label provider decline by returning undefined", () => {
    const provider: BarLabelProvider = (task: Readonly<Task>) =>
      task.type === "milestone" ? undefined : task.name;
    const bar: Task = { id: 1, parentId: null, name: "b", start: 0, end: 1 };
    expect(provider(bar)).toBe("b");
    expect(provider({ ...bar, type: "milestone" })).toBeUndefined();
  });

  it("lets a style provider decline by returning undefined", () => {
    const provider: BarStyleProvider = (task: Readonly<Task>) =>
      task.type === "milestone" ? { color: "#000" } : undefined;
    const milestone: Task = {
      id: 1,
      parentId: null,
      name: "m",
      start: 0,
      end: 0,
      type: "milestone",
    };
    expect(provider(milestone)).toEqual({ color: "#000" });
    expect(provider({ ...milestone, type: "task" })).toBeUndefined();
  });
});
