// @vitest-environment happy-dom
/**
 * The opt-in diagnostics panel: the pure corner-slot positioning (`panel.ts`'s `slotStyles` /
 * `isDiagnosticsCorner`, `wire.ts`'s `resolveCorner`), the panel DOM behavior (`createPanel`), and
 * the full `wireDiagnostics` area wired into a real `@stargantt/core` host — the `overlay-corner`
 * claim/alternative arbitration (§3.2, the four-corner precedent), `lifecycle/ready` mounting,
 * and `sdk/frame`'s rAF coalescing (§8).
 *
 * docs/specs/plugins/scheduling.md §8. Exercises behavior adapted to this package's abolished
 * service (§1.4 — no `stargantt.schedule-diagnostics`) and the new corner arbitration.
 *
 * Real happy-dom's `CSSStyleDeclaration` silently rejects `calc(...)` values assigned through
 * `Object.assign(el.style, {...})` (confirmed empirically — the same reason
 * `@stargantt/plugin-interaction`'s own `test/_zoom-dom.ts` exists), so corner *positioning* is
 * verified against `slotStyles`'s plain return value, never by reading `element.style.top` back out
 * of a real element; the DOM-behavior tests below verify content and interaction only.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestHost, mockStore } from "@stargantt/sdk";
import type { TestHost } from "@stargantt/sdk";
import { dataStore } from "@stargantt/plugin-data-store";
import type { DataService } from "@stargantt/plugin-data-store";
import type { AnyPlugin, PluginContext } from "@stargantt/core";
import { scheduling } from "../src/index";
import { DAY, task, link as testLink } from "./_helpers";
import { createPanel, DIAGNOSTICS_CORNERS, isDiagnosticsCorner, slotStyles } from "../src/internal/diagnostics/panel";
import { resolveCorner } from "../src/internal/diagnostics/wire";

/* ------------------------------------------------------------------ *
 * Pure: slotStyles / isDiagnosticsCorner / resolveCorner
 * ------------------------------------------------------------------ */

describe("slotStyles (corner positioning, pure)", () => {
  it("top-left sets top+left only", () => {
    const styles = slotStyles("top-left");
    expect(Object.keys(styles).sort()).toEqual(["left", "top"]);
    expect(styles["top"]).toContain("--sg-safe-top");
    expect(styles["left"]).toContain("--sg-safe-left");
  });

  it("bottom-right sets bottom+right only", () => {
    const styles = slotStyles("bottom-right");
    expect(Object.keys(styles).sort()).toEqual(["bottom", "right"]);
  });

  it.each(DIAGNOSTICS_CORNERS)("%s never mixes an opposite-edge pair", (corner) => {
    const styles = slotStyles(corner);
    const keys = Object.keys(styles);
    expect(keys.includes("top") && keys.includes("bottom")).toBe(false);
    expect(keys.includes("left") && keys.includes("right")).toBe(false);
  });
});

describe("isDiagnosticsCorner", () => {
  it("accepts exactly the four known corners", () => {
    for (const c of DIAGNOSTICS_CORNERS) expect(isDiagnosticsCorner(c)).toBe(true);
    expect(isDiagnosticsCorner("middle")).toBe(false);
    expect(isDiagnosticsCorner(undefined)).toBe(false);
  });
});

describe("resolveCorner", () => {
  it("keeps the requested corner when granted", () => {
    expect(resolveCorner({ granted: true })).toBe("top-left");
  });
  it("follows a known alternative when refused", () => {
    expect(resolveCorner({ granted: false, alternative: "bottom-right" })).toBe("bottom-right");
  });
  it("falls back to top-left when refused with no (or an unknown) alternative", () => {
    expect(resolveCorner({ granted: false })).toBe("top-left");
    expect(resolveCorner({ granted: false, alternative: "nowhere" })).toBe("top-left");
  });
});

/* ------------------------------------------------------------------ *
 * createPanel — DOM content and interaction (happy-dom, real elements)
 * ------------------------------------------------------------------ */

describe("createPanel", () => {
  function mount(opts: { sections?: { heading: string; items: string[] }[] } = {}) {
    const host = document.createElement("div");
    document.body.appendChild(host);
    let issueCount = 0;
    const panel = createPanel(
      host,
      { panelLabel: "Schedule diagnostics", noIssues: "No issues found", corner: "top-left" },
      {
        buttonText: () => `Diagnostics (${String(issueCount)})`,
        sections: () => opts.sections ?? [],
      },
    );
    host.appendChild(panel.root);
    return {
      host,
      panel,
      setIssueCount: (n: number) => {
        issueCount = n;
      },
      button: () => host.querySelector<HTMLButtonElement>(".sg-diagnostics-button")!,
      list: () => host.querySelector<HTMLElement>(".sg-diagnostics-panel")!,
    };
  }

  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("shows the toggle button text and starts collapsed", () => {
    const b = mount();
    expect(b.button().textContent).toBe("Diagnostics (0)");
    expect(b.button().getAttribute("aria-expanded")).toBe("false");
    expect(b.list().style.display).toBe("none");
  });

  it("opens on click, exposing role=group + aria-label and a click-focusable list", () => {
    const b = mount({ sections: [{ heading: "Unlinked tasks (1)", items: ["Floating work"] }] });
    b.button().click();
    expect(b.button().getAttribute("aria-expanded")).toBe("true");
    expect(b.list().style.display).toBe("block");
    expect(b.list().getAttribute("role")).toBe("group");
    expect(b.list().getAttribute("aria-label")).toBe("Schedule diagnostics");
    expect(b.list().tabIndex).toBe(-1);
  });

  it("renders one heading + <ul> per section, and the no-issues text when empty", () => {
    const b = mount({
      sections: [
        { heading: "Unlinked tasks (1)", items: ["Floating work"] },
        { heading: "Leads — negative lag (1)", items: ["Build → Ship (lag -1.5d)"] },
      ],
    });
    b.button().click();
    const headings = [...b.list().querySelectorAll(".sg-diagnostics-heading")].map((h) => h.textContent);
    expect(headings).toEqual(["Unlinked tasks (1)", "Leads — negative lag (1)"]);
    const items = [...b.list().querySelectorAll(".sg-diagnostics-items li")].map((li) => li.textContent);
    expect(items).toEqual(["Floating work", "Build → Ship (lag -1.5d)"]);
  });

  it("shows noIssues when the report is clean", () => {
    const b = mount({ sections: [] });
    b.button().click();
    expect(b.list().querySelector(".sg-diagnostics-empty")?.textContent).toBe("No issues found");
  });

  it("closes on Escape from inside the list and returns focus to the button", () => {
    const b = mount({ sections: [{ heading: "H", items: ["x"] }] });
    b.button().click();
    b.list().focus();
    b.list().dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(b.list().style.display).toBe("none");
    expect(document.activeElement).toBe(b.button());
  });

  it("refresh() re-derives the button text and rebuilds an open list", () => {
    const sections: { heading: string; items: string[] }[] = [];
    const b = mount({ sections });
    b.setIssueCount(2);
    b.panel.refresh();
    expect(b.button().textContent).toBe("Diagnostics (2)");
    b.button().click();
    sections.push({ heading: "New", items: ["a"] });
    b.panel.refresh();
    expect([...b.list().querySelectorAll(".sg-diagnostics-heading")].map((h) => h.textContent)).toEqual(["New"]);
  });

  it("contains() reports membership for the outside-click close pattern", () => {
    const b = mount();
    expect(b.panel.contains(b.button())).toBe(true);
    expect(b.panel.contains(document.body)).toBe(false);
  });

  it("close() is a no-op when already closed", () => {
    const b = mount();
    expect(() => b.panel.close()).not.toThrow();
    expect(b.list().style.display).toBe("none");
  });
});

/* ------------------------------------------------------------------ *
 * wireDiagnostics — the full area wired into a real host
 * ------------------------------------------------------------------ */

/**
 * Mocks for `stargantt.view` / `stargantt.timeline` / `stargantt.theme` / `stargantt.task-bars`.
 *
 * The diagnostics panel itself only ever reads `stargantt.view` (§14: `data` + `view` — see
 * `wireDiagnostics`'s own module doc), but `scheduling()` also composes the `dependencies` (links)
 * area unconditionally (§11 — enabled by default, no config gate), which reads all four chart
 * services too; providing all four here keeps this a realistic full-plugin boot rather than one
 * that happens to dodge links' own optional lookups. Every area degrades silently (§14) when any of
 * these is absent — see the "degradation without stargantt.view" describe block below.
 */
function viewMocks(pane: HTMLElement): Record<string, unknown> {
  return {
    "stargantt.view": {
      chartPaneElement: () => pane,
      invalidate: () => {},
      viewport: mockStore({ scrollLeft: 0, scrollTop: 0, width: 800, height: 600 }),
    },
    "stargantt.timeline": { pxPerMs: 1e-6, zoomLevel: mockStore({ id: "day", pxPerDay: 24 }) },
    "stargantt.theme": { get: () => "" },
    "stargantt.task-bars": {
      barRect: () => undefined,
      hasOwnBar: () => false,
      barBoxOf: () => undefined,
      visibleBoxes: () => [],
    },
  };
}

function bootWithView(
  config: Parameters<typeof scheduling>[0],
  extra: readonly AnyPlugin[] = [],
): { test: TestHost; pane: HTMLElement } {
  const pane = document.createElement("div");
  document.body.appendChild(pane);
  const test = createTestHost({
    plugins: [dataStore(), scheduling(config), ...extra],
    services: viewMocks(pane),
  });
  return { test, pane };
}

let booted: { test: TestHost; pane: HTMLElement } | undefined;
afterEach(() => {
  booted?.test.dispose();
  document.body.innerHTML = "";
  booted = undefined;
});

describe("presence gating (§11.5)", () => {
  it("mounts nothing without the diagnostics nest", () => {
    booted = bootWithView({});
    expect(booted.pane.querySelector(".sg-diagnostics")).toBeNull();
  });

  it("mounts nothing with diagnostics: {} (panel defaults false)", () => {
    booted = bootWithView({ diagnostics: {} });
    expect(booted.pane.querySelector(".sg-diagnostics")).toBeNull();
  });

  it("mounts the panel with diagnostics: { panel: true }", () => {
    booted = bootWithView({ diagnostics: { panel: true } });
    expect(booted.pane.querySelector(".sg-diagnostics")).not.toBeNull();
  });
});

describe("overlay-corner arbitration (§3.2)", () => {
  const CANDIDATES = ["top-left", "top-right", "bottom-left", "bottom-right"];

  it("claims top-left when free, refusing a probe claim of the same corner afterward", () => {
    booted = bootWithView({ diagnostics: { panel: true } });
    const ctx = booted.test.ctxOf("stargantt.scheduling");
    const grant = ctx.claimSlot("overlay-corner", "top-left", CANDIDATES as never);
    expect(grant.granted).toBe(false);
  });

  it("a rival claiming top-left first pushes the panel to a free alternative and reports a fault", () => {
    const faults: unknown[] = [];
    const faultRecorder: AnyPlugin = {
      meta: { id: "test.fault-recorder" },
      setup(ctx: PluginContext): void {
        ctx.on("core/pluginError", (e) => faults.push(e.error));
      },
    };
    const rival: AnyPlugin = {
      meta: { id: "test.rival" },
      setup(ctx: PluginContext): void {
        ctx.claimSlot("overlay-corner", "top-left", CANDIDATES);
      },
    };
    // `faultRecorder` and `rival` both run in an earlier topological tier than `scheduling` (which
    // depends on `stargantt.data-store`), so the rival's claim — and the arbitration registry's own
    // warning-level report for the later, refused claimant — both land before `wireDiagnostics`
    // claims its own corner.
    booted = bootWithView({ diagnostics: { panel: true } }, [faultRecorder, rival]);
    expect(booted.pane.querySelector(".sg-diagnostics")).not.toBeNull();
    expect(faults.length).toBeGreaterThan(0);
  });
});

/* ------------------------------------------------------------------ *
 * A deterministic `requestAnimationFrame` double (own, prefixed `Diag*`)
 * ------------------------------------------------------------------ */
// gantt-ui-ux code-quality: "no fixed sleeps" — `createFrameScheduler` (§8) schedules a real
// `requestAnimationFrame` callback; this double lets a test flush it synchronously instead of
// awaiting a real timer, mirroring `@stargantt/plugin-tree-grid`'s own `test/frame-throttle.test.ts`
// `installRaf` pattern (trimmed to the one thing these tests need: flush the next queued frame).

type MutableGlobal = Record<string, unknown>;

function installDiagRaf(): { flush(): void; restore(): void } {
  const g = globalThis as unknown as MutableGlobal;
  const saved = { raf: g["requestAnimationFrame"], caf: g["cancelAnimationFrame"] };
  const queue = new Map<number, () => void>();
  let nextId = 1;
  g["requestAnimationFrame"] = (cb: () => void): number => {
    const id = nextId++;
    queue.set(id, cb);
    return id;
  };
  g["cancelAnimationFrame"] = (id: number): void => {
    queue.delete(id);
  };
  return {
    flush(): void {
      const batch = [...queue.values()];
      queue.clear();
      for (const cb of batch) cb();
    },
    restore(): void {
      g["requestAnimationFrame"] = saved.raf;
      g["cancelAnimationFrame"] = saved.caf;
    },
  };
}

describe("panel content over a real composition (rAF-coalesced, §8)", () => {
  let raf: { flush(): void; restore(): void };
  beforeEach(() => {
    raf = installDiagRaf();
  });
  afterEach(() => {
    raf.restore();
  });

  function loadSample(test: TestHost): void {
    const data = test.host.service("stargantt.data") as DataService;
    data.load({
      tasks: [
        task("root", 0, 10 * DAY, { type: "summary", name: "Phase" }),
        task("a", 0, 3 * DAY, { parentId: "root", name: "Design" }),
        task("b", 3 * DAY, 5 * DAY, { name: "Build" }),
        task("c", 8 * DAY, 9 * DAY, { type: "milestone", name: "Ship" }),
        task("island", 2 * DAY, 4 * DAY, { name: "Floating work" }),
      ],
      links: [testLink("l1", "a", "b"), testLink("l2", "b", "c", "FS", -1.5 * DAY)],
    });
  }

  it("shows the finding count in the button text after the coalesced frame flushes", () => {
    booted = bootWithView({ diagnostics: { panel: true } });
    loadSample(booted.test);
    raf.flush();
    const button = booted.pane.querySelector(".sg-diagnostics-button");
    expect(button?.textContent).toBe("Diagnostics (2)"); // 1 orphan ("island") + 1 lead (b -> c)
  });

  it("opens to show one section per non-empty category, using the shared message catalog", () => {
    booted = bootWithView({ diagnostics: { panel: true } });
    loadSample(booted.test);
    raf.flush();
    const button = booted.pane.querySelector<HTMLButtonElement>(".sg-diagnostics-button")!;
    button.click();
    const list = booted.pane.querySelector(".sg-diagnostics-panel")!;
    const headings = [...list.querySelectorAll(".sg-diagnostics-heading")].map((h) => h.textContent);
    expect(headings).toEqual(["Unlinked tasks (1)", "Leads — negative lag (1)"]);
    const items = [...list.querySelectorAll(".sg-diagnostics-items li")].map((li) => li.textContent);
    expect(items).toEqual(["Floating work", "Build → Ship (lag -1.5d)"]);
  });

  it("uses replaced messages", () => {
    booted = bootWithView({
      diagnostics: { panel: true },
      messages: { orphanHeading: (n) => `未接続 (${String(n)})` },
    });
    loadSample(booted.test);
    raf.flush();
    booted.pane.querySelector<HTMLButtonElement>(".sg-diagnostics-button")!.click();
    const headings = [...booted.pane.querySelectorAll(".sg-diagnostics-heading")].map((h) => h.textContent);
    expect(headings[0]).toBe("未接続 (1)");
  });

  it("closes on an outside pointerdown, ignores presses inside the panel", () => {
    booted = bootWithView({ diagnostics: { panel: true } });
    loadSample(booted.test);
    raf.flush();
    const button = booted.pane.querySelector<HTMLButtonElement>(".sg-diagnostics-button")!;
    button.click();
    const list = booted.pane.querySelector<HTMLElement>(".sg-diagnostics-panel")!;
    expect(list.style.display).toBe("block");

    list.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    expect(list.style.display).toBe("block"); // inside press: stays open

    document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    expect(list.style.display).toBe("none"); // outside press: closes
  });

  it("removes its DOM on dispose", () => {
    booted = bootWithView({ diagnostics: { panel: true } });
    loadSample(booted.test);
    raf.flush();
    expect(booted.pane.querySelector(".sg-diagnostics")).not.toBeNull();
    booted.test.dispose();
    expect(booted.pane.querySelector(".sg-diagnostics")).toBeNull();
  });
});

/* ------------------------------------------------------------------ *
 * Degradation without `stargantt.view` — a REAL host, no chart surface composed at all
 * ------------------------------------------------------------------ */
//
// §14 (amended, M5) — `view` is optional with inert degradation: absent, the panel never mounts,
// and this stays SILENT (no `core/pluginError`, reserved for foreign-code faults). Exercised
// against a genuine `scheduling()` composition with no `stargantt.view` mocked in at all — every
// area of the plugin (links included) already degrades the same way, so nothing needs bypassing.

describe("diagnostics degradation without stargantt.view (real host, no chart surface)", () => {
  it("mounts nothing and reports no fault when stargantt.view is absent", () => {
    const faults: unknown[] = [];
    const faultRecorder: AnyPlugin = {
      meta: { id: "test.fault-recorder" },
      setup(ctx: PluginContext): void {
        ctx.on("core/pluginError", (e) => faults.push(e.error));
      },
    };
    const test = createTestHost({
      plugins: [dataStore(), scheduling({ diagnostics: { panel: true } }), faultRecorder],
    });
    try {
      // No `stargantt.view` composed at all, so there is no chart pane anywhere to have mounted
      // a panel into; the assertion that matters is the silence — no fault, nothing thrown.
      expect(document.querySelector(".sg-diagnostics")).toBeNull();
      expect(faults).toHaveLength(0);
      expect(() => test.ctxOf("stargantt.scheduling")).not.toThrow();
    } finally {
      test.dispose();
    }
  });

  it("mounts normally once stargantt.view IS present", () => {
    booted = bootWithView({ diagnostics: { panel: true } });
    expect(booted.pane.querySelector(".sg-diagnostics")).not.toBeNull();
  });
});
