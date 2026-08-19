/**
 * The package's published surface (docs/specs/sdk.md, "Public export list"): the shared
 * micro-helpers and nothing else — in particular no plugin factory and no plugin id, because
 * `@stargantt/sdk` is not a plugin.
 */
import { describe, expect, it } from "vitest";
import * as sdk from "../src/index";

describe("published surface", () => {
  it("exports exactly the shared helpers plus the sdk/testing entry points", () => {
    expect(Object.keys(sdk).sort()).toEqual(
      [
        "createTestHost",
        "mockStore",
        "expectDepsConsistency",
        "MS_DAY",
        "MS_HOUR",
        "MS_MINUTE",
        "MS_SECOND",
        "isoDay",
        "listen",
        "parsePx",
        "createFrameScheduler",
        "DEFAULT_WORKWEEK",
        "MAX_SKIPPED_DAYS",
        "isWorkingDay",
        "isWorkingInstant",
        "hasWorkingHours",
        "workingIntervals",
        "nonWorkingIntervals",
        "workingMsBetween",
        "addWorkingMs",
        "subtractWorkingMs",
        "nextWorkingStart",
        "previousWorkingEnd",
        "landWorkingEnd",
        "startOfUtcDay",
        "utcDayOfWeek",
        "utcDateKey",
        "isDateKey",
        "dateKeyToTime",
        "formatDurationMs",
        "durationUnitMs",
        "durationUnits",
        "parseColor",
        "composite",
        "relativeLuminance",
        "contrastRatio",
        "createDialog",
        "createStripHeightTracker",
        "createStripToggle",
        "downloadFile",
        "lateService",
        "latchedSeam",
        "latchedBuilderBarrier",
        "resolveCatalog",
        "createTransactionBatcher",
        "linkAnchors",
        "linkSlack",
        "latestTimes",
        "criticalTaskIds",
        "forEachVisibleRow",
        "parseIsoDateStrict",
        "normalizeWheelDelta",
        "isEditableTarget",
        "findUp",
        "focusRestorer",
        "sameIdSet",
        "styled",
        "alignHalfPixel",
      ].sort(),
    );
  });

  it("exposes no registration surface", () => {
    const names = Object.keys(sdk);
    for (const pluginish of ["default", "sdk", "definePlugin", "meta", "setup"]) {
      expect(names).not.toContain(pluginish);
    }
  });
});
