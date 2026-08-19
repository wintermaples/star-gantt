// @vitest-environment happy-dom
/**
 * The `view/bottomPanes` order contract end-to-end (docs/specs/plugins/resource.md §3.4/§4.2):
 * the resource-view panel (`stargantt.resource-view:panel`, order `-1`), the
 * load-chart band (`stargantt.load-chart:total`, order `0`) and the load-chart lanes
 * (`stargantt.load-chart:lanes`, order `1`) must sort in that exact ascending order when all three
 * are contributed together — "so a reader sees chart, resource view, total, lanes top to bottom"
 * (§3.4).
 *
 * The actual STACKING sort is `@stargantt/plugin-view`'s own `normalizeBottomContributions`
 * (`internal/panes/bottom-panes.ts`), already implemented and tested there; this suite does not
 * re-implement it. What is tested here is that THIS plugin's three areas each hand that sort the
 * correct `order` value — captured raw, in registration order, from a minimal `stargantt.view`
 * stub's `view/bottomPanes` extension point — and that sorting the raw array by `.order` alone
 * reproduces the documented top-to-bottom id sequence.
 */
import { collect, definePlugin } from "@stargantt/core";
import type { AnyPlugin } from "@stargantt/core";
import { dataStore } from "@stargantt/plugin-data-store";
import type { BottomPaneContribution } from "@stargantt/plugin-view";
import { createTestHost } from "@stargantt/sdk";
import { afterEach, describe, expect, it } from "vitest";
import { resource } from "../src/index";

const RESOURCE_VIEW_ID = "stargantt.resource-view:panel";
const LOAD_TOTAL_ID = "stargantt.load-chart:total";
const LOAD_LANES_ID = "stargantt.load-chart:lanes";

interface Stubs {
  raw: BottomPaneContribution[];
}

/** The minimal `stargantt.view` stand-in: just the `view/bottomPanes` collect point, captured raw
 *  (registration order, no sort) once `lifecycle/ready` fires. No height command, no theme/timeline
 *  service — this suite reads only `.id` and `.order`, neither of which any area computes lazily
 *  from a service. */
function viewStub(state: Stubs): AnyPlugin {
  return definePlugin({
    meta: { id: "stargantt.view" },
    setup(ctx) {
      const point = ctx.defineExtensionPoint(
        "view/bottomPanes",
        collect<BottomPaneContribution>(),
      );
      ctx.on("lifecycle/ready", () => {
        state.raw = [...point.get()];
      });
    },
  });
}

let hosts: ReturnType<typeof createTestHost>[] = [];

afterEach(() => {
  for (const h of hosts) h.dispose();
  hosts = [];
  document.body.innerHTML = "";
});

describe("view/bottomPanes order (§3.4/§4.2 — resource-view -1, band 0, lanes 1)", () => {
  it("each area contributes the documented order value", () => {
    const stubs: Stubs = { raw: [] };
    const element = document.createElement("div");
    document.body.append(element);
    const host = createTestHost({
      element,
      plugins: [
        dataStore(),
        viewStub(stubs),
        resource({
          view: { startOpen: true },
          loadChart: { total: true, lanes: true },
        }),
      ],
    });
    hosts.push(host);

    expect(stubs.raw).toHaveLength(3);
    const byId = new Map(stubs.raw.map((c) => [c.id, c]));
    expect([...byId.keys()].sort()).toEqual(
      [RESOURCE_VIEW_ID, LOAD_TOTAL_ID, LOAD_LANES_ID].sort(),
    );

    expect(byId.get(RESOURCE_VIEW_ID)?.order).toBe(-1);
    expect(byId.get(LOAD_TOTAL_ID)?.order).toBe(0);
    expect(byId.get(LOAD_LANES_ID)?.order).toBe(1);
  });

  it("sorting the raw contributions by .order alone reproduces the documented stacking order", () => {
    const stubs: Stubs = { raw: [] };
    const element = document.createElement("div");
    document.body.append(element);
    const host = createTestHost({
      element,
      plugins: [
        dataStore(),
        viewStub(stubs),
        resource({
          view: { startOpen: true },
          loadChart: { total: true, lanes: true },
        }),
      ],
    });
    hosts.push(host);

    const sorted = [...stubs.raw].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    expect(sorted.map((c) => c.id)).toEqual([RESOURCE_VIEW_ID, LOAD_TOTAL_ID, LOAD_LANES_ID]);
  });
});
