/**
 * The reachability guard for the axis origin: nothing exists left of content x = 0.
 *
 * The renderer clamps `scrollLeft` at 0, so a task whose start maps to a negative content x cannot
 * be reached by any gesture — the chart simply looks empty in that direction rather than broken.
 * This module decides, from the earliest task start and the current origin, whether that has
 * happened and what to do about it: repair it (`autoExtend`) or report it once.
 *
 * With `autoExtend` on, the axis begins at `min(baseOrigin, startOfUtcDay(earliest start))`. That is
 * a *derived* value, not an accumulated one, so the repair works in both directions: an edit that
 * reaches further back extends the axis at once, and one that no longer needs the room gives it
 * back. The base origin — whatever the host configured or last set — is the floor, so the repair can
 * never shrink the range the host asked for.
 *
 * It also decides *how much of the store it is allowed to look at*, which matters because the
 * task store is set once per frame during a live drag (one `task/move` per pointer move, one per
 * peer in a multi-drag). An extension is provable from the
 * changed tasks alone; a retraction is not — a task that stops being the earliest says nothing about
 * which task is earliest now — so retraction is deferred behind a coalescing timer and pays for one
 * whole-store walk per settled edit rather than one per frame. See `checkChanged` and `retract`.
 *
 * Retraction is additionally suppressed while a caller *holds* an extension (`requestExtension` …
 * `releaseExtension`): a drag in progress owns the axis it moved, and a pointer that has merely
 * stopped moving is still a drag.
 *
 * Pure: no host, no DOM, no store, no clock. The store scans, the timer and the `core/pluginError`
 * emission are supplied as callbacks, which is what makes the latching, the derivation rule and the
 * escalation arithmetic testable on their own.
 *
 * Internal: not part of the published surface.
 */
// docs/specs/plugins/view.md
import { startOfUtcDay } from "./zoom";

/**
 * How long the transaction stream has to stay quiet before the deferred retraction walks the store.
 * Long enough that a drag pays for one walk when it settles, short enough that the range given back
 * feels like part of the same edit.
 */
export const RETRACTION_DELAY_MS = 200;

export interface OriginGuardOptions {
  /** The instant currently at content x = 0. */
  origin(): number;
  /** Moves the origin, compensating the scroll. */
  setOrigin(ms: number): void;
  /**
   * The latest instant the axis may begin at: `TimelineScaleConfig.origin` as normalized at setup,
   * and thereafter whatever the last usable `TimeScaleService.setOrigin` named. The repair derives
   * the effective origin from this and never moves the axis past it.
   */
  baseOrigin(): number;
  /**
   * The earliest finite `start` across **every** stored task, or `undefined` when there is no store
   * or it holds no task with a usable start. O(tasks); called only when `checkAll` or the deferred
   * retraction runs, or when `checkChanged` has to escalate.
   */
  earliestTaskStart(): number | undefined;
  /** `TimelineScaleConfig.autoExtendOrigin`, already normalized to a boolean. */
  autoExtend: boolean;
  /** Reports the unreachable-content condition through `core/pluginError`. */
  report(error: unknown): void;
  /** Arms the deferred retraction and returns its handle. */
  setTimer(run: () => void, ms: number): unknown;
  /** Cancels a handle `setTimer` returned. */
  clearTimer(handle: unknown): void;
  /** The quiet period the retraction waits for; `RETRACTION_DELAY_MS` when omitted. */
  retractionDelayMs?: number;
}

export interface OriginGuard {
  /** Re-evaluates against the whole store. The startup check. */
  checkAll(): void;
  /**
   * Re-evaluates after a transaction, given a thunk producing the earliest finite start among
   * **only the tasks that transaction changed** (`undefined` when none of them has a usable start).
   *
   * The thunk is not called at all when the answer cannot depend on it, and the check escalates to
   * a full walk when the incremental answer would not be sound — see the implementation notes.
   */
  checkChanged(earliestChanged: () => number | undefined): void;
  /**
   * Extends the axis to cover `t`, for content the store does not hold yet — a drag in progress,
   * which also *holds* the extension until `releaseExtension`. Does nothing with `autoExtend` off,
   * for a non-finite `t`, or when the origin is already early enough, and never moves the origin
   * later.
   */
  requestExtension(t: number): void;
  /**
   * Drops the hold `requestExtension` took and schedules the deferred reconciliation. A no-op when
   * no hold is outstanding.
   */
  releaseExtension(): void;
  /**
   * Re-derives the effective origin after the host moved the base origin, applying the result in a
   * single move so no intermediate position can be clamped away.
   */
  rebase(): void;
  /** Cancels a pending retraction. The plugin owns this through `ctx.own`. */
  dispose(): void;
}

/**
 * The message the guard reports. ISO-8601 rather than the chart's `Intl` wording: this is a
 * developer-facing fault, and an unambiguous instant is worth more here than a localized one.
 */
export function unreachableStartMessage(earliest: number, origin: number): string {
  return (
    `stargantt.timeline-scale: a task starts at ${new Date(earliest).toISOString()}, ` +
    `before the timeline origin ${new Date(origin).toISOString()}. ` +
    "Content left of the origin sits at a negative content x and cannot be scrolled to. " +
    "Set an earlier `origin`, call `TimeScaleService.setOrigin()`, " +
    "or enable `TimelineScaleConfig.autoExtendOrigin`."
  );
}

/**
 * Creates the guard.
 *
 * With `autoExtend` off the condition is *reported*, latched on the origin value it was reported
 * for, so a chart that scrolls or repaints under an unchanged origin reports it exactly once. With
 * `autoExtend` on the condition is *repaired* instead — the origin follows the data between the base
 * origin and the day the earliest task starts on — and nothing is reported, because there is no
 * longer anything the host could act on.
 */
export function createOriginGuard(options: OriginGuardOptions): OriginGuard {
  /** The origin value the fault was last reported for; `null` until it has been reported at all. */
  let reportedFor: number | null = null;
  /**
   * The origin value the **whole store** was last known to satisfy — i.e. after which check every
   * stored task was known to start at or after it. `null` whenever that is not known: before the
   * first full walk, and after a check that found a violation it did not repair.
   *
   * This is what licenses the incremental scan in `checkChanged`: if every task satisfied origin O
   * and the origin is still O, then only the tasks a transaction *changed* can have broken it.
   */
  let settledFor: number | null = null;
  /** The armed retraction, or `null` when none is pending. At most one exists at a time. */
  let timer: unknown = null;
  /**
   * Whether a caller is currently holding an extension (a drag in progress). While one is, the axis
   * is never retracted: the gesture that moved the origin must not have it moved back underneath it,
   * and a pointer that has simply stopped moving is still a gesture.
   */
  let held = false;
  const delay = options.retractionDelayMs ?? RETRACTION_DELAY_MS;

  function cancelRetraction(): void {
    if (timer === null) return;
    options.clearTimer(timer);
    timer = null;
  }

  /**
   * Re-arms the deferred retraction — but only while there is something to give back. An axis that
   * already begins at the base origin has no extension outstanding, so a chart whose data never
   * reached back past `origin` schedules nothing at all, however many transactions run.
   */
  function armRetraction(): void {
    cancelRetraction();
    if (held) return;
    if (!options.autoExtend || !(options.origin() < options.baseOrigin())) return;
    timer = options.setTimer(() => {
      timer = null;
      retract();
    }, delay);
  }

  /**
   * The whole-store re-derivation: the axis begins at `min(baseOrigin, day(earliest start))`. Moves
   * the origin in either direction, and is the only path that can move it *later* — the question
   * "which task is earliest now" has no incremental answer.
   */
  function retract(): void {
    if (!options.autoExtend) return;
    const base = options.baseOrigin();
    const earliest = options.earliestTaskStart();
    const target = earliest === undefined ? base : Math.min(base, startOfUtcDay(earliest));
    if (target !== options.origin()) options.setOrigin(target);
    // `target <= startOfUtcDay(earliest) <= earliest`, so every stored task satisfies wherever the
    // origin ended up, and the incremental path may resume from here.
    settledFor = options.origin();
  }

  /**
   * The decision itself, given an earliest start and the origin to judge it against. Returns the
   * origin every stored task is now known to satisfy, or `null` when that is no longer known.
   *
   * Extension only: this is the path a per-frame transaction runs, and it is sound precisely because
   * moving the origin earlier needs nothing but the tasks in hand.
   */
  function evaluate(earliest: number | undefined, origin: number): number | null {
    if (earliest === undefined || earliest >= origin) return origin;

    if (options.autoExtend) {
      // Day-aligned, like the default origin, so day boundaries stay on multiples of
      // `pxPerDay` and the header grid keeps its alignment. `startOfUtcDay(earliest) <= earliest`
      // and `earliest < origin`, so this can only move the origin earlier; the comparison states
      // that rather than relying on the chain.
      const aligned = startOfUtcDay(earliest);
      if (aligned < origin) options.setOrigin(aligned);
      // Every task the caller weighed starts at or after `earliest`, hence at or after the aligned
      // origin, so the store now satisfies wherever the origin ended up.
      return options.origin();
    }

    if (reportedFor !== origin) {
      reportedFor = origin;
      options.report(new Error(unreachableStartMessage(earliest, origin)));
    }
    // Reported, not repaired: a task still starts before the origin, so nothing may be inferred
    // about the store from here on and the next check has to walk it again.
    return null;
  }

  function checkAll(): void {
    settledFor = evaluate(options.earliestTaskStart(), options.origin());
    armRetraction();
  }

  function checkChanged(earliestChanged: () => number | undefined): void {
    const origin = options.origin();

    // 1. Nothing this call could discover would change anything: the fault is already reported for
    // this exact origin, and only an origin change reopens that latch. Bail before touching the
    // store at all — this is the steady state of a drag over a chart whose data reaches back
    // past the origin. No retraction exists to arm either: the latch is reachable only with
    // `autoExtend` off, where the origin never moves by itself.
    if (!options.autoExtend && reportedFor === origin) return;

    // 2. The incremental scan below is sound only while every *unchanged* task is known to satisfy
    // the current origin. `settledFor` records an origin every stored task was known to start at
    // or after, so it still covers any origin at or *before* it — moving the origin earlier only
    // weakens the requirement, which is why an auto-extend or a backwards `setOrigin` costs no
    // walk. It stops covering an origin that has moved *later*, and it covers nothing at all
    // after a violation this guard reported rather than repaired. Both cases re-walk once, after
    // which the fast path resumes.
    if (settledFor === null || settledFor < origin) {
      checkAll();
      return;
    }

    // 3. The fast path, and the one a live drag runs: only the transaction's own tasks can have
    // broken an invariant every other task satisfies.
    settledFor = evaluate(earliestChanged(), origin);
    // The room this transaction may have freed is given back once the stream goes quiet.
    armRetraction();
  }

  function requestExtension(t: number): void {
    if (!options.autoExtend || !Number.isFinite(t)) return;
    // The hold comes first and outlives the individual request: what it says is "a gesture is
    // reaching here", and a gesture whose pointer has stopped moving sends nothing at all. Arming a
    // timer from the request instead — the first shipping version — let a still pointer retract the
    // axis underneath its own drag.
    held = true;
    cancelRetraction();
    const aligned = startOfUtcDay(t);
    // Moving the origin earlier only weakens what `settledFor` asserts, so the incremental path
    // stays sound and this costs no walk — the point of driving it from a drag frame.
    if (aligned < options.origin()) options.setOrigin(aligned);
  }

  function releaseExtension(): void {
    if (!held) return;
    held = false;
    // The gesture is over however it ended. A commit has already been through `checkChanged`; an
    // abandoned drag wrote nothing, and this is what reconciles it away.
    armRetraction();
  }

  function rebase(): void {
    cancelRetraction();
    if (!options.autoExtend) {
      // Off, the base origin *is* the origin. Applying it before the check means the report, if any,
      // names the origin the host just chose.
      if (options.baseOrigin() !== options.origin()) options.setOrigin(options.baseOrigin());
      settledFor = null;
      checkAll();
      return;
    }
    // On, the answer is the same derivation the deferred walk performs — run now rather than in
    // 200 ms, and in one move, so no intermediate origin can have its compensating scroll clamped.
    retract();
  }

  return {
    checkAll,
    checkChanged,
    requestExtension,
    releaseExtension,
    rebase,
    dispose: cancelRetraction,
  };
}
