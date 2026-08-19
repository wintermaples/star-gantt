// @vitest-environment happy-dom
/**
 * `wireSidePanel` end to end: the `view/panes` contribution shape, selection-driven display and
 * editing through the real store, the `sidepanel/fields` collect point, config gating (§6.10), the
 * `renderBody` seam, and the `panelPaneResizeLabel` verbatim-empty-string divergence (§8).
 *
 * The real `stargantt.view` plugin needs a working 2D canvas context, which `happy-dom` cannot
 * supply (`getContext("2d")` returns `null` there — see `@stargantt/plugin-view`'s own
 * `test/view.test.ts`, which brings its own canvas-capable DOM harness for exactly this reason).
 * This file instead stands in for `stargantt.view`'s pane mechanism with a small plugin that
 * defines `view/panes` and mounts every collected contribution on `lifecycle/ready` — the same
 * point/timing the real plugin uses (`internal/panes/index.ts`) — so `wireSidePanel`'s own
 * contribution is exercised for real, without needing a real renderer.
 */
import { afterEach, describe, expect, it } from "vitest";
import { collect } from "@stargantt/core";
import { createTestHost, mockStore } from "@stargantt/sdk";
import type { AnyPlugin, PluginContext } from "@stargantt/core";
import { dataStore } from "@stargantt/plugin-data-store";
import { interaction } from "../src/index";
import type { SidePanelRenderContext } from "../src/internal/side-panel/types";
import { bars, rowsOf } from "./_fakes";

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 0, 5);

/** One pane mount the `view/panes` stand-in recorded. */
interface MountedPane {
  id: string;
  side: string;
  order: number;
  initialWidth: number;
  minWidth?: number | undefined;
  label?: string | undefined;
  el: HTMLElement;
}

function panesStub(mounted: MountedPane[]): AnyPlugin {
  return {
    meta: { id: "stargantt.view" },
    setup(ctx: PluginContext): void {
      ctx.provide("stargantt.view" as never, {
        invalidate: () => {},
        viewport: mockStore({ scrollLeft: 0, scrollTop: 0, width: 800, height: 600 }),
        scrollTo: () => {},
        chartPaneElement: () => document.createElement("div"),
      } as never);
      ctx.provide("stargantt.timeline" as never, {
        tToX: (t: number) => t * 1e-6,
        xToT: (x: number) => x / 1e-6,
        pxPerMs: 1e-6,
        zoomLevel: mockStore({ id: "day", pxPerDay: 86.4, scales: [{ unit: "day", format: () => "" }] }),
        requestOriginExtension: () => {},
        releaseOriginExtension: () => {},
      } as never);
      ctx.provide("stargantt.theme" as never, { get: () => "" } as never);
      // The same shape and timing (`lifecycle/ready`) `stargantt.view`'s real `internal/panes/`
      // module uses (docs/specs/plugins/view.md).
      const point = ctx.defineExtensionPoint(
        "view/panes" as never,
        collect() as never,
      ) as unknown as {
        get(): readonly {
          id: string;
          side: string;
          order: number;
          initialWidth: number;
          minWidth?: number;
          label?: string;
          mount(el: HTMLElement): void;
        }[];
      };
      ctx.on("lifecycle/ready", () => {
        for (const c of point.get()) {
          const el = document.createElement("div");
          c.mount(el);
          mounted.push({ id: c.id, side: c.side, order: c.order, initialWidth: c.initialWidth, minWidth: c.minWidth, label: c.label, el });
        }
      });
    },
  };
}

function boot(config: Parameters<typeof interaction>[0] = {}): {
  host: ReturnType<typeof createTestHost>;
  ctx: PluginContext;
  mounted: MountedPane[];
  faults: unknown[];
  pane(): HTMLElement;
} {
  const mounted: MountedPane[] = [];
  const faults: unknown[] = [];
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

  const treeGrid = provider("stargantt.tree-grid", {
    "stargantt.rows": rowsOf({ order: ["t1", "t2"] }),
    "stargantt.grid": { setSelected: () => {} },
  });
  const taskBars = provider("stargantt.task-bars", { "stargantt.task-bars": geometry });

  // Registered first (no dependencies of its own) so its `ctx.on()` subscription is live before
  // any later plugin's setup() runs — a `core/pluginError` a mount-time render faults with (the
  // `renderBody` seam runs synchronously inside `mount()`, which itself runs inside `start()`,
  // before `Gantt.create()`/`createTestHost()` returns) would otherwise be missed by a listener
  // attached only after boot.
  const collector: AnyPlugin = {
    meta: { id: "test.errors" },
    setup(ctx): void {
      ctx.on("core/pluginError", (e) => faults.push(e.error));
    },
  };

  const plugins: AnyPlugin[] = [collector, dataStore(), panesStub(mounted), treeGrid, taskBars, interaction(config)];
  const host = createTestHost({ plugins });
  host.host.service("stargantt.data").load([
    { id: "t1", name: "Design", start: T0, end: T0 + 5 * DAY, progress: 0.4 },
    { id: "t2", name: "Build", start: T0 + 5 * DAY, end: T0 + 10 * DAY },
  ]);

  return {
    host,
    ctx: host.ctxOf("stargantt.interaction"),
    mounted,
    faults,
    pane(): HTMLElement {
      const found = mounted.find((m) => m.id === "stargantt.interaction");
      if (found === undefined) throw new Error("side panel pane never mounted");
      return found.el;
    },
  };
}

let hosts: ReturnType<typeof boot>[] = [];
afterEach(() => {
  for (const h of hosts.splice(0)) h.host.dispose();
  hosts = [];
});

function booted(config?: Parameters<typeof interaction>[0]) {
  const b = boot(config);
  hosts.push(b);
  return b;
}

/**
 * Awaits one animation frame: the panel's own refreshes are batched to at most one per frame
 * (`createFrameScheduler`, real `requestAnimationFrame` under happy-dom), so a selection or store
 * change made in a test needs one frame before the DOM reflects it — this is the real scheduling
 * boundary the plugin uses outside tests too, not an arbitrary wait.
 */
function flushFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

/** Finds a built-in field input by its key suffix, independent of the per-instance id prefix
 *  (`instanceSeq` in `internal/side-panel/wire.ts` keeps counting across every test in this file). */
function fieldInput(root: HTMLElement, key: string): HTMLInputElement | null {
  return root.querySelector<HTMLInputElement>(`.sg-side-panel-input[id$="-${key}"]`);
}

describe("sidePanel: disabled when omitted", () => {
  it("mounts nothing at all", () => {
    const b = booted();
    expect(b.mounted).toEqual([]);
  });
});

describe("the view/panes contribution (§3)", () => {
  it("claims the right side, order 0, width 280/200, with the panelPaneResizeLabel divider name", () => {
    const b = booted({ sidePanel: {} });
    expect(b.mounted).toHaveLength(1);
    const [pane] = b.mounted;
    expect(pane?.side).toBe("right");
    expect(pane?.order).toBe(0);
    expect(pane?.initialWidth).toBe(280);
    expect(pane?.minWidth).toBe(200);
    expect(pane?.label).toBe("Resize pane");
  });

  it("takes an empty-string panelPaneResizeLabel verbatim (§8 merge rule)", () => {
    // The uniform §8 merge rule says any key's empty-string override is usable and taken
    // verbatim, and this plugin applies that rule uniformly.
    //
    // §6.10's accessible-name guard (the divider's actual `aria-label` falling back to "Resize pane"
    // whenever the resolved label is empty) is a SEPARATE, consumption-site concern owned by
    // `stargantt.view` (`internal/panes/divider.ts`), out of this plugin's file scope — and already
    // has real coverage against a rendered divider element there
    // (`packages/plugins/view/test/panes/panes.test.ts`, "divider accessibility" > "falls
    // back to the default name when a contribution's label is blank").
    const b = booted({ sidePanel: {}, messages: { panelPaneResizeLabel: "" } });
    expect(b.mounted[0]?.label).toBe("");
  });
});

describe("empty / multi / detail states, selection-driven", () => {
  it("shows the placeholder with nothing selected", () => {
    const b = booted({ sidePanel: {} });
    const empty = b.pane().querySelector<HTMLElement>(".sg-side-panel-empty");
    expect(empty?.style.display).not.toBe("none");
    expect(empty?.textContent).toBe("No task selected");
  });

  it("shows the multi-selection count, then the detail form for exactly one", async () => {
    const b = booted({ sidePanel: {} });
    const selection = b.host.host.service("stargantt.selection");
    selection.select(["t1", "t2"]);
    await flushFrame();
    const multi = b.pane().querySelector<HTMLElement>(".sg-side-panel-multi");
    expect(multi?.style.display).not.toBe("none");
    expect(multi?.textContent).toBe("2 tasks selected");

    selection.select(["t1"]);
    await flushFrame();
    const detail = b.pane().querySelector<HTMLElement>(".sg-side-panel-detail");
    expect(detail?.style.display).not.toBe("none");
    expect(fieldInput(b.pane(), "name")?.value).toBe("Design");
  });
});

describe("committing through the real store", () => {
  it("an accepted change() dispatches through the real command bus", async () => {
    const b = booted({ sidePanel: {} });
    b.host.host.service("stargantt.selection").select(["t1"]);
    await flushFrame();
    const name = fieldInput(b.pane(), "name");
    if (name === null) throw new Error("no name input");
    name.value = "Ship";
    name.dispatchEvent(new Event("change", { bubbles: true }));
    expect(b.host.host.service("stargantt.data").getTask("t1")?.name).toBe("Ship");
  });

  it("a rejected change marks the field with the panel*-prefixed cause text", async () => {
    const b = booted({ sidePanel: {} });
    b.host.host.service("stargantt.selection").select(["t1"]);
    await flushFrame();
    const end = fieldInput(b.pane(), "end");
    if (end === null) throw new Error("no end input");
    end.value = "2026-01-01"; // before start
    end.dispatchEvent(new Event("change", { bubbles: true }));
    expect(end.getAttribute("aria-invalid")).toBe("true");
    expect(b.host.host.service("stargantt.data").getTask("t1")?.end).toBe(T0 + 5 * DAY);
  });
});

describe("sidepanel/fields (collect)", () => {
  it("mounts a third-party contribution once, after the built-in content, and updates it on selection change", async () => {
    const updates: (readonly { id: unknown }[])[] = [];
    const contributor: AnyPlugin = {
      meta: { id: "test.field", dependsOn: ["stargantt.interaction"] },
      setup(ctx): void {
        ctx.contribute("sidepanel/fields" as never, {
          id: "custom",
          mount: (host: HTMLElement) => {
            host.textContent = "custom section";
            return { update: (tasks: readonly { id: unknown }[]) => updates.push(tasks) };
          },
        } as never);
      },
    };
    const mounted: MountedPane[] = [];
    const faults: unknown[] = [];
    const treeGrid: AnyPlugin = {
      meta: { id: "stargantt.tree-grid" },
      setup(ctx) {
        ctx.provide("stargantt.rows" as never, rowsOf({ order: ["t1", "t2"] }) as never);
        ctx.provide("stargantt.grid" as never, { setSelected: () => {} } as never);
      },
    };
    const taskBars: AnyPlugin = {
      meta: { id: "stargantt.task-bars" },
      setup(ctx) {
        ctx.provide(
          "stargantt.task-bars" as never,
          bars([{ id: "t1", x: 0, y: 0, width: 40, height: 20 }]) as never,
        );
      },
    };
    const host = createTestHost({
      plugins: [
        dataStore(),
        panesStub(mounted),
        treeGrid,
        taskBars,
        interaction({ sidePanel: {} }),
        contributor,
      ],
    });
    host.host.on("core/pluginError", (e) => faults.push(e.error));
    host.host.service("stargantt.data").load([{ id: "t1", name: "Design", start: T0, end: T0 + DAY }]);
    const pane = mounted.find((m) => m.id === "stargantt.interaction")?.el;
    expect(pane?.querySelector(".sg-side-panel-field--custom")?.textContent).toBe("custom section");
    // The mount-time render() already ran once (empty selection at that point); the update below
    // is the second call, driven by the selection store subscription.
    expect(updates).toEqual([[]]);
    host.host.service("stargantt.selection").select(["t1"]);
    await flushFrame();
    expect(updates).toHaveLength(2);
    expect(updates[1]?.map((t) => t.id)).toEqual(["t1"]);
    expect(faults).toEqual([]);
    host.dispose();
  });
});

describe("renderBody through the host", () => {
  it("a custom body commits through the real command bus via ctx.commit", async () => {
    const b = booted({
      sidePanel: {
        renderBody: (host: HTMLElement, ctx: SidePanelRenderContext) => {
          const button = document.createElement("button");
          button.className = "my-save";
          button.addEventListener("click", () => ctx.commit("name", "From the host"));
          host.appendChild(button);
        },
      },
    });
    b.host.host.service("stargantt.selection").select(["t1"]);
    await flushFrame();
    expect(b.pane().querySelector(".sg-side-panel-input")).toBeNull();
    b.pane().querySelector<HTMLElement>(".my-save")?.click();
    expect(b.host.host.service("stargantt.data").getTask("t1")?.name).toBe("From the host");
  });

  it("a throwing renderBody falls back to the built-in body and reports once", async () => {
    const b = booted({ sidePanel: { renderBody: () => { throw new Error("boom"); } } });
    b.host.host.service("stargantt.selection").select(["t1"]);
    await flushFrame();
    expect(b.faults).toHaveLength(1);
    expect(b.pane().querySelector(".sg-side-panel-input")).not.toBeNull();
  });

  it("a non-function renderBody counts as absent", async () => {
    const b = booted({ sidePanel: { renderBody: "nope" as unknown as () => void } });
    b.host.host.service("stargantt.selection").select(["t1"]);
    await flushFrame();
    expect(b.pane().querySelector(".sg-side-panel-input")).not.toBeNull();
    expect(b.faults).toEqual([]);
  });
});

describe("formatDate", () => {
  it("adds a read-only line per date field when configured", async () => {
    const b = booted({ sidePanel: { formatDate: (t: number) => `on ${t}` } });
    b.host.host.service("stargantt.selection").select(["t1"]);
    await flushFrame();
    const start = fieldInput(b.pane(), "start");
    const value = start?.parentElement?.querySelector(".sg-side-panel-value");
    expect(value?.textContent).toBe(`on ${T0}`);
  });

  it("a non-function formatDate counts as absent (no read-out node)", async () => {
    const b = booted({ sidePanel: {} });
    b.host.host.service("stargantt.selection").select(["t1"]);
    await flushFrame();
    const start = fieldInput(b.pane(), "start");
    expect(start?.parentElement?.querySelector(".sg-side-panel-value")).toBeNull();
  });
});
