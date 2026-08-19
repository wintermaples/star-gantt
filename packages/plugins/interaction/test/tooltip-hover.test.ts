/**
 * Unit tests for `src/internal/tooltip/hover.ts` — the show/hide state machine, driven directly
 * through its named transitions against a panel stand-in, with fake timers and no host and no DOM.
 *
 * The transition table under test (docs/specs/plugins/interaction.md §6.4, §6.4a):
 *
 * | Input | Effect |
 * |---|---|
 * | `onClick(hit)` | drops both timers, lifts any dismissal, shows now (or hides when content declines) and tracks the hit |
 * | `onHit(hit)` — new target | drops the hide timer, hides at once, arms `showDelay` for the new target |
 * | `onHit(hit)` — tracked target | drops the hide timer; changes nothing else while shown or still counting down |
 * | `onHit(hit)` — dismissed target | keeps it tracked and stays down, however long the pointer dwells |
 * | `onLeave()` | drops the show timer, lifts the dismissal, arms `hideDelay` when shown, else forgets the target |
 * | `onPanelEnter()` / `onPanelLeave()` | cancels / re-arms the same `hideDelay` |
 * | `onDismiss()` | drops both timers, sticks the dismissal to the tracked target, hides |
 * | `onScroll()` | drops both timers, forgets tracked and dismissed, hides |
 * | `onSuppress()` | drops both timers, hides, keeps the tracked target |
 * | `cancelTimers()` | drops both timers |
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { vi } from "vitest";
import type { HitResult } from "@stargantt/plugin-view";
import { createHoverMachine, hitKey } from "../src/internal/tooltip/hover";
import type { HoverPanelPort } from "../src/internal/tooltip/hover";

function hit(kind: HitResult["kind"], id: string | number): HitResult {
  return { kind, id, cursor: "pointer" };
}

interface FakePanel extends HoverPanelPort {
  /** What is on screen right now: the shown key plus its coordinates, or `null`. */
  readonly shown: { key: string; x: number; y: number } | null;
  /** Every `show` / `hide` call in order, `show` recorded as `show <key>@<x>,<y>`. */
  readonly log: string[];
  /** Keys the content resolution declines for (i.e. `show` returns `false`). */
  readonly declined: Set<string>;
}

/** A panel stand-in: it models visibility and remembers what it was asked to do. */
function fakePanel(): FakePanel {
  let shown: { key: string; x: number; y: number } | null = null;
  const log: string[] = [];
  const declined = new Set<string>();
  return {
    get shown(): { key: string; x: number; y: number } | null {
      return shown;
    },
    log,
    declined,
    isVisible: () => shown !== null,
    show(h, x, y): boolean {
      const key = hitKey(h);
      if (declined.has(key)) {
        log.push(`decline ${key}`);
        return false;
      }
      log.push(`show ${key}@${x},${y}`);
      shown = { key, x, y };
      return true;
    },
    hide(): void {
      log.push("hide");
      shown = null;
    },
  };
}

const DELAYS = { showDelay: 300, hideDelay: 100 };

describe("hitKey", () => {
  it("separates the two hit kinds of one task", () => {
    expect(hitKey(hit("bar", "t1"))).not.toBe(hitKey(hit("handle", "t1")));
  });

  it("separates two tasks of one kind, numeric ids included", () => {
    expect(hitKey(hit("bar", 1))).not.toBe(hitKey(hit("bar", 2)));
    expect(hitKey(hit("bar", 1))).toBe(hitKey(hit("bar", 1)));
  });
});

describe("hover state machine", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  describe("onClick (the click/both trigger show)", () => {
    it("shows at once at the event coordinates", () => {
      const panel = fakePanel();
      createHoverMachine(panel, DELAYS).onClick(hit("bar", 1), 3, 4);
      expect(panel.shown).toEqual({ key: "bar:1", x: 3, y: 4 });
      expect(panel.log).toEqual(["show bar:1@3,4"]);
    });

    it("hides when the content resolution declines", () => {
      const panel = fakePanel();
      panel.declined.add("bar:1");
      createHoverMachine(panel, DELAYS).onClick(hit("bar", 1), 0, 0);
      expect(panel.shown).toBeNull();
      expect(panel.log).toEqual(["decline bar:1", "hide"]);
    });

    it("tracks the clicked target, so the next hover sample over it is a continuation", () => {
      const panel = fakePanel();
      const hover = createHoverMachine(panel, DELAYS);
      hover.onClick(hit("bar", 1), 3, 4);
      hover.onHit(hit("bar", 1), 3, 4);
      vi.advanceTimersByTime(1000);
      // No hide and no re-show: the click's tooltip simply stayed up.
      expect(panel.log).toEqual(["show bar:1@3,4"]);
      expect(panel.shown).toEqual({ key: "bar:1", x: 3, y: 4 });
    });

    it("forgets the target when the content declines, so a later hover starts a fresh cycle", () => {
      const panel = fakePanel();
      const hover = createHoverMachine(panel, DELAYS);
      panel.declined.add("bar:1");
      hover.onClick(hit("bar", 1), 0, 0);
      panel.declined.clear();
      hover.onHit(hit("bar", 1), 5, 6);
      vi.advanceTimersByTime(300);
      expect(panel.shown).toEqual({ key: "bar:1", x: 5, y: 6 });
    });

    it("cancels a hover show already counting down and wins outright", () => {
      const panel = fakePanel();
      const hover = createHoverMachine(panel, DELAYS);
      hover.onHit(hit("bar", 1), 10, 10);
      vi.advanceTimersByTime(100);
      hover.onClick(hit("bar", 1), 1, 1);
      vi.advanceTimersByTime(1000);
      expect(panel.log).toEqual(["show bar:1@1,1"]);
    });

    it("cancels a pending hover-end hide", () => {
      const panel = fakePanel();
      const hover = createHoverMachine(panel, DELAYS);
      hover.onHit(hit("bar", 1), 0, 0);
      vi.advanceTimersByTime(300);
      hover.onLeave(); // hide counting down
      hover.onClick(hit("bar", 1), 1, 1);
      vi.advanceTimersByTime(1000);
      expect(panel.shown).toEqual({ key: "bar:1", x: 1, y: 1 });
    });
  });

  describe("onHit / onLeave (the hover trigger)", () => {
    it("shows only once the full showDelay has elapsed", () => {
      const panel = fakePanel();
      createHoverMachine(panel, DELAYS).onHit(hit("bar", 1), 10, 20);
      vi.advanceTimersByTime(299);
      expect(panel.shown).toBeNull();
      vi.advanceTimersByTime(1);
      expect(panel.shown).toEqual({ key: "bar:1", x: 10, y: 20 });
    });

    it("shows at the latest sample's coordinates, not the first, when the pointer moved during the delay", () => {
      const panel = fakePanel();
      const hover = createHoverMachine(panel, DELAYS);
      hover.onHit(hit("bar", 1), 10, 20);
      vi.advanceTimersByTime(150);
      hover.onHit(hit("bar", 1), 11, 21); // a further rest sample on the same bar, pointer moved
      vi.advanceTimersByTime(150); // the original deadline, not a restarted one
      expect(panel.shown).toEqual({ key: "bar:1", x: 11, y: 21 });
      expect(panel.log).toEqual(["show bar:1@11,21"]);
    });

    it("keeps using the latest coordinates across several rest samples before the deadline", () => {
      const panel = fakePanel();
      const hover = createHoverMachine(panel, DELAYS);
      hover.onHit(hit("bar", 1), 10, 20);
      vi.advanceTimersByTime(100);
      hover.onHit(hit("bar", 1), 12, 22);
      vi.advanceTimersByTime(100);
      hover.onHit(hit("bar", 1), 15, 25);
      vi.advanceTimersByTime(99);
      expect(panel.shown).toBeNull();
      vi.advanceTimersByTime(1); // the original 300ms deadline from the very first sample
      expect(panel.shown).toEqual({ key: "bar:1", x: 15, y: 25 });
    });

    it("stays silent when the content resolution declines at show time", () => {
      const panel = fakePanel();
      panel.declined.add("bar:1");
      createHoverMachine(panel, DELAYS).onHit(hit("bar", 1), 0, 0);
      vi.advanceTimersByTime(300);
      expect(panel.shown).toBeNull();
      expect(panel.log).toEqual(["decline bar:1"]);
    });

    it("hides the old target at once and re-arms the delay when hover moves to another bar", () => {
      const panel = fakePanel();
      const hover = createHoverMachine(panel, DELAYS);
      hover.onHit(hit("bar", 1), 0, 0);
      vi.advanceTimersByTime(300);
      hover.onHit(hit("bar", 2), 10, 10);
      expect(panel.shown).toBeNull(); // hidden immediately, not after a delay
      vi.advanceTimersByTime(299);
      expect(panel.shown).toBeNull();
      vi.advanceTimersByTime(1);
      expect(panel.shown).toEqual({ key: "bar:2", x: 10, y: 10 });
      expect(panel.log).toEqual(["show bar:1@0,0", "hide", "show bar:2@10,10"]);
    });

    it("restarts the delay for the new target mid-countdown", () => {
      const panel = fakePanel();
      const hover = createHoverMachine(panel, DELAYS);
      hover.onHit(hit("bar", 1), 0, 0);
      vi.advanceTimersByTime(299);
      hover.onHit(hit("bar", 2), 5, 5);
      vi.advanceTimersByTime(299);
      expect(panel.shown).toBeNull(); // bar 1's deadline passed unused
      vi.advanceTimersByTime(1);
      expect(panel.shown).toEqual({ key: "bar:2", x: 5, y: 5 });
    });

    it("treats a bar's handle as a different target from its body", () => {
      const panel = fakePanel();
      const hover = createHoverMachine(panel, DELAYS);
      hover.onHit(hit("bar", "t1"), 0, 0);
      vi.advanceTimersByTime(300);
      hover.onHit(hit("handle", "t1"), 1, 1);
      expect(panel.shown).toBeNull();
      vi.advanceTimersByTime(300);
      expect(panel.shown).toEqual({ key: "handle:t1", x: 1, y: 1 });
    });

    it("cancels a pending show when the pointer leaves first", () => {
      const panel = fakePanel();
      const hover = createHoverMachine(panel, DELAYS);
      hover.onHit(hit("bar", 1), 0, 0);
      vi.advanceTimersByTime(150);
      hover.onLeave();
      vi.advanceTimersByTime(10_000);
      expect(panel.log).toEqual([]);
    });

    it("hides exactly hideDelay after the pointer leaves a shown target", () => {
      const panel = fakePanel();
      const hover = createHoverMachine(panel, DELAYS);
      hover.onHit(hit("bar", 1), 0, 0);
      vi.advanceTimersByTime(300);
      hover.onLeave();
      vi.advanceTimersByTime(99);
      expect(panel.shown).not.toBeNull();
      vi.advanceTimersByTime(1);
      expect(panel.shown).toBeNull();
    });

    it("does not extend the countdown when a second leave arrives", () => {
      const panel = fakePanel();
      const hover = createHoverMachine(panel, DELAYS);
      hover.onHit(hit("bar", 1), 0, 0);
      vi.advanceTimersByTime(300);
      hover.onLeave();
      vi.advanceTimersByTime(50);
      hover.onLeave(); // an already-running countdown is never restarted
      vi.advanceTimersByTime(50);
      expect(panel.shown).toBeNull();
    });

    it("cancels the pending hide when the same target is re-entered, without re-showing", () => {
      const panel = fakePanel();
      const hover = createHoverMachine(panel, DELAYS);
      hover.onHit(hit("bar", 1), 0, 0);
      vi.advanceTimersByTime(300);
      hover.onLeave();
      vi.advanceTimersByTime(50);
      hover.onHit(hit("bar", 1), 0, 0);
      vi.advanceTimersByTime(10_000);
      expect(panel.shown).toEqual({ key: "bar:1", x: 0, y: 0 });
      expect(panel.log).toEqual(["show bar:1@0,0"]); // uninterrupted throughout
    });

    it("treats a re-entry after a completed hide as a fresh show cycle", () => {
      const panel = fakePanel();
      const hover = createHoverMachine(panel, DELAYS);
      hover.onHit(hit("bar", 1), 0, 0);
      vi.advanceTimersByTime(300);
      hover.onLeave();
      vi.advanceTimersByTime(100); // fully hidden
      hover.onHit(hit("bar", 1), 0, 0);
      vi.advanceTimersByTime(299);
      expect(panel.shown).toBeNull();
      vi.advanceTimersByTime(1);
      expect(panel.shown).not.toBeNull();
    });

    it("arms nothing on a leave with nothing shown", () => {
      const panel = fakePanel();
      createHoverMachine(panel, DELAYS).onLeave();
      vi.advanceTimersByTime(10_000);
      expect(panel.log).toEqual([]);
    });

    it("honors custom delays", () => {
      const panel = fakePanel();
      const hover = createHoverMachine(panel, { showDelay: 50, hideDelay: 500 });
      hover.onHit(hit("bar", 1), 0, 0);
      vi.advanceTimersByTime(49);
      expect(panel.shown).toBeNull();
      vi.advanceTimersByTime(1);
      expect(panel.shown).not.toBeNull();
      hover.onLeave();
      vi.advanceTimersByTime(499);
      expect(panel.shown).not.toBeNull();
      vi.advanceTimersByTime(1);
      expect(panel.shown).toBeNull();
    });

    it("shows on the next tick with a zero showDelay", () => {
      const panel = fakePanel();
      createHoverMachine(panel, { showDelay: 0, hideDelay: 0 }).onHit(hit("bar", 1), 0, 0);
      expect(panel.shown).toBeNull();
      vi.advanceTimersByTime(0);
      expect(panel.shown).not.toBeNull();
    });
  });

  describe("onPanelEnter / onPanelLeave (§6.4a, WCAG 1.4.13 Hoverable)", () => {
    it("cancels the pending hide when the pointer moves onto the panel", () => {
      const panel = fakePanel();
      const hover = createHoverMachine(panel, DELAYS);
      hover.onHit(hit("bar", 1), 0, 0);
      vi.advanceTimersByTime(300);
      hover.onLeave();
      vi.advanceTimersByTime(50);
      hover.onPanelEnter();
      vi.advanceTimersByTime(10_000);
      expect(panel.shown).not.toBeNull();
    });

    it("re-arms the same hideDelay when the pointer leaves the panel", () => {
      const panel = fakePanel();
      const hover = createHoverMachine(panel, DELAYS);
      hover.onHit(hit("bar", 1), 0, 0);
      vi.advanceTimersByTime(300);
      hover.onLeave();
      hover.onPanelEnter();
      hover.onPanelLeave();
      vi.advanceTimersByTime(99);
      expect(panel.shown).not.toBeNull();
      vi.advanceTimersByTime(1);
      expect(panel.shown).toBeNull();
    });

    it("does nothing on a panel leave with nothing shown", () => {
      const panel = fakePanel();
      const hover = createHoverMachine(panel, DELAYS);
      hover.onPanelLeave();
      vi.advanceTimersByTime(10_000);
      expect(panel.log).toEqual([]);
    });
  });

  describe("onDismiss (Escape or a hover-trigger press, §6.4a)", () => {
    it("hides and clears both pending timers", () => {
      const panel = fakePanel();
      const hover = createHoverMachine(panel, DELAYS);
      hover.onHit(hit("bar", 1), 0, 0);
      vi.advanceTimersByTime(300);
      hover.onLeave(); // hide counting down
      hover.onDismiss();
      expect(panel.shown).toBeNull();
      vi.advanceTimersByTime(10_000);
      expect(panel.log).toEqual(["show bar:1@0,0", "hide"]);
    });

    it("sticks to the dismissed target: further samples on it never re-arm the show", () => {
      const panel = fakePanel();
      const hover = createHoverMachine(panel, DELAYS);
      hover.onHit(hit("bar", 1), 0, 0);
      vi.advanceTimersByTime(300);
      hover.onDismiss();
      hover.onHit(hit("bar", 1), 0, 0);
      vi.advanceTimersByTime(10_000);
      hover.onHit(hit("bar", 1), 0, 0);
      vi.advanceTimersByTime(10_000);
      expect(panel.shown).toBeNull();
    });

    it("lifts the dismissal once the pointer leaves the dismissed target", () => {
      const panel = fakePanel();
      const hover = createHoverMachine(panel, DELAYS);
      hover.onHit(hit("bar", 1), 0, 0);
      vi.advanceTimersByTime(300);
      hover.onDismiss();
      hover.onLeave();
      hover.onHit(hit("bar", 1), 0, 0);
      vi.advanceTimersByTime(300);
      expect(panel.shown).toEqual({ key: "bar:1", x: 0, y: 0 });
    });

    it("lets a click re-open the dismissed target immediately", () => {
      const panel = fakePanel();
      const hover = createHoverMachine(panel, DELAYS);
      hover.onHit(hit("bar", 1), 0, 0);
      vi.advanceTimersByTime(300);
      hover.onDismiss();
      hover.onClick(hit("bar", 1), 1, 1);
      expect(panel.shown).toEqual({ key: "bar:1", x: 1, y: 1 });
      // And the stickiness is gone: a following hover sample behaves normally.
      hover.onHit(hit("bar", 1), 1, 1);
      vi.advanceTimersByTime(300);
      expect(panel.shown).toEqual({ key: "bar:1", x: 1, y: 1 });
    });

    it("does not stick to a different target", () => {
      const panel = fakePanel();
      const hover = createHoverMachine(panel, DELAYS);
      hover.onHit(hit("bar", 1), 0, 0);
      vi.advanceTimersByTime(300);
      hover.onDismiss();
      hover.onLeave();
      hover.onHit(hit("bar", 2), 10, 10);
      vi.advanceTimersByTime(300);
      expect(panel.shown).toEqual({ key: "bar:2", x: 10, y: 10 });
    });

    it("does nothing, and latches no dismissal, when nothing is visible or pending", () => {
      const panel = fakePanel();
      const hover = createHoverMachine(panel, DELAYS);
      hover.onDismiss();
      expect(panel.log).toEqual([]);
      // Proof the dismissal did not latch: a later hover of any bar shows normally.
      hover.onHit(hit("bar", 1), 0, 0);
      vi.advanceTimersByTime(300);
      expect(panel.shown).toEqual({ key: "bar:1", x: 0, y: 0 });
    });

    it("does not latch a stale tracked target left over after onSuppress hid the panel", () => {
      // Regression: onSuppress deliberately keeps `tracked` (so the next hover of the same bar
      // shows again normally), but that means onDismiss cannot infer "there is something to
      // dismiss" from `tracked` alone — it must also check the panel is visible or a show pending.
      const panel = fakePanel();
      const hover = createHoverMachine(panel, DELAYS);
      hover.onClick(hit("bar", 1), 0, 0);
      hover.onSuppress(); // hides; tracked is still "bar:1"
      hover.onDismiss();
      expect(panel.log).toEqual(["show bar:1@0,0", "hide"]); // no extra hide call
      // And the target is not stuck dismissed: the next hover of the same bar shows normally.
      hover.onHit(hit("bar", 1), 2, 2);
      vi.advanceTimersByTime(300);
      expect(panel.shown).toEqual({ key: "bar:1", x: 2, y: 2 });
    });

    it("dismisses a pending show too, before it has ever appeared", () => {
      const panel = fakePanel();
      const hover = createHoverMachine(panel, DELAYS);
      hover.onHit(hit("bar", 1), 0, 0);
      vi.advanceTimersByTime(150);
      hover.onDismiss();
      vi.advanceTimersByTime(10_000);
      expect(panel.shown).toBeNull();
      // The target was already tracked, so the dismissal stuck to it.
      hover.onHit(hit("bar", 1), 0, 0);
      vi.advanceTimersByTime(10_000);
      expect(panel.shown).toBeNull();
    });
  });

  describe("onScroll", () => {
    it("hides, drops both timers and forgets the tracked target", () => {
      const panel = fakePanel();
      const hover = createHoverMachine(panel, DELAYS);
      hover.onHit(hit("bar", 1), 0, 0);
      vi.advanceTimersByTime(300);
      hover.onLeave();
      hover.onScroll();
      expect(panel.shown).toBeNull();
      vi.advanceTimersByTime(10_000);
      expect(panel.log).toEqual(["show bar:1@0,0", "hide"]);
    });

    it("forgets a sticky dismissal, so the same target can show again", () => {
      const panel = fakePanel();
      const hover = createHoverMachine(panel, DELAYS);
      hover.onHit(hit("bar", 1), 0, 0);
      vi.advanceTimersByTime(300);
      hover.onDismiss();
      hover.onScroll();
      hover.onHit(hit("bar", 1), 0, 0);
      vi.advanceTimersByTime(300);
      expect(panel.shown).toEqual({ key: "bar:1", x: 0, y: 0 });
    });
  });

  describe("onSuppress (a gesture or a background press)", () => {
    it("hides at once and drops both timers", () => {
      const panel = fakePanel();
      const hover = createHoverMachine(panel, DELAYS);
      hover.onClick(hit("bar", 1), 0, 0);
      hover.onSuppress();
      expect(panel.shown).toBeNull();
      vi.advanceTimersByTime(10_000);
      expect(panel.log).toEqual(["show bar:1@0,0", "hide"]);
    });

    it("cancels a show that has not fired yet", () => {
      const panel = fakePanel();
      const hover = createHoverMachine(panel, DELAYS);
      hover.onHit(hit("bar", 1), 0, 0);
      hover.onSuppress();
      vi.advanceTimersByTime(10_000);
      expect(panel.shown).toBeNull();
    });

    it("does not itself dismiss the tracked target: a later hover shows normally", () => {
      const panel = fakePanel();
      const hover = createHoverMachine(panel, DELAYS);
      hover.onClick(hit("bar", 1), 0, 0);
      hover.onSuppress();
      hover.onHit(hit("bar", 1), 2, 2);
      vi.advanceTimersByTime(300);
      expect(panel.shown).toEqual({ key: "bar:1", x: 2, y: 2 });
    });
  });

  describe("cancelTimers (dispose)", () => {
    it("stops a pending show from ever firing", () => {
      const panel = fakePanel();
      const hover = createHoverMachine(panel, DELAYS);
      hover.onHit(hit("bar", 1), 0, 0);
      hover.cancelTimers();
      vi.advanceTimersByTime(10_000);
      expect(panel.log).toEqual([]);
    });

    it("stops a pending hide from ever firing", () => {
      const panel = fakePanel();
      const hover = createHoverMachine(panel, DELAYS);
      hover.onHit(hit("bar", 1), 0, 0);
      vi.advanceTimersByTime(300);
      hover.onLeave();
      hover.cancelTimers();
      vi.advanceTimersByTime(10_000);
      expect(panel.log).toEqual(["show bar:1@0,0"]);
    });

    it("is idempotent", () => {
      const panel = fakePanel();
      const hover = createHoverMachine(panel, DELAYS);
      hover.onHit(hit("bar", 1), 0, 0);
      hover.cancelTimers();
      expect(() => hover.cancelTimers()).not.toThrow();
    });
  });
});
