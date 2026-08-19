/**
 * Hostless unit tests for the DOM-overlay feature: lazy creation, mount isolation, the
 * clip-host size and the scroll alignment. Driven against a fake `.sg-dom-overlay` region.
 */
import { describe, expect, it, vi } from "vitest";
import { createDomOverlays } from "../../src/internal/render/overlays";
import type { DomOverlayContribution } from "../../src/internal/render/index";
import { FakeDocument, asElement } from "../_utils/index";
import type { FakeElement } from "../_utils/index";

interface Harness {
  region: FakeElement;
  overlays: ReturnType<typeof createDomOverlays>;
  faults: unknown[];
  disposals: (() => void)[];
  scroll: { left: number; top: number };
  host(): FakeElement | undefined;
}

function harness(list: readonly DomOverlayContribution[] | undefined): Harness {
  const region = new FakeDocument().createElement("div");
  const faults: unknown[] = [];
  const disposals: (() => void)[] = [];
  const scroll = { left: 0, top: 0 };
  const overlays = createDomOverlays({
    region: asElement(region),
    contributions: () => list,
    scroll: () => scroll,
    own: (dispose) => disposals.push(dispose),
    onFault: (error) => faults.push(error),
  });
  return {
    region,
    overlays,
    faults,
    disposals,
    scroll,
    host: () => region.children.find((c) => c.className === "sg-dom-overlays"),
  };
}

const spy = (id: string, sink: FakeElement[]): DomOverlayContribution => ({
  id,
  mount: (wrapper) => sink.push(wrapper as unknown as FakeElement),
});

describe("createDomOverlays", () => {
  it("creates no clip host and no wrapper when nothing contributes", () => {
    const h = harness([]);
    h.overlays.build();
    h.overlays.resize(800, 600);
    h.overlays.sync(10, 20);
    expect(h.region.children).toEqual([]);
  });

  it("treats a missing point result as an empty list", () => {
    const h = harness(undefined);
    h.overlays.build();
    expect(h.region.children).toEqual([]);
  });

  it("creates the clip host with one wrapper per contribution, in collect order", () => {
    const mounted: FakeElement[] = [];
    const h = harness([spy("first", mounted), spy("second", mounted)]);
    h.overlays.build();

    const host = h.host();
    expect(host?.style["overflow"]).toBe("hidden");
    expect(host?.children.map((c) => c.getAttribute("data-overlay-id"))).toEqual([
      "first",
      "second",
    ]);
    expect(mounted).toHaveLength(2);
  });

  it("aligns a wrapper before mount ever sees it", () => {
    const mounted: FakeElement[] = [];
    const h = harness([spy("a", mounted)]);
    h.scroll.left = 30;
    h.scroll.top = 120;
    h.overlays.build();
    expect(mounted[0]?.style["transform"]).toBe("translate(-30px, -120px)");
  });

  it("keeps the clip host on the viewport rectangle, before and after the build (§4.2-3)", () => {
    const h = harness([spy("a", [])]);
    h.overlays.resize(800, 550);
    h.overlays.build();
    expect(h.host()?.style["width"]).toBe("800px");
    expect(h.host()?.style["height"]).toBe("550px");

    h.overlays.resize(500, 300);
    expect(h.host()?.style["width"]).toBe("500px");
    expect(h.host()?.style["height"]).toBe("300px");
  });

  it("translates every wrapper by the negated scroll offsets", () => {
    const mounted: FakeElement[] = [];
    const h = harness([spy("a", mounted), spy("b", mounted)]);
    h.overlays.build();
    h.overlays.sync(30, 120);
    for (const wrapper of mounted) {
      expect(wrapper.style["transform"]).toBe("translate(-30px, -120px)");
    }
  });

  it("calls mount exactly once, however often it is built", () => {
    const mount = vi.fn();
    const h = harness([{ id: "a", mount }]);
    h.overlays.build();
    h.overlays.build();
    expect(mount).toHaveBeenCalledTimes(1);
    expect(h.host()?.children).toHaveLength(1);
  });

  it("isolates a throwing mount, leaves its wrapper alone and mounts the rest", () => {
    const mounted: FakeElement[] = [];
    const h = harness([
      {
        id: "bad",
        mount: () => {
          throw new Error("mount failed");
        },
      },
      spy("good", mounted),
    ]);
    h.overlays.build();

    expect((h.faults[0] as Error).message).toBe("mount failed");
    expect(mounted.map((w) => w.getAttribute("data-overlay-id"))).toEqual(["good"]);
    expect(h.host()?.children).toHaveLength(2);
  });

  it("skips a value that is not a usable contribution, with no wrapper and no fault", () => {
    const bad = [null, 42, { id: "x" }];
    const h = harness([
      ...(bad as unknown as DomOverlayContribution[]),
      { id: "ok", mount: () => {} },
    ]);
    h.overlays.build();
    expect(h.host()?.children.map((c) => c.getAttribute("data-overlay-id"))).toEqual(["ok"]);
    expect(h.faults).toEqual([]);
  });

  it("hands the clip host and every wrapper to the core for disposal (§4.2-4)", () => {
    const h = harness([spy("a", []), spy("b", [])]);
    h.overlays.build();
    for (const dispose of h.disposals) dispose();
    expect(h.region.children).toEqual([]);
    // A sync after disposal touches nothing that is still attached.
    expect(() => h.overlays.sync(1, 1)).not.toThrow();
  });
});
