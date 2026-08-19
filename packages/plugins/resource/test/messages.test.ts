/**
 * The merged §7 catalog: 37 keys, byte-for-byte defaults, the three recorded collision
 * resolutions, the divider-label rule, and the one `duration` seam every built-in
 * duration-embedding text routes through.
 *
 * The message cases of the two engine suites are bridged here, since the catalog they pinned is
 * now this one.
 */
import { describe, expect, it } from "vitest";
import {
  DEFAULT_MESSAGES,
  RESOURCE_MESSAGE_KEYS,
  bindDuration,
  resolveMessages,
} from "../src/internal/messages";

const DAY = 86400000;
const HOUR = 3600000;

const noFault = (): void => undefined;

const team = {
  team: "core",
  allocated: 12.5 * DAY,
  capacity: 10 * DAY,
  available: 0,
  resourceCount: 2,
  overallocatedCount: 1,
};

describe("the merged catalog (§7)", () => {
  it("carries exactly the 37 keys the spec names", () => {
    expect(RESOURCE_MESSAGE_KEYS).toHaveLength(37);
    expect([...RESOURCE_MESSAGE_KEYS].sort()).toEqual(
      [
        "applyLabel",
        "assignColumnHeader",
        "assignToggleLabel",
        "bandLabel",
        "bandResizeLabel",
        "cancelLabel",
        "chipLabel",
        "closeLabel",
        "defaultTeamName",
        "demandLegend",
        "duration",
        "editorTitle",
        "emptyChoices",
        "heatmapCellLabel",
        "heatmapTitle",
        "laneLabel",
        "lanesLabel",
        "lanesResizeLabel",
        "openEditorLabel",
        "overallocatedCell",
        "panelLabel",
        "reportColumnHeader",
        "reportTitle",
        "resizeLabel",
        "roleLine",
        "roleTitle",
        "rowLabel",
        "segmentLabel",
        "summaryTitle",
        "supplyLegend",
        "teamCardLine",
        "teamSummary",
        "trendLabel",
        "trendTitle",
        "ungroupedTeam",
        "unitsInputLabel",
        "utilizationColumnHeader",
      ].sort(),
    );
  });

  it("resolves the three collisions the way §7 records", () => {
    // Two merged (identical role and default on both sides)…
    expect(DEFAULT_MESSAGES.closeLabel).toBe("Close");
    expect(typeof DEFAULT_MESSAGES.duration).toBe("function");
    // …and one prefixed on both sides by feature area.
    expect(DEFAULT_MESSAGES.assignColumnHeader).toBe("Resources");
    expect(DEFAULT_MESSAGES.utilizationColumnHeader).toBe("Overallocation");
    expect(RESOURCE_MESSAGE_KEYS).not.toContain("columnHeader");
  });

  it("keeps the defaults of the surviving plain-string keys", () => {
    expect(DEFAULT_MESSAGES.editorTitle).toBe("Assign resources");
    expect(DEFAULT_MESSAGES.emptyChoices).toBe("No resources available");
    expect(DEFAULT_MESSAGES.applyLabel).toBe("Apply");
    expect(DEFAULT_MESSAGES.cancelLabel).toBe("Cancel");
    expect(DEFAULT_MESSAGES.openEditorLabel).toBe("Edit resource assignments");
    expect(DEFAULT_MESSAGES.panelLabel).toBe("Resource view");
    expect(DEFAULT_MESSAGES.ungroupedTeam).toBe("Other resources");
    expect(DEFAULT_MESSAGES.resizeLabel).toBe("Resize resource view");
    expect(DEFAULT_MESSAGES.summaryTitle).toBe("Team capacity");
    expect(DEFAULT_MESSAGES.roleTitle).toBe("Demand by role");
    expect(DEFAULT_MESSAGES.trendTitle).toBe("Demand vs supply");
    expect(DEFAULT_MESSAGES.demandLegend).toBe("Demand");
    expect(DEFAULT_MESSAGES.supplyLegend).toBe("Supply");
    expect(DEFAULT_MESSAGES.defaultTeamName).toBe("All resources");
    expect(DEFAULT_MESSAGES.bandResizeLabel).toBe("Resize load chart band");
    expect(DEFAULT_MESSAGES.lanesResizeLabel).toBe("Resize resource lanes");
    expect(DEFAULT_MESSAGES.heatmapTitle).toBe("Load heatmap");
    expect(DEFAULT_MESSAGES.reportTitle).toBe("Resource utilization report");
  });

  it("keeps defaults for absent and unusable overrides", () => {
    const m = resolveMessages(
      {
        assignColumnHeader: "Load",
        // @ts-expect-error — deliberately unusable: a number where a string is expected.
        summaryTitle: 42,
        overallocatedCell: () => "x",
      },
      noFault,
    );
    expect(m.assignColumnHeader).toBe("Load");
    expect(m.summaryTitle).toBe(DEFAULT_MESSAGES.summaryTitle);
    expect(m.overallocatedCell({ resources: [] })).toBe("x");
  });

  // §7 — a focusable separator is never unnamed.
  it("refuses to suppress a divider name, while every other key accepts `\"\"`", () => {
    const m = resolveMessages(
      { resizeLabel: "", bandResizeLabel: "   ", lanesResizeLabel: "", summaryTitle: "" },
      noFault,
    );
    expect(m.resizeLabel).toBe(DEFAULT_MESSAGES.resizeLabel);
    expect(m.bandResizeLabel).toBe(DEFAULT_MESSAGES.bandResizeLabel);
    expect(m.lanesResizeLabel).toBe(DEFAULT_MESSAGES.lanesResizeLabel);
    expect(m.summaryTitle).toBe("");
  });
});

describe("the builders (exact wordings)", () => {
  // Durations are never printed raw.
  it("formats durations by magnitude", () => {
    expect(DEFAULT_MESSAGES.duration(1.5 * DAY)).toBe("1.5d");
    expect(DEFAULT_MESSAGES.duration(4 * HOUR)).toBe("4h");
    expect(DEFAULT_MESSAGES.duration(30 * 60000)).toBe("30m");
    expect(DEFAULT_MESSAGES.duration(0)).toBe("0s");
  });

  it("builds the default texts", () => {
    expect(DEFAULT_MESSAGES.overallocatedCell({ resources: ["Ana", "Bo"] })).toBe("⚠ Over: Ana, Bo");
    expect(DEFAULT_MESSAGES.teamCardLine(team)).toBe(
      "core: 12.5d allocated of 10d, 0s free (1 overallocated)",
    );
    expect(
      DEFAULT_MESSAGES.roleLine({ role: "dev", demand: 15 * DAY, capacity: 10 * DAY, ratio: 1.5 }),
    ).toBe("dev: 15d demand of 10d capacity");
    expect(DEFAULT_MESSAGES.chipLabel({ name: "Ana", unitsPercent: 100 })).toBe("Ana");
    expect(DEFAULT_MESSAGES.chipLabel({ name: "Ana", unitsPercent: 50 })).toBe("Ana 50%");
    expect(DEFAULT_MESSAGES.reportColumnHeader("resource")).toBe("Resource");
    expect(DEFAULT_MESSAGES.reportColumnHeader("utilization")).toBe("Utilization");
  });

  it("routes every built-in duration text through a replaced duration member", () => {
    const m = bindDuration(
      resolveMessages({ duration: (ms) => `${String(ms / DAY)}dd` }, noFault),
      (ms) => `${String(ms / DAY)}dd`,
    );
    expect(m.teamCardLine(team)).toBe("core: 12.5dd allocated of 10dd, 0dd free (1 overallocated)");
    expect(
      m.trendLabel({
        bucketCount: 2,
        rangeStart: Date.UTC(2024, 0, 1),
        rangeEnd: Date.UTC(2024, 0, 3),
        peakDemand: DAY,
        peakSupply: 2 * DAY,
      }),
    ).toBe("Demand vs supply, 2 buckets: peak demand 1dd, peak supply 2dd.");
  });

  // COVERAGE review item — these three builders were previously exercised only by key-presence
  // checks (the `RESOURCE_MESSAGE_KEYS` list above); invoke them for real and pin the exact
  // wordings, including the `valueKind` branching `laneLabel`/`bandLabel` share.
  it("lanesLabel: the resource-lane strip's own accessible name", () => {
    expect(DEFAULT_MESSAGES.lanesLabel({ laneCount: 0 })).toBe("Resource load by resource, 0 resources.");
    expect(DEFAULT_MESSAGES.lanesLabel({ laneCount: 7 })).toBe("Resource load by resource, 7 resources.");
  });

  it("laneLabel: valueKind 'ratio' renders peakLoad as a plain number, not a duration", () => {
    const start = Date.UTC(2024, 0, 1); // Mon 2024-01-01
    const end = Date.UTC(2024, 0, 8); // Mon 2024-01-08 — a week later, day-resolution stamps
    const text = DEFAULT_MESSAGES.laneLabel({
      resourceName: "Ada",
      rangeStart: start,
      rangeEnd: end,
      bucketCount: 7,
      peakLoad: 1.5,
      capacity: 1,
      overloadedBuckets: 2,
      valueKind: "ratio",
    });
    const stamp = new Intl.DateTimeFormat("en-US", { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" });
    expect(text).toBe(
      `Ada, 7 buckets from ${stamp.format(start)} to ${stamp.format(end)}: peak load 1.5 of capacity 1, 2 overloaded.`,
    );
  });

  it("laneLabel: valueKind 'durationMs' routes peakLoad through the duration seam, capacity stays a plain number", () => {
    const start = Date.UTC(2024, 0, 1);
    const end = Date.UTC(2024, 0, 2); // one day — still day-resolution (>= MS_DAY per stampsFor)
    const text = DEFAULT_MESSAGES.laneLabel({
      resourceName: "Bo",
      rangeStart: start,
      rangeEnd: end,
      bucketCount: 24,
      peakLoad: 4 * HOUR,
      capacity: 1,
      overloadedBuckets: 0,
      valueKind: "durationMs",
    });
    expect(text).toContain("Bo, 24 buckets from");
    expect(text).toContain("peak load 4h of capacity 1, 0 overloaded.");
  });

  it("heatmapCellLabel: durations for allocated/capacity, an inclusive day-resolution 'to' stamp, and the overload suffix", () => {
    const start = Date.UTC(2024, 0, 1); // Mon
    const end = Date.UTC(2024, 0, 3); // Wed (exclusive) — day-or-wider bucket, day resolution
    const clean = DEFAULT_MESSAGES.heatmapCellLabel({
      start,
      end,
      allocated: 1 * DAY,
      capacity: 2 * DAY,
      ratio: 0.5,
      resourceName: "Ada",
    });
    const stamp = new Intl.DateTimeFormat("en-US", { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" });
    // Inclusive end for a day-or-wider bucket steps back one day: end - MS_DAY.
    const inclusiveTo = stamp.format(end - DAY);
    expect(clean).toBe(`Ada, ${stamp.format(start)} – ${inclusiveTo}: load 1d of capacity 2d`);

    const over = DEFAULT_MESSAGES.heatmapCellLabel({
      start,
      end,
      allocated: 3 * DAY,
      capacity: 2 * DAY,
      ratio: 1.5,
      resourceName: "Ada",
    });
    expect(over).toBe(`Ada, ${stamp.format(start)} – ${inclusiveTo}: load 3d of capacity 2d, overloaded`);
  });

  it("heatmapCellLabel: a sub-day bucket uses minute-resolution stamps", () => {
    const start = Date.UTC(2024, 0, 1, 9, 0); // 09:00 UTC
    const end = Date.UTC(2024, 0, 1, 10, 0); // 10:00 UTC — sub-day (< MS_DAY)
    const text = DEFAULT_MESSAGES.heatmapCellLabel({
      start,
      end,
      allocated: 30 * 60000,
      capacity: HOUR,
      ratio: 0.5,
      resourceName: "Ada",
    });
    const dateTime = new Intl.DateTimeFormat("en-US", {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      timeZone: "UTC",
    });
    // Sub-day inclusive end steps back one MINUTE, not one day.
    expect(text).toBe(
      `Ada, ${dateTime.format(start)} – ${dateTime.format(end - 60000)}: load 30m of capacity 1h`,
    );
  });

  it("leaves a wholesale-replaced builder out of the duration seam", () => {
    const m = resolveMessages(
      { teamCardLine: (t) => `${t.team}!`, duration: () => "never" },
      noFault,
    );
    expect(m.teamCardLine(team)).toBe("core!");
    // Re-binding keeps that builder as is…
    expect(bindDuration(m, () => "also never").teamCardLine(team)).toBe("core!");
    // …while a built-in one still follows the supplied formatter.
    expect(
      bindDuration(m, (ms) => `${String(ms)}!`).roleLine({
        role: "dev",
        demand: 1,
        capacity: 2,
        ratio: 0.5,
      }),
    ).toBe("dev: 1! demand of 2! capacity");
  });
});
