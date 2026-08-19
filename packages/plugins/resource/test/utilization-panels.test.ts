// @vitest-environment happy-dom
// docs/specs/plugins/resource.md §3.5 (M8): the
// config-gated summary/trend panels must open at `lifecycle/ready`, not at `setup()` — a
// composition that lists `stargantt.view` AFTER `stargantt.resource` must still see them open,
// because `optional` is not an ordering edge (§9).
import { definePlugin } from "@stargantt/core";
import type { AnyPlugin } from "@stargantt/core";
import type { ViewService } from "@stargantt/plugin-view";
import { dataStore } from "@stargantt/plugin-data-store";
import { createTestHost } from "@stargantt/sdk";
import { afterEach, describe, expect, it } from "vitest";
import { resource } from "../src/index";

let root: HTMLElement | undefined;
afterEach(() => {
  root = undefined;
});

/** The minimal `stargantt.view` stand-in `panelHost()` needs: presence alone, no method calls. */
function viewStub(): AnyPlugin {
  return definePlugin({
    meta: { id: "stargantt.view" },
    setup(ctx) {
      ctx.provide("stargantt.view", {} as ViewService);
    },
  });
}

describe("M8: config-opened panels open at lifecycle/ready", () => {
  it("opens both panels even when the view plugin is listed AFTER resource() in the plugin list", () => {
    root = document.createElement("div");
    const harness = createTestHost({
      element: root,
      plugins: [
        dataStore(),
        // `resource()` composed BEFORE `viewStub()` — the ordering that would fail an eager
        // (setup-time) open.
        resource({ utilization: { summaryPanel: true, trendPanel: true } }),
        viewStub(),
      ],
    });
    try {
      expect(root.querySelector(".sg-ru-summary")).not.toBeNull();
      expect(root.querySelector(".sg-ru-trend")).not.toBeNull();
    } finally {
      harness.dispose();
    }
  });

  it("opens both panels when the view plugin is listed BEFORE resource() too (order-independent)", () => {
    root = document.createElement("div");
    const harness = createTestHost({
      element: root,
      plugins: [dataStore(), viewStub(), resource({ utilization: { summaryPanel: true, trendPanel: true } })],
    });
    try {
      expect(root.querySelector(".sg-ru-summary")).not.toBeNull();
      expect(root.querySelector(".sg-ru-trend")).not.toBeNull();
    } finally {
      harness.dispose();
    }
  });

  it("neither panel opens when the view plugin is absent — no crash, no DOM", () => {
    root = document.createElement("div");
    const harness = createTestHost({
      element: root,
      plugins: [dataStore(), resource({ utilization: { summaryPanel: true, trendPanel: true } })],
    });
    try {
      expect(root.querySelector(".sg-ru-summary")).toBeNull();
      expect(root.querySelector(".sg-ru-trend")).toBeNull();
    } finally {
      harness.dispose();
    }
  });

  it("neither panel opens unrequested (summaryPanel/trendPanel both omitted)", () => {
    root = document.createElement("div");
    const harness = createTestHost({
      element: root,
      plugins: [dataStore(), viewStub(), resource({ utilization: {} })],
    });
    try {
      expect(root.querySelector(".sg-ru-summary")).toBeNull();
      expect(root.querySelector(".sg-ru-trend")).toBeNull();
    } finally {
      harness.dispose();
    }
  });
});
