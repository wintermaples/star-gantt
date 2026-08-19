// @vitest-environment happy-dom
// Dashboard panel behavior over a real host and a real DOM (docs/specs/plugins/portfolio.md
// §3.6–§3.8), built on `sdk/testing`'s `createTestHost` (mock-service injection stands in for a
// composed `stargantt.view`). Covers the `renderWidget` latch surviving close/reopen, the PNG
// `stargantt.view` gate, and the panel's a11y invariants (progressbar triad matches the bar's
// width percentage, dialog focus in/out, the boot path skipping focus).
import { describe, expect, it } from "vitest";
import type { AnyPlugin } from "@stargantt/core";
import { createTestHost } from "@stargantt/sdk";
import { dataStore } from "@stargantt/plugin-data-store";
import { portfolio } from "../src/index";
import type { DashboardWidgetId } from "../src/index";
import { DAY0, MS_DAY, task } from "./_boot";

function bootChart(
  config: Parameters<typeof portfolio>[0] = undefined,
  extra: readonly AnyPlugin[] = [],
  withView = true,
) {
  const root = document.createElement("div");
  document.body.appendChild(root);
  const t = createTestHost({
    element: root,
    plugins: [dataStore(), ...extra, portfolio(config)],
    services: withView ? { "stargantt.view": {} } : {},
  });
  return {
    root,
    data: t.host.service("stargantt.data"),
    service: t.host.service("stargantt.dashboard"),
    on: t.host.on.bind(t.host),
    dispatch: t.host.dispatch.bind(t.host),
    dispose: () => {
      t.dispose();
      root.remove();
    },
  };
}

/** One animation frame of `sdk/frame`'s `createFrameScheduler`, awaited deterministically — never
 *  a fixed sleep (the `load-chart-wire.test.ts` convention: our own rAF callback, registered after
 *  the scheduler's, fires after it since real rAF (and happy-dom's polyfill) runs callbacks FIFO). */
const frame = (): Promise<void> =>
  new Promise((done) => {
    globalThis.requestAnimationFrame(() => done());
  });

function loadFixture(data: ReturnType<typeof bootChart>["data"]): void {
  data.load({
    tasks: [
      task("done", DAY0, DAY0 + 2 * MS_DAY, { progress: 1 }),
      task("late", DAY0 - 10 * MS_DAY, DAY0 - 8 * MS_DAY, { name: "Late one", progress: 0.5 }),
      task("running", DAY0, DAY0 + 10 * MS_DAY, { progress: 0.5 }),
    ],
  });
}

describe("panel gating on stargantt.view", () => {
  it("open() refuses without a composed stargantt.view; creates no DOM", () => {
    const b = bootChart(undefined, [], false);
    try {
      loadFixture(b.data);
      expect(b.service.open()).toBe(false);
      expect(b.root.querySelector(".sg-dashboard")).toBeNull();
      expect(b.service.isOpen()).toBe(false);
    } finally {
      b.dispose();
    }
  });

  it("exportReport('png') is undefined without stargantt.view; 'pdf' always succeeds", () => {
    const b = bootChart(undefined, [], false);
    try {
      loadFixture(b.data);
      expect(b.service.exportReport("png")).toBeUndefined();
      const pdf = b.service.exportReport("pdf");
      expect(typeof pdf).toBe("string");
    } finally {
      b.dispose();
    }
  });

  it("exportReport('png') returns a data URL once stargantt.view resolves", () => {
    // happy-dom's canvas has no real 2D backend (`getContext("2d")` answers `null`), the same gap
    // `tracking`'s own canvas-paint suites work around by stubbing the context directly — here the
    // whole prototype is stubbed for the call so the *gate* (not canvas rendering fidelity, which
    // `dataviz`/pixel testing is not this suite's job) is what gets proven: once `stargantt.view`
    // resolves, `exportReport("png")` reaches `exportPng` and returns its data URL instead of
    // bailing at the gate.
    const proto = HTMLCanvasElement.prototype;
    const originalGetContext = proto.getContext;
    const originalToDataUrl = proto.toDataURL;
    proto.getContext = function stubGetContext(id: string) {
      if (id !== "2d") return null;
      return { fillStyle: "", font: "", fillRect() {}, fillText() {} } as unknown as ReturnType<
        typeof originalGetContext
      >;
    } as typeof proto.getContext;
    proto.toDataURL = function stubToDataUrl() {
      return "data:image/png;base64,FAKE";
    };
    const b = bootChart();
    try {
      loadFixture(b.data);
      const url = b.service.exportReport("png");
      expect(typeof url).toBe("string");
      expect((url as string).startsWith("data:image/png")).toBe(true);
    } finally {
      proto.getContext = originalGetContext;
      proto.toDataURL = originalToDataUrl;
      b.dispose();
    }
  });
});

describe("open/close DOM", () => {
  it("open() mounts a labelled dialog with the configured widgets and emits dashboard/opened; close() removes it and emits dashboard/closed", () => {
    const b = bootChart({ dashboard: { widgets: ["summary", "overdue"] } });
    try {
      loadFixture(b.data);
      const opened: unknown[] = [];
      const closed: unknown[] = [];
      b.on("dashboard/opened", (e) => opened.push(e));
      b.on("dashboard/closed", (e) => closed.push(e));
      expect(b.service.open()).toBe(true);
      expect(opened).toHaveLength(1);
      expect(b.service.open()).toBe(true); // idempotent — no second emission
      expect(opened).toHaveLength(1);
      const root = b.root.querySelector(".sg-dashboard");
      expect(root).not.toBeNull();
      expect(root?.getAttribute("role")).toBe("dialog");
      expect(root?.getAttribute("aria-label")).toBe("Dashboard");
      expect(root?.textContent).toContain("Progress");
      expect(root?.textContent).toContain("Late one");
      expect(root?.textContent).not.toContain("Workload");
      b.service.close();
      expect(b.root.querySelector(".sg-dashboard")).toBeNull();
      expect(closed).toHaveLength(1);
      b.service.close(); // no-op — no second emission
      expect(closed).toHaveLength(1);
    } finally {
      b.dispose();
    }
  });

  it("Mark done commits one undoable task/update from the panel", () => {
    const b = bootChart({ dashboard: { widgets: ["overdue"] } });
    try {
      loadFixture(b.data);
      expect(b.service.open()).toBe(true);
      const buttons = [...(b.root.querySelectorAll("button") as unknown as HTMLButtonElement[])];
      const done = buttons.find((el) => el.textContent === "Mark done");
      expect(done).toBeDefined();
      done?.click();
      expect(b.data.getTask("late")?.progress).toBe(1);
    } finally {
      b.dispose();
    }
  });
});

describe("live refresh and refresh() (§3.8)", () => {
  it("a burst of task/update dispatches while open coalesces to exactly one dashboard/refreshed {cause:'data'} per frame", async () => {
    const b = bootChart({ dashboard: { widgets: ["summary"] } });
    try {
      loadFixture(b.data);
      expect(b.service.open()).toBe(true);
      const events: { cause: string }[] = [];
      b.on("dashboard/refreshed", (e) => events.push(e as { cause: string }));
      // A burst of three updates in the same tick, before any frame has a chance to run.
      b.dispatch("task/update", { id: "done", after: { progress: 0.5 } });
      b.dispatch("task/update", { id: "running", after: { progress: 0.6 } });
      b.dispatch("task/update", { id: "late", after: { progress: 0.7 } });
      expect(events).toHaveLength(0); // nothing synchronous — the scheduler coalesces to a frame
      await frame();
      expect(events).toEqual([{ cause: "data" }]);
    } finally {
      b.dispose();
    }
  });

  it("refresh() while the panel is closed recomputes nothing and emits no dashboard/refreshed", () => {
    const b = bootChart();
    try {
      loadFixture(b.data);
      expect(b.service.isOpen()).toBe(false);
      const events: unknown[] = [];
      b.on("dashboard/refreshed", (e) => events.push(e));
      b.service.refresh();
      expect(events).toHaveLength(0);
    } finally {
      b.dispose();
    }
  });

  it("refresh() while the panel is open recomputes and emits dashboard/refreshed {cause:'api'} synchronously", () => {
    const b = bootChart();
    try {
      loadFixture(b.data);
      expect(b.service.open()).toBe(true);
      const events: { cause: string }[] = [];
      b.on("dashboard/refreshed", (e) => events.push(e as { cause: string }));
      b.service.refresh();
      // Synchronous — no frame wait needed, unlike the coalesced data-change path above.
      expect(events).toEqual([{ cause: "api" }]);
    } finally {
      b.dispose();
    }
  });
});

describe("panel a11y invariants", () => {
  it("progressbar triad's aria-valuenow matches the meter bar's width percentage exactly", () => {
    const b = bootChart({ dashboard: { widgets: ["workload"] } });
    try {
      b.data.load({
        tasks: [task("t", DAY0, DAY0 + 3 * MS_DAY)],
        resources: [{ id: "r1", name: "Alice" }],
        assignments: [{ taskId: "t", resourceId: "r1", units: 1 }],
      });
      expect(b.service.open()).toBe(true);
      const bars = [...b.root.querySelectorAll('[role="progressbar"]')] as HTMLElement[];
      expect(bars.length).toBeGreaterThan(0);
      for (const bar of bars) {
        expect(bar.getAttribute("aria-valuemin")).toBe("0");
        expect(bar.getAttribute("aria-valuemax")).toBe("100");
        const now = Number(bar.getAttribute("aria-valuenow"));
        expect(Number.isFinite(now)).toBe(true);
        expect(now).toBeGreaterThanOrEqual(0);
        expect(now).toBeLessThanOrEqual(100);
        // The fill span's inline width encodes the identical rounded percentage.
        const fill = bar.firstElementChild as HTMLElement;
        expect(fill.getAttribute("style")).toContain(`width:${now}%`);
      }
    } finally {
      b.dispose();
    }
  });

  it("moves focus into the dialog on open and hands it back to the opener on close", () => {
    const b = bootChart();
    try {
      loadFixture(b.data);
      const opener = document.createElement("button");
      document.body.appendChild(opener);
      opener.focus();
      expect(document.activeElement).toBe(opener);
      expect(b.service.open()).toBe(true);
      const root = b.root.querySelector(".sg-dashboard") as HTMLElement;
      // Focus landed inside the dialog (its own first-focusable rule), so Escape is reachable
      // keyboard-only.
      expect(root.contains(document.activeElement)).toBe(true);
      b.service.close();
      expect(document.activeElement).toBe(opener);
      opener.remove();
    } finally {
      b.dispose();
    }
  });

  it("the dashboard.open:true boot path mounts without moving focus, and close() restores nothing", () => {
    const b = bootChart({ dashboard: { open: true } });
    try {
      loadFixture(b.data);
      expect(b.service.isOpen()).toBe(true);
      // No user gesture drove this open: page focus is left exactly where it was (idle = body).
      expect(document.activeElement).toBe(document.body);
      b.service.close();
      expect(document.activeElement).toBe(document.body);
    } finally {
      b.dispose();
    }
  });

  it("Escape closes the panel", () => {
    const b = bootChart({ dashboard: { open: true } });
    try {
      loadFixture(b.data);
      const root = b.root.querySelector(".sg-dashboard") as HTMLElement;
      root.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      expect(b.root.querySelector(".sg-dashboard")).toBeNull();
      expect(b.service.isOpen()).toBe(false);
    } finally {
      b.dispose();
    }
  });
});

describe("renderWidget (§3.7)", () => {
  it("is called once per configured widget, in order", () => {
    const seen: DashboardWidgetId[] = [];
    const b = bootChart({
      dashboard: {
        widgets: ["summary", "overdue", "status"],
        renderWidget: (_host, ctx) => void seen.push(ctx.widget),
      },
    });
    try {
      loadFixture(b.data);
      expect(b.service.open()).toBe(true);
      expect(seen).toEqual(["summary", "overdue", "status"]);
    } finally {
      b.dispose();
    }
  });

  it("a host body replaces the built-in rendering", () => {
    const b = bootChart({
      dashboard: {
        widgets: ["summary"],
        renderWidget: (host) => {
          const p = host.ownerDocument.createElement("p");
          p.textContent = "CUSTOM-SUMMARY-BODY";
          host.appendChild(p);
        },
      },
    });
    try {
      loadFixture(b.data);
      expect(b.service.open()).toBe(true);
      const root = b.root.querySelector(".sg-dashboard");
      expect(root?.textContent).toContain("CUSTOM-SUMMARY-BODY");
      expect(root?.textContent).not.toContain("% complete");
    } finally {
      b.dispose();
    }
  });

  it("a throwing seam is reported once, empties the body, and the built-in body fills it — the latch survives a close/reopen", () => {
    let calls = 0;
    const faults: { pluginId: string; error: unknown }[] = [];
    const b = bootChart({
      dashboard: {
        widgets: ["summary"],
        renderWidget: (host) => {
          calls++;
          const p = host.ownerDocument.createElement("p");
          p.textContent = "partial-before-throw";
          host.appendChild(p);
          throw new Error("boom");
        },
      },
    });
    try {
      loadFixture(b.data);
      b.on("core/pluginError", (e) => void faults.push(e));
      expect(b.service.open()).toBe(true);
      expect(calls).toBe(1);
      expect(faults.length).toBe(1);
      expect(faults[0]?.pluginId).toBe("stargantt.portfolio");
      let root = b.root.querySelector(".sg-dashboard");
      expect(root?.textContent).toContain("% complete");
      expect(root?.textContent).not.toContain("partial-before-throw");

      // Close and reopen: the seam is never called again, and no second report is emitted — a
      // close/reopen does NOT reset the latch (§3.7).
      b.service.close();
      expect(b.service.open()).toBe(true);
      expect(calls).toBe(1);
      expect(faults.length).toBe(1);
      root = b.root.querySelector(".sg-dashboard");
      expect(root?.textContent).toContain("% complete");
    } finally {
      b.dispose();
    }
  });

  it("ctx.markDone commits the same single undoable task/update the built-in button does", () => {
    let markDone: ((taskId: string) => void) | undefined;
    const b = bootChart({
      dashboard: {
        widgets: ["overdue"],
        renderWidget: (_host, ctx) => {
          markDone = (taskId) => ctx.markDone(taskId);
        },
      },
    });
    try {
      loadFixture(b.data);
      expect(b.service.open()).toBe(true);
      expect(markDone).toBeDefined();
      const transactions: unknown[] = [];
      b.on("data/didApplyTransaction", (e) => transactions.push(e.transaction));
      markDone?.("late");
      expect(b.data.getTask("late")?.progress).toBe(1);
      expect(transactions.length).toBe(1);
    } finally {
      b.dispose();
    }
  });
});
