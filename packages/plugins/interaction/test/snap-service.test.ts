/**
 * `createSnapModule` — the composed `stargantt.snap` pipeline: rounding (with its default-unit
 * resolution and the custom-rule seam), task-edge alignment, working-time avoidance and successor
 * push-out, wired together exactly as `src/index.ts` wires them, but hostlessly: every dependency
 * arrives as a plain `SnapDeps` accessor (`./_snap-fakes.ts`), so nothing here boots a `Gantt`
 * instance, a DOM, or a sibling plugin.
 *
 * Covers "default unit", "configured unit", "snap()", "custom rule", "task-edge alignment
 * (booted)", "working-time avoidance (booted)", "successor push-out (booted)", and "composition of
 * alignment and working-time avoidance".
 *
 * Three differences shape how these cases were derived, not just re-typed from an earlier
 * implementation:
 *
 * 1. `deps.scaleUnit()` already returns the resolved unit (or `undefined`) — there is no `ZoomLevel`
 *    / scale-row object to fake, so a `fakeTimelineScale(level(...))` stand-in collapses to a plain
 *    closure returning a `SnapUnit`.
 * 2. Previously, an **absent** `stargantt.timeline-scale` plugin made the default unit fall back to
 *    whole-day rounding (`floorTo`/`roundTo` "day") — see "falls back to whole days when
 *    stargantt.timeline-scale is absent" below. Here (docs/specs/plugins/interaction.md §2.2 / this
 *    package's `service.ts`), `deps.scaleUnit()` returning `undefined` makes `snap()` an *identity*
 *    (no rounding at all); only `step()` falls back to one UTC day. `stargantt.timeline-scale` is
 *    also no longer optional at the real plugin's composition (`ctx.use`, not `ctx.useOptional`),
 *    so "absent scale" is not a state the real plugin can even be in — the hostless equivalent is a
 *    zoom level with no rows, i.e. `scaleUnit: () => undefined`.
 *    The earlier working-time and alignment "booted" tests relied on that no-scale day-rounding
 *    default (their own comments say so: "Sunday morning rounds (day unit fallback: no scale)...";
 *    the alignment tests' own `fakeScale` stand-in likewise declared a `"day"` scale row). Below,
 *    every test that needs that same "round to day, then adjust" composition sets `unit: "day"`
 *    (or an equivalent `scaleUnit`) explicitly rather than relying on an absent default — this
 *    reproduces the earlier arithmetic exactly (verified boundary-by-boundary against its own
 *    inline comments) while keeping the identity-by-default semantics visible where it actually
 *    differs: see "changes nothing when unconfigured" below, whose expected answer is NOT
 *    day-rounded, unlike its earlier counterpart.
 * 3. `snap/pushGuards` (OR-combined, no short-circuit, a throw reported through `onFault` and read
 *    as standing down) replaces the earlier structural `stargantt.scheduler.propagationEnabled()`
 *    edge. The earlier scheduler-specific booted tests are replaced by guard-shaped equivalents;
 *    the detailed call-pattern contract (no short-circuit, order-independence) is tested directly
 *    against the pure `standsDown` in `snap-push-out.test.ts` — this file only checks that
 *    `appendPushOut` wires `deps.pushGuards()` and `deps.onFault` through.
 *
 * Not covered here — no hostless equivalent exists at this layer, because it is about plugin
 * registration / composition rather than the snap pipeline itself:
 *  - "service registration" (`plugin.meta.id`, `dependsOn`, `optional`, dispose-without-throwing)
 *    and "service identity" (`gantt.service()` returns the same object on every call): these test
 *    `src/index.ts`'s `definePlugin(...)` wiring, not `createSnapModule`. Out of this file's scope.
 *  - "ignores a scale row's optional step when picking the unit": the decision to read a scale
 *    row's `unit` and ignore its `step` lives in `src/index.ts`'s `scaleUnit: () => {...}` closure
 *    (`scales[scales.length - 1]?.unit`), not in `service.ts` — `SnapDeps.scaleUnit()` is handed the
 *    already-picked unit, so there is nothing of this decision left to exercise through `SnapDeps`.
 *  - "resolves the time scale after setup, so plugin order does not matter": subsumed by "follows
 *    a zoom change on the very next consultation" below — both assert the same thing, that `unit()`
 *    is re-read on every call rather than captured once.
 */
import { describe, expect, it, vi } from "vitest";
import { MS_DAY, MS_HOUR } from "@stargantt/sdk";
import type { Link, Patch, TaskId } from "@stargantt/plugin-data-store";
import { MS_WEEK } from "../src/internal/snap/units";
import type { SnapConfig } from "../src/config";
import type { PushGuard, SnapRule, SnapRuleContext, SnapUnit, WorkingTimeProvider } from "../src/types";
import { task } from "./_fakes";
import {
  DAY_GRANULAR,
  boundsOf,
  countingProvider,
  faultSink,
  moduleOf,
  view as dataView,
} from "./_snap-fakes";

/** Epoch ms of a UTC wall-clock time. */
function utc(y: number, m: number, d: number, h = 0, min = 0, s = 0, ms = 0): number {
  return Date.UTC(y, m - 1, d, h, min, s, ms);
}

/* ------------------------------------------------------------------ *
 * default unit — following the timeline scale
 * ------------------------------------------------------------------ */

describe("default unit — following the timeline scale", () => {
  it("rounds to the finest scale row of the active zoom level", () => {
    const { service } = moduleOf(undefined, { scaleUnit: () => "hour" });
    // Half an hour ties upward to the next hour rather than to a day.
    expect(service.snap(utc(2024, 3, 14, 5, 30))).toBe(utc(2024, 3, 14, 6));
    expect(service.snap(utc(2024, 3, 14, 5, 29))).toBe(utc(2024, 3, 14, 5));
  });

  it("follows a zoom change on the very next consultation", () => {
    let unit: SnapUnit | undefined = "hour";
    const { service } = moduleOf(undefined, { scaleUnit: () => unit });
    const t = utc(2024, 3, 14, 5, 30);
    expect(service.snap(t)).toBe(utc(2024, 3, 14, 6));

    unit = "day";
    expect(service.snap(t)).toBe(utc(2024, 3, 14));
    expect(service.step(t, 1)).toBe(MS_DAY);

    unit = "hour";
    expect(service.step(t, 1)).toBe(MS_HOUR);
  });

  it("rounds nothing when the active zoom level has no scale rows", () => {
    // `scaleUnit` answering `undefined` is what an empty-rows zoom level looks like from here.
    const { service } = moduleOf(undefined);
    const t = utc(2024, 3, 14, 5, 30);
    expect(service.snap(t)).toBe(t);
  });

  it("falls back to a one-day step when the active zoom level has no scale rows", () => {
    const { service } = moduleOf(undefined);
    const t = utc(2024, 3, 14, 5, 30);
    expect(service.step(t, 1)).toBe(MS_DAY);
    expect(service.step(t, -1)).toBe(-MS_DAY);
  });

  it('treats an explicit "scale" exactly like an omitted unit', () => {
    const { service } = moduleOf({ unit: "scale" }, { scaleUnit: () => "hour" });
    expect(service.snap(utc(2024, 3, 14, 5, 30))).toBe(utc(2024, 3, 14, 6));
  });
});

/* ------------------------------------------------------------------ *
 * configured unit
 * ------------------------------------------------------------------ */

describe("configured unit", () => {
  it("pins a calendar unit regardless of zoom", () => {
    let unit: SnapUnit | undefined = "hour";
    const { service } = moduleOf({ unit: "week" }, { scaleUnit: () => unit });
    expect(service.snap(utc(2024, 3, 14, 11, 59))).toBe(utc(2024, 3, 11));
    expect(service.step(utc(2024, 3, 14), 1)).toBe(MS_WEEK);

    // A zoom change no longer moves it.
    unit = "day";
    expect(service.snap(utc(2024, 3, 14, 11, 59))).toBe(utc(2024, 3, 11));
  });

  it("pins a calendar unit even with no scale rows at all", () => {
    const { service } = moduleOf({ unit: "month" });
    expect(service.snap(utc(2024, 6, 16))).toBe(utc(2024, 7, 1));
    expect(service.step(utc(2024, 2, 10), 1)).toBe(29 * MS_DAY);
  });

  it("rounds to a millisecond grid measured from the epoch", () => {
    const fifteenMinutes = 15 * 60_000;
    const { service } = moduleOf({ unit: fifteenMinutes });
    expect(service.snap(utc(2024, 3, 14, 5, 7))).toBe(utc(2024, 3, 14, 5));
    expect(service.snap(utc(2024, 3, 14, 5, 8))).toBe(utc(2024, 3, 14, 5, 15));
    // The tie resolves upward here too.
    expect(service.snap(utc(2024, 3, 14, 5, 7, 30))).toBe(utc(2024, 3, 14, 5, 15));
    expect(service.step(utc(2024, 3, 14, 5, 7), 1)).toBe(fifteenMinutes);
    expect(service.step(utc(2024, 3, 14, 5, 7), -1)).toBe(-fifteenMinutes);
  });

  for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    it(`ignores the unusable numeric unit ${String(bad)} and uses the default`, () => {
      const { service } = moduleOf({ unit: bad }, { scaleUnit: () => "hour" });
      // The default is back in force: the finest row of the active level.
      expect(service.snap(utc(2024, 3, 14, 5, 30))).toBe(utc(2024, 3, 14, 6));
    });
  }

  it("ignores an unrecognised unit string and uses the default", () => {
    // Not reachable through the public types; guards a plain-JS caller.
    const config = { unit: "fortnight" } as unknown as SnapConfig;
    const { service } = moduleOf(config, { scaleUnit: () => "hour" });
    expect(service.snap(utc(2024, 3, 14, 5, 30))).toBe(utc(2024, 3, 14, 6));
  });
});

/* ------------------------------------------------------------------ *
 * snap()
 * ------------------------------------------------------------------ */

describe("snap()", () => {
  it("returns a non-finite instant unchanged", () => {
    const { service } = moduleOf({ unit: "day" });
    expect(service.snap(Number.NaN)).toBeNaN();
    expect(service.snap(Number.POSITIVE_INFINITY)).toBe(Number.POSITIVE_INFINITY);
  });

  it("gives the same answer from either side of a drag", () => {
    const { service } = moduleOf({ unit: "day" });
    const target = utc(2024, 3, 14);
    expect(service.snap(target - MS_DAY / 2)).toBe(target);
    expect(service.snap(target + MS_DAY / 2 - 1)).toBe(target);
  });
});

/* ------------------------------------------------------------------ *
 * custom rule
 * ------------------------------------------------------------------ */

describe("custom rule", () => {
  it("is called once, during construction, with the built-in behaviour", () => {
    const rule = vi.fn((base: SnapRuleContext): SnapRule => ({ snap: (t) => base.snap(t) }));
    const { service } = moduleOf({ rule }, { scaleUnit: () => "day" });
    expect(rule).toHaveBeenCalledTimes(1);
    service.snap(utc(2024, 3, 14, 5));
    service.snap(utc(2024, 3, 15, 5));
    expect(rule).toHaveBeenCalledTimes(1);
  });

  it("replaces rounding for every snap call", () => {
    const { service } = moduleOf({ rule: () => ({ snap: () => 42 }) });
    expect(service.snap(utc(2024, 3, 14, 5))).toBe(42);
    expect(service.snap(Number.NaN)).toBe(42);
  });

  it("keeps built-in stepping when the rule omits step", () => {
    let unit: SnapUnit | undefined = "hour";
    const { service } = moduleOf({ rule: () => ({ snap: (t) => t }) }, { scaleUnit: () => unit });
    expect(service.step(utc(2024, 3, 14, 5, 30), 1)).toBe(MS_HOUR);
    unit = "day";
    expect(service.step(utc(2024, 3, 14, 5, 30), 1)).toBe(MS_DAY);
  });

  it("replaces stepping when the rule supplies step", () => {
    const { service } = moduleOf({
      rule: () => ({ snap: (t) => t, step: (_t, direction) => direction * 7 }),
    });
    expect(service.step(0, 1)).toBe(7);
    expect(service.step(0, -1)).toBe(-7);
  });

  it("calls the rule's members with the rule as receiver", () => {
    // A rule written as an object literal with methods may rely on `this`.
    const grained = {
      grain: 10,
      snap(t: number): number {
        return Math.round(t / this.grain) * this.grain;
      },
      step(_t: number, direction: 1 | -1): number {
        return direction * this.grain;
      },
    };
    const { service } = moduleOf({ rule: (): SnapRule => grained });
    expect(service.snap(23)).toBe(20);
    expect(service.step(0, 1)).toBe(10);
  });

  it("exposes the live built-in behaviour through the rule context", () => {
    let unit: SnapUnit | undefined = "hour";
    const seen: (string | number | undefined)[] = [];
    const { service } = moduleOf(
      {
        rule: (base) => ({
          snap: (t) => {
            seen.push(base.unit());
            // Round to the built-in boundary, then push one whole unit further.
            return base.snap(t) + base.step(t, 1);
          },
        }),
      },
      { scaleUnit: () => unit },
    );
    expect(service.snap(utc(2024, 3, 14, 5, 10))).toBe(utc(2024, 3, 14, 6));
    unit = "day";
    expect(service.snap(utc(2024, 3, 14, 5))).toBe(utc(2024, 3, 15));
    expect(seen).toEqual(["hour", "day"]);
  });

  it("reports no unit through the rule context when the zoom level has no rows", () => {
    let unit: string | number | undefined = "unset";
    const { service } = moduleOf({
      rule: (base) => ({
        snap: (t) => {
          unit = base.unit();
          return t;
        },
      }),
    });
    service.snap(0);
    expect(unit).toBeUndefined();
  });

  it("lets a throwing rule surface to the caller rather than swallowing it", () => {
    const { service } = moduleOf({
      rule: () => ({
        snap: () => {
          throw new Error("bad rule");
        },
      }),
    });
    expect(() => service.snap(0)).toThrow("bad rule");
  });

  it("lets a rule that throws during construction surface from createSnapModule", () => {
    expect(() =>
      moduleOf({
        rule: () => {
          throw new Error("bad factory");
        },
      }),
    ).toThrow("bad factory");
  });
});

/* ------------------------------------------------------------------ *
 * task-edge alignment (§6.3 alignToTasks)
 * ------------------------------------------------------------------ */

describe("task-edge alignment", () => {
  // 1 px per hour: the default 8 px tolerance spans 8 hours. `scaleUnit: () => "day"` reproduces
  // the earlier `fakeScale` stand-in, whose one declared row was also `"day"`.
  const PX_PER_MS = 1 / 3_600_000;
  const other = task({ id: "other", start: utc(2024, 3, 12, 7), end: utc(2024, 3, 20, 15) });

  it("sticks to another task's off-grid edge instead of rounding", () => {
    const { service } = moduleOf(
      { alignToTasks: true },
      { tasks: () => [other], pxPerMs: () => PX_PER_MS, scaleUnit: () => "day" },
    );
    // 5 hours from the other task's start and inside the 8-hour window: aligned verbatim.
    expect(service.snap(utc(2024, 3, 12, 2))).toBe(utc(2024, 3, 12, 7));
    // Its end edge works the same way.
    expect(service.snap(utc(2024, 3, 20, 12))).toBe(utc(2024, 3, 20, 15));
  });

  it("rounds normally when no edge is within tolerance", () => {
    const { service } = moduleOf(
      { alignToTasks: true },
      { tasks: () => [other], pxPerMs: () => PX_PER_MS, scaleUnit: () => "day" },
    );
    expect(service.snap(utc(2024, 3, 15, 10))).toBe(utc(2024, 3, 15));
  });

  it("honors a configured tolerance and rejects an unusable one", () => {
    const near = utc(2024, 3, 12, 2); // 5 hours from the edge
    const deps = { tasks: () => [other], pxPerMs: () => PX_PER_MS, scaleUnit: () => "day" as const };
    const twoHour = moduleOf({ alignToTasks: { tolerancePx: 2 } }, deps);
    expect(twoHour.service.snap(near)).toBe(utc(2024, 3, 12)); // out of the 2-hour window: rounded
    const bad = moduleOf({ alignToTasks: { tolerancePx: Number.NaN } }, deps);
    expect(bad.service.snap(near)).toBe(utc(2024, 3, 12, 7)); // default 8 px again
  });

  it("refreshes its edge set when the data changes", () => {
    // The host wires `invalidateEdges()` to the task store's subscription; hostlessly, the test
    // plays that subscriber's part by calling it itself after mutating the task list.
    let tasks = [other];
    const module = moduleOf(
      { alignToTasks: true },
      { tasks: () => tasks, pxPerMs: () => PX_PER_MS, scaleUnit: () => "day" },
    );
    expect(module.service.snap(utc(2024, 3, 12, 2))).toBe(utc(2024, 3, 12, 7));
    tasks = [task({ id: "other", start: utc(2024, 3, 12, 9), end: utc(2024, 3, 20, 15) })];
    module.invalidateEdges();
    expect(module.service.snap(utc(2024, 3, 12, 2))).toBe(utc(2024, 3, 12, 9));
  });

  it("is inert without a usable pixel density or without task data", () => {
    // No `pxPerMs` override: the default answers 0, which is what "no timeline" looks like here.
    const noScale = moduleOf({ alignToTasks: true }, { tasks: () => [other], scaleUnit: () => "day" });
    expect(noScale.service.snap(utc(2024, 3, 12, 2))).toBe(utc(2024, 3, 12));
    // No `tasks` override: the default answers no tasks, which is what "no data store" looks like.
    const noData = moduleOf({ alignToTasks: true }, { pxPerMs: () => PX_PER_MS, scaleUnit: () => "day" });
    expect(noData.service.snap(utc(2024, 3, 12, 2))).toBe(utc(2024, 3, 12));
  });
});

/* ------------------------------------------------------------------ *
 * working-time avoidance (§6.3 workingDays)
 * ------------------------------------------------------------------ */

describe("working-time avoidance", () => {
  it("moves a rounded date off a non-working day, tie forward", () => {
    const { service } = moduleOf(
      { workingDays: true, unit: "day" },
      { workingTime: () => ({ boundaries: () => boundsOf(DAY_GRANULAR) }) },
    );
    // Sunday morning rounds (day unit) to Sunday 00:00, then avoids to Monday 00:00.
    expect(service.snap(utc(2024, 3, 17, 10))).toBe(utc(2024, 3, 18));
    // Saturday 00:00 closes a working Friday, so an exclusive end may keep it.
    expect(service.snap(utc(2024, 3, 16, 10))).toBe(utc(2024, 3, 16));
    // A weekday is untouched.
    expect(service.snap(utc(2024, 3, 14, 10))).toBe(utc(2024, 3, 14));
  });

  it("uses a named calendar when configured", () => {
    const sundayOnly = { workingDays: [0] };
    const provider: WorkingTimeProvider = {
      boundaries: (calendar) => (calendar === "crew" ? boundsOf(sundayOnly) : undefined),
    };
    const { service } = moduleOf(
      { workingDays: { calendar: "crew" }, unit: "day" },
      { workingTime: () => provider },
    );
    // Under the crew calendar Monday is non-working; nearest acceptable is Monday 00:00 itself
    // (it closes working Sunday) — a midday Monday moves back to it.
    expect(service.snap(utc(2024, 3, 18, 14))).toBe(utc(2024, 3, 18));
    // Early Thursday: the next Sunday's midnight beats the previous Monday's midnight.
    expect(service.snap(utc(2024, 3, 21, 1))).toBe(utc(2024, 3, 24));
  });

  it("treats a configured calendar id the provider does not resolve as no calendar", () => {
    const { service } = moduleOf(
      { workingDays: { calendar: "missing" }, unit: "day" },
      { workingTime: () => ({ boundaries: () => undefined }) },
    );
    // Sunday midday would move under a resolvable default, but the explicit unknown id must
    // neither fall back to a default nor pretend to resolve: day-rounded, then untouched.
    expect(service.snap(utc(2024, 3, 17, 10))).toBe(utc(2024, 3, 17));
  });

  it("heals an initially unresolvable configured id once the provider starts resolving it", () => {
    let resolvable = false;
    const provider: WorkingTimeProvider = {
      boundaries: (calendar) =>
        calendar === "crew" && resolvable ? boundsOf(DAY_GRANULAR) : undefined,
    };
    const { service } = moduleOf(
      { workingDays: { calendar: "crew" }, unit: "day" },
      { workingTime: () => provider },
    );
    expect(service.snap(utc(2024, 3, 17, 10))).toBe(utc(2024, 3, 17)); // unresolved: pass-through
    resolvable = true;
    expect(service.snap(utc(2024, 3, 17, 10))).toBe(utc(2024, 3, 18)); // now resolves: Sunday moves
  });

  it("re-resolves the default calendar on every call", () => {
    let cal = DAY_GRANULAR;
    const { service } = moduleOf(
      { workingDays: true, unit: "day" },
      { workingTime: () => ({ boundaries: () => boundsOf(cal) }) },
    );
    expect(service.snap(utc(2024, 3, 17, 10))).toBe(utc(2024, 3, 18));
    cal = { workingDays: [0, 1, 2, 3, 4, 5, 6] };
    expect(service.snap(utc(2024, 3, 17, 10))).toBe(utc(2024, 3, 17));
  });

  it("is inert without a composed provider, or with one that cannot resolve any calendar", () => {
    const absent = moduleOf({ workingDays: true, unit: "day" });
    expect(absent.service.snap(utc(2024, 3, 17, 10))).toBe(utc(2024, 3, 17));
    const noDefault = moduleOf(
      { workingDays: true, unit: "day" },
      { workingTime: () => ({ boundaries: () => undefined }) },
    );
    expect(noDefault.service.snap(utc(2024, 3, 17, 10))).toBe(utc(2024, 3, 17));
  });

  it("changes nothing when unconfigured, even with a provider composed (default-off)", () => {
    // Unlike the earlier implementation (whose absent-scale default rounded to whole days even
    // with the feature off), the default unit here is "scale", and with no scale rows composed
    // `snap()` is identity — so an unconfigured `workingDays` here leaves the instant completely
    // untouched, not day-rounded.
    const { service } = moduleOf(undefined, {
      workingTime: () => ({ boundaries: () => boundsOf(DAY_GRANULAR) }),
    });
    const t = utc(2024, 3, 17, 10);
    expect(service.snap(t)).toBe(t);
  });

  it("honors a calendar's intra-day windows under the unchanged workingDays key", () => {
    const office = { workingDays: [1, 2, 3, 4, 5], workingHours: [[32_400_000, 61_200_000]] as const };
    const { service } = moduleOf(
      { workingDays: true, unit: "day" },
      { workingTime: () => ({ boundaries: () => boundsOf(office) }) },
    );
    // Friday 10:00 rounds to Friday 00:00, outside the 09:00-17:00 window. Thursday 17:00 (the
    // previous window's close) is 7h back; Friday 09:00 is 9h forward; the nearer boundary wins.
    expect(service.snap(utc(2024, 3, 15, 10))).toBe(utc(2024, 3, 14, 17));
    // Friday 20:00 rounds to Saturday 00:00: back to Friday 17:00 is 7h, forward to Monday 09:00
    // is 57h. A day-granular calendar would have accepted Saturday 00:00 in place — this is
    // exactly the behaviour intra-day windows add.
    expect(service.snap(utc(2024, 3, 15, 20))).toBe(utc(2024, 3, 15, 17));
  });

  // `step()` is not affected by the avoidance: keyboard steps keep their calendar length.
  it("leaves step() alone, intra-day windows or not", () => {
    const office = { workingDays: [1, 2, 3, 4, 5], workingHours: [[32_400_000, 61_200_000]] as const };
    const { service } = moduleOf(
      { workingDays: true, unit: "day" },
      { workingTime: () => ({ boundaries: () => boundsOf(office) }) },
    );
    // Sunday: a full non-working day, yet one step forward is still one whole day.
    expect(service.step(utc(2024, 3, 17, 10), 1)).toBe(MS_DAY);
    expect(service.step(utc(2024, 3, 17, 10), -1)).toBe(-MS_DAY);
  });

  // New in v2 (§3, WorkingTimeProvider): the provider is consulted on every adjustment and never
  // cached across them — the freshness contract this file was specifically asked to verify.
  it("asks the composed provider fresh on every adjustment, never caching across calls", () => {
    const provider = countingProvider(() => boundsOf(DAY_GRANULAR));
    const { service } = moduleOf({ workingDays: true, unit: "day" }, { workingTime: () => provider });
    service.snap(utc(2024, 3, 17, 10));
    expect(provider.calls).toBe(1);
    service.snap(utc(2024, 3, 18, 10));
    expect(provider.calls).toBe(2);
    service.snap(utc(2024, 3, 19, 10));
    expect(provider.calls).toBe(3);
  });

  // New in v2: a provider that throws is reported through `onFault` and the instant it was given
  // (already day-rounded by the built-in rule) passes through unchanged.
  it("reports a throwing provider through onFault and passes the rounded instant through", () => {
    const { onFault, faults } = faultSink();
    const boom = new Error("boundaries blew up");
    const { service } = moduleOf(
      { workingDays: true, unit: "day" },
      {
        workingTime: () => ({
          boundaries: () => {
            throw boom;
          },
        }),
        onFault,
      },
    );
    // Friday 10:00 day-rounds to Friday 00:00; the provider then throws instead of adjusting it.
    expect(service.snap(utc(2024, 3, 15, 10))).toBe(utc(2024, 3, 15));
    expect(faults).toEqual([boom]);
  });
});

/* ------------------------------------------------------------------ *
 * successor push-out (§6.3 pushSuccessors)
 * ------------------------------------------------------------------ */

const D = MS_DAY;

function move(id: TaskId, from: [number, number], to: [number, number]): Patch {
  return {
    op: "task/update",
    id,
    before: { start: from[0], end: from[1] },
    after: { start: to[0], end: to[1] },
  };
}

describe("successor push-out", () => {
  const a = task({ id: "a", start: 0, end: 2 * D });
  const b = task({ id: "b", start: 3 * D, end: 4 * D });
  const links: Link[] = [{ id: "l1", sourceId: "a", targetId: "b", type: "FS" }];
  const withData = { view: () => dataView([a, b], links) };

  function userTx(): { origin: string; patches: Patch[] } {
    return { origin: "user", patches: [move("a", [0, 2 * D], [0, 5 * D])] };
  }

  it("appends correction patches to a user transaction", () => {
    const module = moduleOf({ pushSuccessors: true }, withData);
    const tx = userTx();
    module.appendPushOut(tx);
    expect(tx.patches).toHaveLength(2);
    expect(tx.patches[1]).toEqual({
      op: "task/update",
      id: "b",
      before: { start: 3 * D, end: 4 * D },
      after: { start: 5 * D, end: 6 * D },
    });
  });

  it("leaves non-user transactions alone", () => {
    const module = moduleOf({ pushSuccessors: true }, withData);
    const tx = { origin: "schedule", patches: userTx().patches };
    module.appendPushOut(tx);
    expect(tx.patches).toHaveLength(1);
  });

  it("does nothing when unconfigured (default-off)", () => {
    const module = moduleOf(undefined, withData);
    const tx = userTx();
    module.appendPushOut(tx);
    expect(tx.patches).toHaveLength(1);
  });

  it("runs when pushSuccessors is on and no guards are composed", () => {
    const module = moduleOf({ pushSuccessors: true }, { ...withData, pushGuards: () => [] });
    const tx = userTx();
    module.appendPushOut(tx);
    expect(tx.patches).toHaveLength(2);
  });

  it("stands down when a composed guard suppresses the pass", () => {
    const module = moduleOf(
      { pushSuccessors: true },
      { ...withData, pushGuards: (): readonly PushGuard[] => [() => true] },
    );
    const tx = userTx();
    module.appendPushOut(tx);
    expect(tx.patches).toHaveLength(1);
  });

  it("keeps pushing when every composed guard answers false", () => {
    const module = moduleOf(
      { pushSuccessors: true },
      { ...withData, pushGuards: (): readonly PushGuard[] => [() => false] },
    );
    const tx = userTx();
    module.appendPushOut(tx);
    expect(tx.patches).toHaveLength(2);
  });

  it("stands down and reports a throwing guard through onFault", () => {
    const { onFault, faults } = faultSink();
    const boom = new Error("guard blew up");
    const module = moduleOf(
      { pushSuccessors: true },
      {
        ...withData,
        pushGuards: (): readonly PushGuard[] => [
          () => {
            throw boom;
          },
        ],
        onFault,
      },
    );
    const tx = userTx();
    module.appendPushOut(tx);
    expect(tx.patches).toHaveLength(1);
    expect(faults).toEqual([boom]);
  });
});

/* ------------------------------------------------------------------ *
 * feature composition
 * ------------------------------------------------------------------ */

describe("composition of alignment and working-time avoidance", () => {
  it("applies the working-time adjustment after an alignment", () => {
    const PX_PER_MS = 1 / 3_600_000; // 8 px tolerance = 8 hours
    // The other task starts Sunday 10:00 — aligning there must still land working-adjacent.
    const other = task({ id: "other", start: utc(2024, 3, 17, 10), end: utc(2024, 3, 22) });
    const { service } = moduleOf(
      { alignToTasks: true, workingDays: true },
      {
        tasks: () => [other],
        pxPerMs: () => PX_PER_MS,
        workingTime: () => ({ boundaries: () => boundsOf(DAY_GRANULAR) }),
      },
    );
    // Within tolerance of Sunday 10:00; the aligned instant sits in a non-working Sunday, so the
    // final answer is the nearest working-adjacent boundary: Saturday 00:00 (closes Friday) is
    // 34h back, Monday 00:00 is 14h forward — Monday.
    expect(service.snap(utc(2024, 3, 17, 6))).toBe(utc(2024, 3, 18));
  });
});

// docs/specs/plugins/interaction.md §6.3 — `enabled: false` reproduces a composition with no
// rounding rule at all: the service still exists (consumers hold a rule, not an optional one) but
// rounds nothing, steps by one UTC day, and every extension pass is inert.
describe("`enabled: false`", () => {
  it("is enabled when the field is omitted, and only an explicit `false` disables it", () => {
    expect(moduleOf({ unit: "day" }).service.snap(utc(2024, 0, 1, 13))).toBe(utc(2024, 0, 2));
    expect(moduleOf({ unit: "day", enabled: true }).service.snap(utc(2024, 0, 1, 13))).toBe(
      utc(2024, 0, 2),
    );
    // The §6 rule 3 silent treatment of unusable values: anything but `false` reads as enabled.
    expect(
      moduleOf({ unit: "day", enabled: 0 as unknown as boolean }).service.snap(utc(2024, 0, 1, 13)),
    ).toBe(utc(2024, 0, 2));
  });

  it("rounds nothing, whatever unit or custom rule was configured alongside", () => {
    const instant = utc(2024, 0, 1, 13, 47, 3, 5);
    expect(moduleOf({ enabled: false, unit: "day" }).service.snap(instant)).toBe(instant);
    expect(moduleOf({ enabled: false, unit: MS_HOUR }).service.snap(instant)).toBe(instant);
    const rule = vi.fn((): SnapRule => ({ snap: () => 0 }));
    expect(moduleOf({ enabled: false, rule }).service.snap(instant)).toBe(instant);
    // The custom rule is never even built: a disabled feature calls no host code.
    expect(rule).not.toHaveBeenCalled();
  });

  it("steps by one UTC day in both directions, whatever the scale says", () => {
    const module = moduleOf({ enabled: false, unit: "month" }, { scaleUnit: () => "week" });
    expect(module.service.step(utc(2024, 1, 10), 1)).toBe(MS_DAY);
    expect(module.service.step(utc(2024, 1, 10), -1)).toBe(-MS_DAY);
  });

  it("never consults a composed working-time provider", () => {
    const provider = countingProvider(() => boundsOf(DAY_GRANULAR));
    const module = moduleOf(
      { enabled: false, unit: "day", workingDays: true },
      { workingTime: () => provider },
    );
    // Saturday: with the feature on this would be displaced onto a working boundary.
    const saturday = utc(2024, 2, 16, 6);
    expect(module.service.snap(saturday)).toBe(saturday);
    expect(provider.calls).toBe(0);
  });

  it("appends no push-out patches, and asks no guard whether it may", () => {
    const guard = vi.fn((): boolean => false) as PushGuard;
    const source = task({ id: "a", start: 0, end: 2 * MS_DAY });
    const target = task({ id: "b", start: 0, end: MS_DAY });
    const link: Link = { id: "l", sourceId: "a", targetId: "b", type: "FS" };
    const module = moduleOf(
      { enabled: false, pushSuccessors: true },
      { view: () => dataView([source, target], [link]), pushGuards: () => [guard] },
    );
    const patches: Patch[] = [
      { op: "task/update", id: "a", before: { end: MS_DAY }, after: { end: 2 * MS_DAY } },
    ];
    module.appendPushOut({ origin: "user", patches });
    expect(patches).toHaveLength(1);
    expect(guard).not.toHaveBeenCalled();
  });

  it("keeps `invalidateEdges` callable, so the caller needs no second branch", () => {
    const module = moduleOf({ enabled: false, alignToTasks: true });
    expect(() => module.invalidateEdges()).not.toThrow();
  });
});
