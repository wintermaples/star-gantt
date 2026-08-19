// @vitest-environment happy-dom
/**
 * `wireEditDialog` end to end: the `edit-dialog/open` command, the double-activation surfaces fed
 * by the gesture arbiter (docs/specs/plugins/interaction.md §1.1/§1.3), the selection sync, config
 * gating (§6.9), and committing through the real data store.
 *
 * Boots a real `@stargantt.interaction` composed with the real `@stargantt/plugin-data-store` (the
 * dialog's `apply` dispatches `task/update` against it) and service doubles for the other three
 * hard dependencies, mirroring `test/wiring.test.ts`'s own `boot()` (which this file cannot import —
 * it declares no exports — so a slimmed copy lives here, scoped to what the edit-dialog feature
 * needs).
 */
import { afterEach, describe, expect, it } from "vitest";
import { createTestHost, mockStore } from "@stargantt/sdk";
import type { AnyPlugin, PluginContext } from "@stargantt/core";
import { dataStore } from "@stargantt/plugin-data-store";
import type { TaskId } from "@stargantt/plugin-data-store";
import { interaction } from "../src/index";
import type { EditDialogRenderContext } from "../src/internal/edit-dialog/types";
import { bars, rowsOf } from "./_fakes";

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 0, 5);

function boot(
  config: Parameters<typeof interaction>[0] = {},
  options: { announcer?: boolean } = {},
): {
  host: ReturnType<typeof createTestHost>;
  ctx: PluginContext;
  spoken: string[];
  faults: unknown[];
  /** Every transaction the store actually applied (`data/didApplyTransaction`), in order. */
  transactions: unknown[];
  dialog(): HTMLElement | null;
  input(key: string): HTMLInputElement;
} {
  const spoken: string[] = [];
  const faults: unknown[] = [];
  const transactions: unknown[] = [];
  const geometry = bars([
    { id: "t1", x: 0, y: 0, width: 40, height: 20 },
    { id: "t2", x: 40, y: 24, width: 40, height: 20 },
  ]);

  const provider = (id: string, services: Record<string, unknown>): AnyPlugin => ({
    meta: { id },
    setup(ctx): void {
      for (const [key, impl] of Object.entries(services)) ctx.provide(key as never, impl as never);
    },
  });

  const view = provider("stargantt.view", {
    "stargantt.view": {
      invalidate: () => {},
      viewport: mockStore({ scrollLeft: 0, scrollTop: 0, width: 800, height: 600 }),
      scrollTo: () => {},
      chartPaneElement: () => document.createElement("div"),
    },
    "stargantt.timeline": {
      tToX: (t: number) => t * 1e-6,
      xToT: (x: number) => x / 1e-6,
      pxPerMs: 1e-6,
      zoomLevel: mockStore({ id: "day", pxPerDay: 86.4, scales: [{ unit: "day", format: () => "" }] }),
      requestOriginExtension: () => {},
      releaseOriginExtension: () => {},
    },
    "stargantt.theme": { get: () => "" },
  });
  const treeGrid = provider("stargantt.tree-grid", {
    "stargantt.rows": rowsOf({ order: ["t1", "t2"] }),
    "stargantt.grid": { setSelected: () => {} },
  });
  const taskBars = provider("stargantt.task-bars", { "stargantt.task-bars": geometry });

  const a11y: AnyPlugin = {
    meta: { id: "stargantt.a11y" },
    setup(ctx): void {
      ctx.provide("stargantt.focus" as never, {
        state: mockStore<{ focused: TaskId | undefined }>({ focused: undefined }),
        focus: () => undefined,
        announce: (text: string) => spoken.push(text),
      } as never);
    },
  };

  const plugins: AnyPlugin[] = [dataStore(), view, treeGrid, taskBars, interaction(config)];
  if (options.announcer === true) plugins.push(a11y);
  const host = createTestHost({ plugins });
  host.host.on("core/pluginError", (e) => faults.push(e.error));
  host.host.on("data/didApplyTransaction", (e) => transactions.push(e.transaction));
  host.host.service("stargantt.data").load([
    { id: "t1", name: "Design", start: T0, end: T0 + 5 * DAY, progress: 0.4 },
    { id: "t2", name: "Build", start: T0 + 5 * DAY, end: T0 + 10 * DAY },
  ]);

  return {
    host,
    ctx: host.ctxOf("stargantt.interaction"),
    spoken,
    faults,
    transactions,
    dialog: () => host.ctxOf("stargantt.interaction").root.querySelector<HTMLElement>(".sg-edit-dialog"),
    input: (key: string) => {
      const root = host.ctxOf("stargantt.interaction").root;
      for (const candidate of Array.from(root.querySelectorAll<HTMLInputElement>(".sg-edit-dialog-input"))) {
        if ((candidate.getAttribute("id") ?? "").endsWith(`-${key}`)) return candidate;
      }
      throw new Error(`no ${key} input`);
    },
  };
}

let hosts: ReturnType<typeof boot>[] = [];
afterEach(() => {
  for (const h of hosts.splice(0)) h.host.dispose();
});

function booted(config?: Parameters<typeof interaction>[0], options?: { announcer?: boolean }) {
  const b = boot(config, options);
  hosts.push(b);
  return b;
}

/**
 * A full bar click: down then up in place, on the same pointer, so the arbiter returns to `idle`
 * afterward and a following click can register as a fresh press (§1.3 `pressing` row: a second
 * `pointer/barDown` while a gesture is already armed is ignored outright).
 */
function barClick(ctx: PluginContext, id: TaskId, over: Record<string, unknown> = {}): void {
  const pointerId = 1;
  ctx.emit("pointer/barDown", {
    hit: { kind: "bar", id, cursor: "default" },
    x: 0,
    y: 0,
    event: { pointerId, clientX: 0, clientY: 0, buttons: 1, button: 0, type: "pointerdown", ...over } as never,
  });
  ctx.emit("pointer/barUp", {
    hit: { kind: "bar", id, cursor: "default" },
    x: 0,
    y: 0,
    event: { pointerId, clientX: 0, clientY: 0, buttons: 0, button: 0, type: "pointerup" } as never,
  });
}

/** A full grid-row click: down then up, same pointer. */
function rowClick(ctx: PluginContext, id: TaskId, over: Record<string, unknown> = {}): void {
  const pointerId = 1;
  ctx.emit("grid/rowPointerDown", {
    id,
    row: 0,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    button: 0,
    pointerId,
    x: 0,
    y: 0,
    clientX: 0,
    clientY: 0,
    ...over,
  } as never);
  ctx.emit("grid/rowPointerUp", { pointerId, x: 0, y: 0, clientX: 0, clientY: 0, cancelled: false } as never);
}

describe("editDialog: disabled when omitted", () => {
  it("mounts nothing and opens nothing on a double bar press", () => {
    const b = booted();
    barClick(b.ctx, "t1");
    barClick(b.ctx, "t1");
    expect(b.dialog()).toBeNull();
  });
});

describe("edit-dialog/open", () => {
  it("opens the dialog for the named task", () => {
    const b = booted({ editDialog: {} });
    b.host.host.dispatch("edit-dialog/open", { id: "t2" });
    expect(b.dialog()).not.toBeNull();
    expect(b.input("name").value).toBe("Build");
  });

  it("is a silent no-op for a task the store does not know", () => {
    const b = booted({ editDialog: {} });
    b.host.host.dispatch("edit-dialog/open", { id: "ghost" });
    expect(b.dialog()).toBeNull();
    expect(b.faults).toEqual([]);
  });

  it("still works when the double-click surfaces are off", () => {
    const b = booted({ editDialog: { openOnDoubleClick: false } });
    b.host.host.dispatch("edit-dialog/open", { id: "t1" });
    expect(b.dialog()).not.toBeNull();
  });

  it("makes the edited task the selection, and does not re-select one already selected", () => {
    const b = booted({ editDialog: {} });
    b.host.host.dispatch("edit-dialog/open", { id: "t1" });
    expect([...b.host.host.service("stargantt.selection").state.get().taskIds]).toEqual(["t1"]);
    b.dialog()?.querySelector<HTMLElement>(".sg-edit-dialog-cancel")?.click();
    const before = b.host.host.service("stargantt.selection").state.get();
    b.host.host.dispatch("edit-dialog/open", { id: "t1" });
    expect(b.host.host.service("stargantt.selection").state.get()).toBe(before);
  });

  it("replaces an already open dialog rather than stacking two", () => {
    const b = booted({ editDialog: {} });
    b.host.host.dispatch("edit-dialog/open", { id: "t1" });
    b.host.host.dispatch("edit-dialog/open", { id: "t2" });
    expect(b.ctx.root.querySelectorAll(".sg-edit-dialog")).toHaveLength(1);
    expect(b.input("name").value).toBe("Build");
  });
});

describe("double activation", () => {
  it("opens on a double bar press by default", () => {
    const b = booted({ editDialog: {} });
    barClick(b.ctx, "t1");
    expect(b.dialog()).toBeNull();
    barClick(b.ctx, "t1");
    expect(b.input("name").value).toBe("Design");
  });

  it("opens on a double grid-row press, and Save lands as one store update", () => {
    const b = booted({ editDialog: {} });
    rowClick(b.ctx, "t2");
    rowClick(b.ctx, "t2");
    const name = b.input("name");
    expect(name.value).toBe("Build");
    name.value = "Ship";
    b.dialog()?.querySelector<HTMLElement>(".sg-edit-dialog-save")?.click();
    expect(b.host.host.service("stargantt.data").getTask("t2")?.name).toBe("Ship");
    expect(b.dialog()).toBeNull();
  });

  it("two single presses on different tasks open nothing", () => {
    const b = booted({ editDialog: {} });
    barClick(b.ctx, "t1");
    barClick(b.ctx, "t2");
    expect(b.dialog()).toBeNull();
  });

  it("a modifier-held press never counts, on either surface", () => {
    const b = booted({ editDialog: {} });
    barClick(b.ctx, "t1", { shiftKey: true });
    barClick(b.ctx, "t1", { shiftKey: true });
    expect(b.dialog()).toBeNull();
  });

  it("a bar press and a row press on the same task never pair into one double-click", () => {
    const b = booted({ editDialog: {} });
    barClick(b.ctx, "t1");
    rowClick(b.ctx, "t1");
    expect(b.dialog()).toBeNull();
  });

  it("openOnDoubleClick: false suppresses both surfaces entirely", () => {
    const b = booted({ editDialog: { openOnDoubleClick: false } });
    barClick(b.ctx, "t1");
    barClick(b.ctx, "t1");
    rowClick(b.ctx, "t1");
    rowClick(b.ctx, "t1");
    expect(b.dialog()).toBeNull();
  });

  it("a menu press (right-click) between two left presses resets the detector too", () => {
    // Review round 1 minor-2: a press the arbiter diverts to the context menu must still reset the
    // double-activation detector, exactly like any other filtered press — otherwise two left
    // presses split by an intervening right press could still pair.
    const b = booted({ editDialog: {}, contextMenu: {} });
    barClick(b.ctx, "t1");
    barClick(b.ctx, "t1", { button: 2 });
    barClick(b.ctx, "t1");
    expect(b.dialog()).toBeNull();
  });

  it("a non-bar hit (resize handle) resets the bar detector too", () => {
    const b = booted({ editDialog: {} });
    barClick(b.ctx, "t1");
    const pointerId = 1;
    b.ctx.emit("pointer/barDown", {
      hit: { kind: "handle", id: "t1", cursor: "ew-resize" },
      x: 0,
      y: 0,
      event: { pointerId, clientX: 0, clientY: 0, buttons: 1, button: 0, type: "pointerdown" } as never,
    });
    b.ctx.emit("pointer/barUp", {
      hit: { kind: "handle", id: "t1", cursor: "ew-resize" },
      x: 0,
      y: 0,
      event: { pointerId, clientX: 0, clientY: 0, buttons: 0, button: 0, type: "pointerup" } as never,
    });
    barClick(b.ctx, "t1");
    expect(b.dialog()).toBeNull();
  });
});

describe("numeric task ids (major M1)", () => {
  // Review round 1 major M1: `idFromTarget()` sliced the arbiter's `"bar:<id>"` string, which
  // always yields a string and can never match a numeric `TaskId` in the store — the double
  // activation would silently do nothing. The fix carries the raw id alongside the detector-key
  // string instead of reconstructing it, so this must open for a numeric id on both surfaces.
  function bootNumeric(): { host: ReturnType<typeof createTestHost>; ctx: PluginContext; dialog(): HTMLElement | null } {
    const geometry = bars([{ id: 1, x: 0, y: 0, width: 40, height: 20 }]);
    const provider = (id: string, services: Record<string, unknown>): AnyPlugin => ({
      meta: { id },
      setup(ctx): void {
        for (const [key, impl] of Object.entries(services)) ctx.provide(key as never, impl as never);
      },
    });
    const view = provider("stargantt.view", {
      "stargantt.view": {
        invalidate: () => {},
        viewport: mockStore({ scrollLeft: 0, scrollTop: 0, width: 800, height: 600 }),
        scrollTo: () => {},
        chartPaneElement: () => document.createElement("div"),
      },
      "stargantt.timeline": {
        tToX: (t: number) => t * 1e-6,
        xToT: (x: number) => x / 1e-6,
        pxPerMs: 1e-6,
        zoomLevel: mockStore({ id: "day", pxPerDay: 86.4, scales: [{ unit: "day", format: () => "" }] }),
        requestOriginExtension: () => {},
        releaseOriginExtension: () => {},
      },
      "stargantt.theme": { get: () => "" },
    });
    const treeGrid = provider("stargantt.tree-grid", {
      "stargantt.rows": rowsOf({ order: [1] }),
      "stargantt.grid": { setSelected: () => {} },
    });
    const taskBars = provider("stargantt.task-bars", { "stargantt.task-bars": geometry });
    const plugins: AnyPlugin[] = [dataStore(), view, treeGrid, taskBars, interaction({ editDialog: {} })];
    const host = createTestHost({ plugins });
    host.host.service("stargantt.data").load([{ id: 1, name: "One", start: T0, end: T0 + DAY }]);
    return {
      host,
      ctx: host.ctxOf("stargantt.interaction"),
      dialog: () => host.ctxOf("stargantt.interaction").root.querySelector<HTMLElement>(".sg-edit-dialog"),
    };
  }

  it("opens on a double bar press with a numeric task id", () => {
    const b = bootNumeric();
    barClick(b.ctx, 1);
    expect(b.dialog()).toBeNull();
    barClick(b.ctx, 1);
    expect(b.dialog()).not.toBeNull();
    b.host.dispose();
  });

  it("opens on a double grid-row press with a numeric task id", () => {
    const b = bootNumeric();
    rowClick(b.ctx, 1);
    expect(b.dialog()).toBeNull();
    rowClick(b.ctx, 1);
    expect(b.dialog()).not.toBeNull();
    b.host.dispose();
  });
});

describe("committing through the real store", () => {
  it("commits every changed field as one undoable update", () => {
    const b = booted({ editDialog: {} });
    b.host.host.dispatch("edit-dialog/open", { id: "t1" });
    b.input("name").value = "Ship";
    b.input("end").value = "2026-01-12";
    b.input("progress").value = "0.8";
    b.dialog()?.querySelector<HTMLElement>(".sg-edit-dialog-save")?.click();
    // Review round 1 minor-6: the test name claims "one undoable update" — assert the transaction
    // count, not just the resulting field values.
    expect(b.transactions).toHaveLength(1);
    const t = b.host.host.service("stargantt.data").getTask("t1");
    expect(t?.name).toBe("Ship");
    expect(t?.end).toBe(Date.UTC(2026, 0, 12));
    expect(t?.progress).toBe(0.8);
  });

  it("announces a rejected Save through the optional focus service when one is composed", () => {
    const b = booted({ editDialog: {} }, { announcer: true });
    b.host.host.dispatch("edit-dialog/open", { id: "t1" });
    b.input("end").value = "2026-01-01";
    b.dialog()?.querySelector<HTMLElement>(".sg-edit-dialog-save")?.click();
    expect(b.spoken).toEqual(["End: invalid value, edit not applied"]);
    expect(b.dialog()).not.toBeNull();
  });

  it("says nothing, and still marks, without that service composed", () => {
    const b = booted({ editDialog: {} });
    b.host.host.dispatch("edit-dialog/open", { id: "t1" });
    b.input("end").value = "2026-01-01";
    b.dialog()?.querySelector<HTMLElement>(".sg-edit-dialog-save")?.click();
    expect(b.spoken).toEqual([]);
    expect(b.input("end").getAttribute("aria-invalid")).toBe("true");
  });

  it("disposing the chart closes an open dialog and leaves the root clean", () => {
    const b = booted({ editDialog: {} });
    b.host.host.dispatch("edit-dialog/open", { id: "t1" });
    expect(b.dialog()).not.toBeNull();
    b.host.host.dispose();
    hosts = hosts.filter((h) => h !== b);
    expect(b.ctx.root.querySelector(".sg-edit-dialog")).toBeNull();
  });
});

describe("renderBody through the host", () => {
  it("a custom body commits through the real command bus", () => {
    const b = booted({
      editDialog: {
        renderBody: (host: HTMLElement, ctx: EditDialogRenderContext) => {
          const button = document.createElement("button");
          button.className = "my-save";
          button.addEventListener("click", () => {
            ctx.setField("name", "From the host");
            ctx.commit();
          });
          host.appendChild(button);
        },
      },
    });
    b.host.host.dispatch("edit-dialog/open", { id: "t1" });
    expect(b.ctx.root.querySelector(".sg-edit-dialog-input")).toBeNull();
    b.ctx.root.querySelector<HTMLElement>(".my-save")?.click();
    expect(b.host.host.service("stargantt.data").getTask("t1")?.name).toBe("From the host");
    expect(b.dialog()).toBeNull();
  });

  it("a non-function renderBody counts as absent", () => {
    const b = booted({ editDialog: { renderBody: "nope" as unknown as () => void } });
    b.host.host.dispatch("edit-dialog/open", { id: "t1" });
    expect(b.ctx.root.querySelector(".sg-edit-dialog-input")).not.toBeNull();
    expect(b.faults).toEqual([]);
  });
});
