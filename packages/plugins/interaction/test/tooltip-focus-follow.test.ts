/**
 * Unit tests for `src/internal/tooltip/focus-follow.ts` — the focus-driven display cycle, driven
 * directly through its named transitions against port stand-ins, with no host and no DOM.
 *
 * docs/specs/plugins/interaction.md §6.4a "Focus-driven display".
 */
import { describe, expect, it } from "vitest";
import type { HitResult } from "@stargantt/plugin-view";
import { createFocusFollow } from "../src/internal/tooltip/focus-follow";
import type { FocusAnchor, FocusFollowPorts } from "../src/internal/tooltip/focus-follow";

interface FakePorts extends FocusFollowPorts {
  readonly log: string[];
  visible: boolean;
  anchors: Map<string | number, FocusAnchor>;
}

function fakePorts(): FakePorts {
  const log: string[] = [];
  const anchors = new Map<string | number, FocusAnchor>();
  const ports: FakePorts = {
    log,
    visible: false,
    anchors,
    anchorOf: (id) => anchors.get(id),
    show: (hit: Readonly<HitResult>, x, y) => {
      log.push(`show ${String(hit.id)}@${x},${y}`);
      ports.visible = true;
    },
    isVisible: () => ports.visible,
    hide: () => {
      log.push("hide");
      ports.visible = false;
    },
  };
  return ports;
}

describe("createFocusFollow", () => {
  it("shows the focused task's content anchored at its bottom-left corner", () => {
    const ports = fakePorts();
    ports.anchors.set("t1", { x: 5, y: 12 });
    createFocusFollow(ports).onFocusChanged("t1");
    expect(ports.log).toEqual(["show t1@5,12"]);
    expect(ports.visible).toBe(true);
  });

  it("dismisses when focus lands on nothing", () => {
    const ports = fakePorts();
    ports.anchors.set("t1", { x: 0, y: 0 });
    const follow = createFocusFollow(ports);
    follow.onFocusChanged("t1");
    follow.onFocusChanged(undefined);
    expect(ports.log).toEqual(["show t1@0,0", "hide"]);
  });

  it("dismisses when the focused task has no bar to anchor to", () => {
    const ports = fakePorts();
    ports.anchors.set("t1", { x: 0, y: 0 });
    const follow = createFocusFollow(ports);
    follow.onFocusChanged("t1");
    follow.onFocusChanged("unknown");
    expect(ports.log).toEqual(["show t1@0,0", "hide"]);
  });

  it("does nothing when focus moves to nothing and nothing was shown", () => {
    const ports = fakePorts();
    createFocusFollow(ports).onFocusChanged(undefined);
    expect(ports.log).toEqual([]);
  });

  it("leaves content resolution's decline (show never went visible) untracked as focus-shown", () => {
    // `show` records the call but `isVisible()` reports what actually happened; a decline must not
    // be mistaken for a focus-shown tooltip that a later blur would need to hide.
    const ports = fakePorts();
    ports.anchors.set("t1", { x: 0, y: 0 });
    // Override show to simulate a content decline: it "shows" the call but leaves nothing visible.
    ports.show = (hit) => {
      ports.log.push(`decline ${String(hit.id)}`);
    };
    const follow = createFocusFollow(ports);
    follow.onFocusChanged("t1");
    follow.onRootBlur(); // nothing focus-owned is visible, so this must be a no-op
    expect(ports.log).toEqual(["decline t1"]);
  });

  describe("onRootBlur", () => {
    it("dismisses a focus-shown tooltip", () => {
      const ports = fakePorts();
      ports.anchors.set("t1", { x: 1, y: 1 });
      const follow = createFocusFollow(ports);
      follow.onFocusChanged("t1");
      follow.onRootBlur();
      expect(ports.log).toEqual(["show t1@1,1", "hide"]);
    });

    it("does nothing when nothing is focus-shown", () => {
      const ports = fakePorts();
      createFocusFollow(ports).onRootBlur();
      expect(ports.log).toEqual([]);
    });

    it("leaves a pointer-shown tooltip alone", () => {
      const ports = fakePorts();
      const follow = createFocusFollow(ports);
      follow.onPointerShow();
      ports.visible = true; // a pointer trigger put something up, outside this cycle's knowledge
      follow.onRootBlur();
      expect(ports.log).toEqual([]);
      expect(ports.visible).toBe(true);
    });
  });

  describe("onPointerShow", () => {
    it("takes the panel over: a later root blur no longer dismisses it", () => {
      const ports = fakePorts();
      ports.anchors.set("t1", { x: 0, y: 0 });
      const follow = createFocusFollow(ports);
      follow.onFocusChanged("t1"); // focus-shown
      follow.onPointerShow(); // a pointer trigger takes over
      follow.onRootBlur();
      expect(ports.log).toEqual(["show t1@0,0"]); // no hide from the blur
    });
  });

  it("re-anchors on every focus move, resolving lazily", () => {
    const ports = fakePorts();
    ports.anchors.set("a", { x: 1, y: 2 });
    ports.anchors.set("b", { x: 3, y: 4 });
    const follow = createFocusFollow(ports);
    follow.onFocusChanged("a");
    follow.onFocusChanged("b");
    expect(ports.log).toEqual(["show a@1,2", "show b@3,4"]);
  });
});
