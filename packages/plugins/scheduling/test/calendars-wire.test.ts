// @vitest-environment happy-dom
/**
 * `internal/calendars/wire.ts` end to end, through a real `@stargantt/core` host
 * (`createTestHost`, `@stargantt/sdk`'s public test harness) with `stargantt.view` /
 * `stargantt.timeline` / `stargantt.theme` / `stargantt.selection` supplied as mock services.
 *
 * §14 (amended, P4 review ruling) — every chart service `wireCalendars` reads is resolved PER USE
 * (`ctx.useOptional`, typed against the real `@stargantt/plugin-view` / `@stargantt/plugin-
 * interaction` service types), never latched at setup, because the core tiers plugins by
 * `dependsOn` alone and `meta.optional` does not order startup: in a real composition this
 * plugin's `setup()` can run before `stargantt.view`'s. `createTestHost`'s mock injection
 * additionally gives every registered plugin a real `dependsOn` edge onto its synthetic mock
 * provider (`@stargantt/sdk`'s `testing/host.ts`), forcing it into the earliest tier regardless —
 * so the mocks below resolve here even at setup time, which is why `links-host.test.ts` carries
 * the SEPARATE, real-tier discriminating regression test that this shortcut cannot substitute for.
 *
 * The shading layer's own pixel output is NOT re-verified here (no real `renderer/layers` point is
 * declared without the real view plugin, so nothing ever calls `draw()`): that is
 * `calendars-shading.test.ts`'s job, entirely hostless.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { definePlugin } from "@stargantt/core";
import type { AnyPlugin } from "@stargantt/core";
import { createTestHost } from "@stargantt/sdk";
import type { TestHost } from "@stargantt/sdk";
import { dataStore } from "@stargantt/plugin-data-store";
import type { DataService, TaskId } from "@stargantt/plugin-data-store";
import { scheduling } from "../src/index";
import type { SchedulingConfig } from "../src/index";
import type { CalendarsService } from "../src/internal/calendars/service";

const CAL = { id: "std", workingDays: [1, 2, 3, 4, 5], name: "Standard", isDefault: true };

function fakeView(): { invalidate: ReturnType<typeof vi.fn> } {
  return { invalidate: vi.fn() };
}
function fakeTimeline(pxPerMs = 1 / 86_400_000): { pxPerMs: number; tToX: (t: number) => number; xToT: (x: number) => number } {
  return { pxPerMs, tToX: (t) => t * pxPerMs, xToT: (x) => x / pxPerMs };
}
function fakeTheme(): { get: () => string } {
  return { get: () => "" };
}
function fakeSelection(ids: TaskId[]): { state: { get(): { taskIds: Set<TaskId> } } } {
  return { state: { get: () => ({ taskIds: new Set(ids) }) } };
}

let host: TestHost | undefined;
let mountedRoots: HTMLElement[] = [];
afterEach(() => {
  host?.dispose();
  host = undefined;
  for (const el of mountedRoots) el.remove();
  mountedRoots = [];
});

/**
 * `createTestHost` defaults to a *detached* element when none is supplied (`headlessElement()`),
 * so a real, `document`-connected root is created and attached here — the editor's panel is a
 * child of `ctx.root`, and every editor assertion below queries through the returned `root`
 * rather than the global `document`, which a detached subtree would never satisfy.
 */
function boot(
  config: SchedulingConfig,
  services: Record<string, unknown> = {},
  extra: readonly AnyPlugin[] = [],
): { host: TestHost; data: DataService; service: CalendarsService; root: HTMLElement } {
  const root = document.createElement("div");
  document.body.appendChild(root);
  mountedRoots.push(root);
  host = createTestHost({
    element: root,
    plugins: [dataStore(), scheduling(config), ...extra],
    services: { "stargantt.view": fakeView(), "stargantt.timeline": fakeTimeline(), "stargantt.theme": fakeTheme(), ...services },
  });
  return {
    host,
    root,
    data: host.host.service("stargantt.data"),
    service: host.host.service("stargantt.calendars"),
  };
}

describe("service provision", () => {
  it("provides `stargantt.calendars` and seeds the registry from config", () => {
    const { service } = boot({ calendars: { calendars: [CAL] } });
    expect(service.resolve("std")?.workingDays).toEqual([1, 2, 3, 4, 5]);
    expect(service.state.get().calendars).toHaveLength(1);
  });

  it("claims the order-8 `renderer/layers` shading key", () => {
    const { host: h } = boot({ calendars: { calendars: [CAL] } });
    const orders = h.host.orders("renderer/layers");
    expect(orders).toContainEqual({
      key: "stargantt.scheduling:shading",
      order: 8,
      pluginId: "stargantt.scheduling",
    });
  });

  it("seeds the initial explicit shade choice from config", () => {
    const other = { id: "other", workingDays: [0] };
    const { service } = boot({ calendars: { calendars: [CAL, other], shadeCalendar: "other" } });
    expect(service.state.get().shadeCalendar).toBe("other");
  });

  it("follows the registry default when no shadeCalendar is configured", () => {
    const { service } = boot({ calendars: { calendars: [CAL] } });
    expect(service.state.get().shadeCalendar).toBe("std");
  });
});

describe("repaint wiring", () => {
  it("repaints the view on a registry commit", () => {
    const view = fakeView();
    const { service } = boot({ calendars: { calendars: [CAL] } }, { "stargantt.view": view });
    const before = view.invalidate.mock.calls.length;
    service.setWorkingDays("std", [1, 2, 3]);
    expect(view.invalidate.mock.calls.length).toBeGreaterThan(before);
    expect(view.invalidate).toHaveBeenCalledWith("background");
  });

  it("repaints on setShadeCalendar too (§1.2 deviation)", () => {
    const view = fakeView();
    const { service } = boot({ calendars: { calendars: [CAL] } }, { "stargantt.view": view });
    view.invalidate.mockClear();
    service.setShadeCalendar(undefined);
    expect(view.invalidate).toHaveBeenCalledWith("background");
  });

  it("repaints on a data-store change (bulk load)", () => {
    const view = fakeView();
    const { data, service } = boot({ calendars: { calendars: [CAL] } }, { "stargantt.view": view });
    void service; // keep the calendars nest alive
    view.invalidate.mockClear();
    data.load({ tasks: [] });
    expect(view.invalidate).toHaveBeenCalledWith("background");
  });

  // This guard scopes the repaint/editor-refresh path to the BULK load only; an ordinary
  // transaction must never reach it. Losing that guard would rebuild the open editor's DOM —
  // wiping any uncommitted input text and focus — on every routine task edit, not just a bulk
  // reload.
  it("does NOT repaint or refresh the editor for an ordinary transaction (bulk-only guard)", () => {
    const view = fakeView();
    const { host: h, data, service, root } = boot(
      { calendars: { calendars: [CAL], editor: true } },
      { "stargantt.view": view },
    );
    data.load({ tasks: [{ id: "t1", parentId: null, name: "t1", start: 0, end: 1 }] });
    service.openEditor("std");
    const panel = root.querySelector(".sg-calendars-editor") as HTMLElement;
    const pickerBefore = panel.querySelector('[data-sg-calendars="picker"]');
    view.invalidate.mockClear();
    h.host.dispatch("task/update", { id: "t1", after: { name: "renamed" } });
    // The links area's OWN repaint wiring shares this same `stargantt.view` mock and legitimately
    // calls `invalidate("main"/"overlay")` on every transaction (§5.8) — irrelevant here. What
    // matters is that the calendars area's own repaint, `invalidate("background")`, did NOT fire.
    expect(view.invalidate).not.toHaveBeenCalledWith("background");
    // The editor's DOM was not rebuilt: the picker element is the exact same node.
    expect(panel.querySelector('[data-sg-calendars="picker"]')).toBe(pickerBefore);
  });

  it("still repaints and re-renders the open editor on a bulk load", () => {
    const view = fakeView();
    const { data, service, root } = boot(
      { calendars: { calendars: [CAL], editor: true } },
      { "stargantt.view": view },
    );
    service.openEditor("std");
    const panel = root.querySelector(".sg-calendars-editor") as HTMLElement;
    const pickerBefore = panel.querySelector('[data-sg-calendars="picker"]');
    view.invalidate.mockClear();
    data.load({ tasks: [] });
    expect(view.invalidate).toHaveBeenCalledWith("background");
    // The editor's DOM WAS rebuilt: a fresh picker element replaced the old one.
    expect(panel.querySelector('[data-sg-calendars="picker"]')).not.toBe(pickerBefore);
  });
});

describe("editor lifecycle", () => {
  it("is not mounted without an `editor` config", () => {
    const { service, root } = boot({ calendars: { calendars: [CAL] } });
    service.openEditor("std"); // openEditor() is a no-op harness call — no panel exists to open
    expect(root.querySelector(".sg-calendars-editor")).toBeNull();
  });

  it("mounts hidden, and open/close toggle it", () => {
    const { root } = boot({ calendars: { calendars: [CAL], editor: true } });
    const panel = root.querySelector(".sg-calendars-editor") as HTMLElement | null;
    expect(panel).not.toBeNull();
    expect(panel!.style.display).toBe("none");
  });

  it("openEditor() shows the panel and closeEditor() hides it again", () => {
    const { service, root } = boot({ calendars: { calendars: [CAL], editor: true } });
    service.openEditor("std");
    const panel = root.querySelector(".sg-calendars-editor") as HTMLElement;
    expect(panel.style.display).toBe("flex");
    service.closeEditor();
    expect(panel.style.display).toBe("none");
  });

  it("mounts on an openEditor() call from another plugin's own setup, before lifecycle/ready", () => {
    const opener = definePlugin({
      meta: { id: "test.opener", dependsOn: ["stargantt.scheduling"] },
      setup(ctx) {
        ctx.use("stargantt.calendars").openEditor("std");
      },
    });
    const { root } = boot({ calendars: { calendars: [CAL], editor: true } }, {}, [opener]);
    const panels = root.querySelectorAll(".sg-calendars-editor");
    expect(panels).toHaveLength(1);
    expect((panels[0] as HTMLElement).style.display).toBe("flex");
  });

  it("renders only the configured sections, in canonical order", () => {
    const { service, root } = boot({
      calendars: { calendars: [CAL], editor: { sections: ["periods", "days"] } },
    });
    service.openEditor("std");
    const panel = root.querySelector(".sg-calendars-editor") as HTMLElement;
    const handles = [...panel.querySelectorAll("[data-sg-calendars]")].map((el) =>
      el.getAttribute("data-sg-calendars"),
    );
    expect(handles).toContain("day-0");
    expect(handles).toContain("period-apply");
    expect(handles).not.toContain("hours-add");
  });

  it("refreshes the open panel on a registry commit", () => {
    const { service, root } = boot({ calendars: { calendars: [CAL], editor: true } });
    service.openEditor("std");
    service.define({ id: "extra", workingDays: [1] });
    const panel = root.querySelector(".sg-calendars-editor") as HTMLElement;
    const picker = panel.querySelector('[data-sg-calendars="picker"]') as HTMLSelectElement;
    expect([...picker.options].map((o) => o.value)).toContain("extra");
  });
});

describe("the assign section (§14 optional `stargantt.selection`)", () => {
  it("is absent without a selection service", () => {
    const { service, root } = boot({ calendars: { calendars: [CAL], editor: true } });
    service.openEditor("std");
    const panel = root.querySelector(".sg-calendars-editor") as HTMLElement;
    expect(panel.querySelector('[data-sg-calendars="assign"]')).toBeNull();
  });

  it("assigns the selected tasks when a selection service is mocked in", () => {
    const { service, data, root } = boot(
      { calendars: { calendars: [CAL], editor: true } },
      { "stargantt.selection": fakeSelection(["t1"]) },
    );
    data.load({ tasks: [{ id: "t1", parentId: null, name: "t1", start: 0, end: 1 }] });
    service.openEditor("std");
    const panel = root.querySelector(".sg-calendars-editor") as HTMLElement;
    const assign = panel.querySelector('[data-sg-calendars="assign"]') as HTMLButtonElement;
    expect(assign).not.toBeNull();
    assign.click();
    expect(data.getTask("t1")?.calendarId).toBe("std");
  });
});

describe("no `calendars` nest — dormant", () => {
  // B2 (P4 review ruling) — `stargantt.calendars` is provided UNCONDITIONALLY (§1.2/§11), exactly
  // like `stargantt.critical-path` (§1.3): only the shading layer and the editor stay nest-gated.
  it("still provides `stargantt.calendars` with an empty registry, but claims no shading layer order", () => {
    host = createTestHost({
      plugins: [dataStore(), scheduling({})],
      services: { "stargantt.view": fakeView(), "stargantt.timeline": fakeTimeline(), "stargantt.theme": fakeTheme() },
    });
    const service = host.host.getService("stargantt.calendars");
    expect(service).toBeDefined();
    expect(service!.state.get().calendars).toEqual([]);
    expect(service!.resolve("nonexistent" as never)).toBeUndefined();
    // No shading claim — the `dependencies` (links) area's own unconditional 69/110 claims are
    // filtered out here, since this assertion is about the calendars area specifically.
    expect(
      host.host.orders("renderer/layers").filter((c) => c.key === "stargantt.scheduling:shading"),
    ).toEqual([]);
  });
});
