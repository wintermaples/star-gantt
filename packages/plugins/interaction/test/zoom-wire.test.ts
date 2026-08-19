// @vitest-environment happy-dom
/**
 * docs/specs/plugins/interaction.md §6.6 — the zoom feature wired into a real composition: slot
 * claim / arbitration, config presence gating (opt-in, disabled when the nest is omitted), button
 * dispatches through `stargantt.timeline`, and the internal fit / today / selection actions (no
 * `ZoomControlsService` in v2 — §2.4).
 */
import { describe, expect, it } from "vitest";
import { definePlugin } from "@stargantt/core";
import { task } from "./_fakes";
import { boot } from "./_zoom-fakes";

const MS_DAY = 86_400_000;
const CANDIDATES = ["top-left", "top-right", "bottom-left", "bottom-right"];

describe("presence gating (§6)", () => {
  it("mounts no toolbar and claims no slot when the nest is omitted", () => {
    const b = boot();
    expect(b.toolbar()).toBeNull();
    // The slot stays free: a probe claim afterward is granted.
    expect(b.ctx.claimSlot("overlay-corner", "bottom-right", CANDIDATES).granted).toBe(true);
  });

  it("enables with the mere presence of the nest, even `{}`", () => {
    const b = boot({ config: { zoomControls: {} } });
    expect(b.toolbar()).not.toBeNull();
  });
});

describe("the toolbar (§6.6)", () => {
  it("mounts every control by default, anchored bottom-right", () => {
    const b = boot({ config: { zoomControls: {} } });
    const bar = b.toolbar();
    expect(bar).not.toBeNull();
    expect(bar!.getAttribute("role")).toBe("toolbar");
    expect(b.button("in")).toBeTruthy();
    expect(b.button("out")).toBeTruthy();
    expect(b.button("fit")).toBeTruthy();
    expect(b.button("today")).toBeTruthy();
    expect(b.button("selection")).toBeTruthy();
    expect(b.slider()).toBeTruthy();
    expect(bar!.style.bottom).not.toBeUndefined();
    expect(bar!.style.right).not.toBeUndefined();
    expect(bar!.style.top).toBeUndefined();
    expect(bar!.style.left).toBeUndefined();
  });

  it("respects a configured position", () => {
    const b = boot({ config: { zoomControls: { position: "top-left" } } });
    const bar = b.toolbar()!;
    expect(bar.style.top).not.toBeUndefined();
    expect(bar.style.left).not.toBeUndefined();
    expect(bar.style.bottom).toBeUndefined();
    expect(bar.style.right).toBeUndefined();
  });

  it("boolean flags omit individual controls", () => {
    const b = boot({ config: { zoomControls: { slider: false, selectionButton: false } } });
    expect(b.slider()).toBeNull();
    expect(b.button("selection")).toBeNull();
    expect(b.button("fit")).toBeTruthy();
  });

  it("still claims its slot even when every control is switched off", () => {
    const b = boot({
      config: {
        zoomControls: {
          slider: false,
          zoomButtons: false,
          fitButton: false,
          todayButton: false,
          selectionButton: false,
        },
      },
    });
    expect(b.toolbar()).toBeNull();
    expect(b.ctx.claimSlot("overlay-corner", "bottom-right", CANDIDATES).granted).toBe(false);
  });

  it("syncs the slider/± state to the composed level on setup", () => {
    // The default ladder is year,quarter,month,week,day,hour; the fake's initial level is "day" (index 4).
    const b = boot({ config: { zoomControls: {} } });
    expect(b.slider()!.value).toBe("4");
    expect(b.button("in")!.disabled).toBe(false);
    expect(b.button("out")!.disabled).toBe(false);
  });
});

describe("overlay-corner arbitration (§3)", () => {
  it("first claimant wins; a later one gets a free alternative plus a warning pluginError", () => {
    const rival = definePlugin({
      meta: { id: "test.rival" },
      setup(ctx): void {
        ctx.claimSlot("overlay-corner", "bottom-right", CANDIDATES);
      },
    });
    const b = boot({ config: { zoomControls: {} }, extraPlugins: [rival] });
    expect(b.faults.length).toBeGreaterThan(0);
    // Free known slots after the rival's claim: bottom-left, top-left, top-right — lexicographically
    // smallest is "bottom-left".
    const bar = b.toolbar()!;
    expect(bar.style.bottom).not.toBeUndefined();
    expect(bar.style.left).not.toBeUndefined();
    expect(bar.style.right).toBeUndefined();
  });
});

describe("zoom stepping (§1.1, anchored-ladder behavior)", () => {
  it("the zoom-in button steps to the next finer level, anchored at the viewport center", () => {
    const b = boot({ config: { zoomControls: {} } });
    b.button("in")!.click();
    expect(b.zoomCalls).toEqual([{ id: "hour", anchorTime: 400_000_000 }]);
  });

  it("the zoom-out button steps to the next coarser level", () => {
    const b = boot({ config: { zoomControls: {} } });
    b.button("out")!.click();
    expect(b.zoomCalls).toEqual([{ id: "week", anchorTime: 400_000_000 }]);
  });

  it("the slider activates the id at its index and re-syncs from the timeline afterward", () => {
    const b = boot({ config: { zoomControls: {} } });
    const slider = b.slider()!;
    slider.value = "0"; // "year"
    slider.fire("input");
    expect(b.zoomCalls).toEqual([{ id: "year", anchorTime: 400_000_000 }]);
    expect(b.slider()!.value).toBe("0");
    expect(b.button("out")!.disabled).toBe(true); // coarsest end
  });

  it("respects a configured level ladder narrower than the built-in six", () => {
    const b = boot({
      config: { zoomControls: { levels: ["month", "day"] } },
      initialLevel: { id: "month", pxPerDay: 1.2, scales: [] },
    });
    expect(b.slider()!.max).toBe("1");
    b.button("in")!.click();
    expect(b.zoomCalls).toEqual([{ id: "day", anchorTime: 400_000_000 }]);
  });
});

describe("fit / today / selection (internal — no ZoomControlsService in v2, §2.4)", () => {
  it("fit-to-project centers the whole span at the densest level that fits, without a redundant zoom call", () => {
    const tasks = [task({ id: 1, start: 0, end: 10 * MS_DAY })];
    const b = boot({ config: { zoomControls: {} }, tasks });
    b.button("fit")!.click();
    // 10 days at "day" density (24px/day) needs 240px <= 800; "hour" would need 2400px, too wide —
    // "day" is the densest that fits, and it is already the active level, so no zoom call fires.
    expect(b.zoomCalls).toEqual([]);
    expect(b.scrolls.at(-1)).toEqual({ scrollLeft: 32 });
  });

  it("fit-to-project is a no-op with no tasks", () => {
    const b = boot({ config: { zoomControls: {} } });
    b.button("fit")!.click();
    expect(b.scrolls).toEqual([]);
  });

  it("today centers the start of the current UTC day, touching nothing else", () => {
    const b = boot({ config: { zoomControls: {} } });
    b.button("today")!.click();
    const todayStart = Math.floor(Date.now() / MS_DAY) * MS_DAY;
    expect(b.scrolls.at(-1)).toEqual({ scrollLeft: todayStart * 1e-6 - 400 });
    expect(b.zoomCalls).toEqual([]);
  });

  it("selection starts disabled, enables on selection, and jumps to the first selected task both ways", () => {
    const tasks = [
      task({ id: "a", start: 0, end: 10 * MS_DAY }),
      task({ id: "b", start: 20 * MS_DAY, end: 30 * MS_DAY }),
    ];
    const b = boot({ config: { zoomControls: {} }, tasks, rowOrder: ["a", "b"] });
    expect(b.button("selection")!.disabled).toBe(true);

    b.host.host.service("stargantt.selection").select(["b"]);
    expect(b.button("selection")!.disabled).toBe(false);

    b.button("selection")!.click();
    const mid = 25 * MS_DAY;
    expect(b.scrolls.at(-1)).toEqual({
      scrollLeft: mid * 1e-6 - 400,
      // row 1 (24px rows): yOf(1) = 24, + rowHeight/2 (12) - viewport.height/2 (300)
      scrollTop: 24 + 12 - 300,
    });

    b.host.host.service("stargantt.selection").clear();
    expect(b.button("selection")!.disabled).toBe(true);
  });

  it("selection is a no-op with an empty selection", () => {
    const b = boot({ config: { zoomControls: {} }, tasks: [task({ id: "a" })] });
    b.button("selection")!.click(); // disabled; harmless even if a click somehow reached it
    expect(b.scrolls).toEqual([]);
  });
});
