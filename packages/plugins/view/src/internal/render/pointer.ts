// docs/specs/plugins/view.md — internal; not part of the published surface.
/**
 * The renderer's pointer state machines and the claim that keeps them mutually exclusive.
 *
 * Three of them coexist — the canvas gesture, the scrollbar thumb drag and the
 * once-per-frame hover resolution — and only one may own the pointer at a time. That
 * exclusion is enforced by `PointerClaim` rather than described in a comment: a machine that has not
 * been granted the claim does not run.
 */
import type { HitResult } from "./index";

/** The client coordinates a coordinate conversion needs; a raw `PointerEvent` satisfies it. */
export interface PointerLike {
  readonly clientX: number;
  readonly clientY: number;
}

/** Which machine currently owns the pointer. */
export type PointerOwner = "gesture" | "thumb";

/**
 * The single-owner claim on the pointer.
 *
 * The first machine to `claim()` owns the pointer until it `release()`s it; every other machine's
 * `claim()` is refused, and the hover resolution runs only while nothing is claimed.
 */
export interface PointerClaim {
  /** Grants the claim to `owner`, or refuses it because another machine already holds it. */
  claim(owner: PointerOwner): boolean;
  /** Releases the claim, if `owner` is the machine holding it. */
  release(owner: PointerOwner): void;
  /** The machine holding the claim, or `null` while the pointer is free. */
  holder(): PointerOwner | null;
}

export function createPointerClaim(): PointerClaim {
  let owner: PointerOwner | null = null;
  return {
    claim(next) {
      if (owner !== null) return owner === next;
      owner = next;
      return true;
    },
    release(previous) {
      if (owner === previous) owner = null;
    },
    holder: () => owner,
  };
}

/* ------------------------------------------------------------------ *
 * Pointer capture
 * ------------------------------------------------------------------ */

interface Capturable {
  setPointerCapture?: (id: number) => void;
  releasePointerCapture?: (id: number) => void;
  hasPointerCapture?: (id: number) => boolean;
}

/** Captures the pointer on `el`, tolerating a host that has no pointer-capture support. */
export function capturePointer(el: HTMLElement, pointerId: number | undefined): void {
  if (typeof pointerId !== "number") return;
  try {
    (el as HTMLElement & Capturable).setPointerCapture?.(pointerId);
  } catch {
    // A host without pointer capture still delivers moves to the element; the gesture stands.
  }
}

/** Releases a pointer capture, tolerating a capture the host already dropped. */
export function releasePointer(el: HTMLElement, pointerId: number | undefined): void {
  if (typeof pointerId !== "number") return;
  const target = el as HTMLElement & Capturable;
  try {
    if (target.hasPointerCapture?.(pointerId) !== false) target.releasePointerCapture?.(pointerId);
  } catch {
    // Releasing a capture the host already dropped is not an error worth surfacing.
  }
}

/* ------------------------------------------------------------------ *
 * Overlay exemption
 * ------------------------------------------------------------------ */

/** The one `Node` member the ancestor walk needs; both a real node and a test double satisfy it. */
interface NodeLike {
  readonly parentNode?: NodeLike | null;
}

/**
 * Whether a press landed on the chart surface itself rather than on an overlay contribution.
 *
 * The chart pane also hosts DOM that is not chart input: the DOM-overlay region with its
 * `renderer/domOverlays` wrappers, and the floating corner widgets other plugins mount into the
 * pane (diagnostics panels, zoom toolbars, search boxes). Treating a press on one of those as
 * chart input captured the pointer on the pane, which retargeted the release — so the `click`
 * fired on the pane and the overlay control never saw a real mouse click.
 *
 * The rule is structural, not class-name matching: walk up from the press target to the pane and
 * look at which direct child of the pane the target sits under. A layer canvas is the chart
 * surface; anything else is an overlay. A press on the pane itself, or a target that is not in
 * the pane's subtree at all, counts as chart input.
 */
// docs/specs/plugins/view.md — "Pointer events" /
// docs/specs/plugins/view.md
export function isChartSurfaceTarget(
  target: unknown,
  pane: unknown,
  canvases: readonly unknown[],
): boolean {
  if (target === null || target === undefined) return true;
  let node = target as NodeLike | null | undefined;
  let child: unknown = null;
  while (node !== null && node !== undefined && node !== pane) {
    child = node;
    node = node.parentNode;
  }
  // Never reached the pane: a synthetic or re-dispatched event, left to behave as it always has.
  if (node !== pane) return true;
  if (child === null) return true;
  return canvases.includes(child);
}

/* ------------------------------------------------------------------ *
 * Canvas gestures
 * ------------------------------------------------------------------ */

/** Where the renderer's pointer events are emitted; the payload shaping stays with the plugin. */
export interface GestureSink {
  barDown(hit: HitResult, x: number, y: number, event: PointerEvent): void;
  background(x: number, y: number, event: PointerEvent): void;
  barMove(hit: HitResult | undefined, x: number, y: number, event: PointerEvent): void;
  barUp(hit: HitResult | undefined, x: number, y: number, event: PointerEvent): void;
}

export interface GestureDeps {
  /** The chart pane: the capture target and the coordinate origin. */
  pane: HTMLElement;
  claim: PointerClaim;
  /** Client coordinates to viewport-local ones. */
  localPoint(e: PointerLike): { x: number; y: number };
  hitAt(x: number, y: number): HitResult | undefined;
  sink: GestureSink;
  /** Called when a gesture starts, so the hover machine can drop a pending resolution. */
  onStart(): void;
}

/**
 * The gesture machine: one press-to-release sequence at a time, hit frozen for its duration.
 *
 * A press on a hit shape emits `pointer/barDown`, a press on empty space `pointer/background`, and
 * both start a gesture whose moves and single release are emitted synchronously.
 */
// docs/specs/plugins/view.md

export interface GestureMachine {
  onDown(e: PointerEvent): void;
  /** Emits the gesture's `pointer/barMove`; `false` when no gesture is active (a hover move). */
  onMove(e: PointerEvent): boolean;
  /** Ends the gesture on a release or a cancelled capture, emitting exactly one `pointer/barUp`. */
  onEnd(e: PointerEvent): void;
  /** True while a gesture is active. */
  active(): boolean;
}

export function createGestureMachine(deps: GestureDeps): GestureMachine {
  /** The active gesture: the pointer it belongs to, and the hit it started on (if any). */
  interface Gesture {
    pointerId: number | undefined;
    /** Absent for a gesture that started on empty space. */
    hit?: HitResult;
  }
  let gesture: Gesture | null = null;

  function end(e: PointerEvent): void {
    const active = gesture;
    if (active === null) return;
    // Cleared before the emit, so exactly one `pointer/barUp` is delivered even if a consumer
    // re-enters the renderer from its handler.
    gesture = null;
    deps.claim.release("gesture");
    releasePointer(deps.pane, active.pointerId);
    const p = deps.localPoint(e);
    deps.sink.barUp(active.hit, p.x, p.y, e);
  }

  return {
    onDown(e) {
      if (gesture !== null) {
        // A second, different pointer going down mid-gesture is ignored: one gesture at a time keeps
        // the "exactly one `pointer/barUp` per gesture" promise unambiguous.
        if (gesture.pointerId !== e.pointerId) return;
        // The same pointer pressing again means its release was never delivered (a lost capture, a
        // synthetic sequence). Close the stale gesture first so it still gets its single
        // `pointer/barUp`, then start the new one.
        end(e);
      }
      // a thumb drag owns the pointer for its whole duration: it consumes the press that
      // started it, and a press that somehow reaches the pane meanwhile starts no gesture.
      if (!deps.claim.claim("gesture")) return;
      const p = deps.localPoint(e);
      const hit = deps.hitAt(p.x, p.y);
      gesture = hit === undefined ? { pointerId: e.pointerId } : { pointerId: e.pointerId, hit };
      // No hover is resolved during a gesture, so a move recorded just before the press is dropped.
      deps.onStart();
      capturePointer(deps.pane, e.pointerId);
      if (hit === undefined) deps.sink.background(p.x, p.y, e);
      else deps.sink.barDown(hit, p.x, p.y, e);
    },
    onMove(e) {
      const active = gesture;
      if (active === null) return false;
      // §3 — synchronous, never frame-batched, so the consumer reads exact modifier-key state.
      const p = deps.localPoint(e);
      deps.sink.barMove(active.hit, p.x, p.y, e);
      return true;
    },
    onEnd(e) {
      if (gesture === null || gesture.pointerId !== e.pointerId) return;
      end(e);
    },
    active: () => gesture !== null,
  };
}

/* ------------------------------------------------------------------ *
 * Hover
 * ------------------------------------------------------------------ */

/** Two resolutions are "the same target" when they describe the same shape of the same object. */
export function sameHit(a: HitResult | undefined, b: HitResult | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  return a.kind === b.kind && a.id === b.id && a.cursor === b.cursor;
}

export interface HoverDeps {
  claim: PointerClaim;
  localPoint(e: PointerLike): { x: number; y: number };
  hitAt(x: number, y: number): HitResult | undefined;
  /** Emits `pointer/barHover`; called only when the resolved target actually changed. */
  onHover(hit: HitResult | undefined, x: number, y: number): void;
  /** Writes the chart pane's cursor; called only when the value changes. */
  setCursor(cursor: string): void;
}

export interface HoverMachine {
  /** Records the pointer's latest position; the resolution happens in the next frame. */
  record(e: PointerLike): void;
  /** Resolves the recorded position, at most once per frame. */
  resolve(): void;
  /** Drops a recorded position without resolving it. */
  discard(): void;
}

/**
 * Hover resolved once per frame, not once per pointer event.
 *
 * A pointing device reports moves far faster than the display refreshes (a 1000Hz mouse can deliver
 * an order of magnitude more events than there are frames), and each resolution costs a layout read
 * plus a full pass over every `renderer/hitTest` contribution — contributions that may walk the
 * visible rows and build geometry to answer. Only the pointer's latest position can affect the
 * cursor, so intermediate positions are recorded and dropped, and the surviving one is resolved from
 * the frame callback. This bounds hover work to the frame rate rather than to the device's report
 * rate. While any machine holds the pointer claim — a canvas gesture or a thumb drag — the hit is
 * frozen and nothing is resolved at all.
 */
// docs/specs/plugins/view.md
export function createHoverMachine(deps: HoverDeps): HoverMachine {
  let clientX = 0;
  let clientY = 0;
  let pending = false;
  /** Last value written to the pane's inline `cursor`; `""` matches its initial state. */
  let lastCursor = "";
  /** The hit the previous frame resolved, so only a change emits `pointer/barHover`. */
  let lastHover: HitResult | undefined;

  return {
    record(e) {
      clientX = e.clientX;
      clientY = e.clientY;
      pending = true;
    },
    discard() {
      pending = false;
    },
    resolve() {
      if (deps.claim.holder() !== null) return;
      if (!pending) return;
      pending = false;
      const p = deps.localPoint({ clientX, clientY });
      const hit = deps.hitAt(p.x, p.y);
      // The frame emits `pointer/barHover` only when its resolution differs from the previous
      // frame's, including the transition to and from "no hit".
      if (!sameHit(hit, lastHover)) {
        lastHover = hit;
        deps.onHover(hit, p.x, p.y);
      }
      const cursor = hit === undefined ? "" : hit.cursor;
      // Writing an unchanged value still dirties the element's inline style. Skipping the write is
      // what keeps a pointer resting on one bar from invalidating style on every frame.
      if (cursor === lastCursor) return;
      lastCursor = cursor;
      deps.setCursor(cursor);
    },
  };
}
