/**
 * The link-constraint algebra and the shared CPM backward pass (docs/specs/sdk.md, Module:
 * sdk/cpm).
 */
import { describe, expect, it } from "vitest";
import { criticalTaskIds, latestTimes, linkAnchors, linkSlack } from "../src/index";
import type { CpmLink, CpmTask } from "../src/index";

const t = (id: string, start: number, end: number): CpmTask => ({ id, start, end });
const l = (sourceId: string, targetId: string, type: CpmLink["type"], lag?: number): CpmLink =>
  lag === undefined ? { sourceId, targetId, type } : { sourceId, targetId, type, lag };

describe("linkAnchors / linkSlack", () => {
  it("maps the four link types to their date anchors", () => {
    expect(linkAnchors("FS")).toEqual({ source: "end", target: "start" });
    expect(linkAnchors("SS")).toEqual({ source: "start", target: "start" });
    expect(linkAnchors("FF")).toEqual({ source: "end", target: "end" });
    expect(linkAnchors("SF")).toEqual({ source: "start", target: "end" });
  });

  it("computes slack per type from the endpoints' current dates, honoring lag", () => {
    const source = { start: 0, end: 10 };
    const target = { start: 15, end: 25 };
    expect(linkSlack({ type: "FS" }, source, target)).toBe(5);
    expect(linkSlack({ type: "SS" }, source, target)).toBe(15);
    expect(linkSlack({ type: "FF" }, source, target)).toBe(15);
    expect(linkSlack({ type: "SF" }, source, target)).toBe(25);
    expect(linkSlack({ type: "FS", lag: 5 }, source, target)).toBe(0);
    expect(linkSlack({ type: "FS", lag: 7 }, source, target)).toBe(-2);
    expect(linkSlack({ type: "FS", lag: Number.NaN }, source, target)).toBe(5);
  });
});

describe("latestTimes", () => {
  it("bounds every task by the project end when there are no links", () => {
    const out = latestTimes([t("a", 0, 10), t("b", 5, 20)], []);
    expect(out.get("a")).toEqual({ latestStart: 10, latestFinish: 20 });
    expect(out.get("b")).toEqual({ latestStart: 5, latestFinish: 20 });
  });

  it("propagates FS constraints backward through a chain", () => {
    const out = latestTimes(
      [t("a", 0, 10), t("b", 10, 20), t("c", 20, 30)],
      [l("a", "b", "FS"), l("b", "c", "FS")],
    );
    expect(out.get("a")).toEqual({ latestStart: 0, latestFinish: 10 });
    expect(out.get("b")).toEqual({ latestStart: 10, latestFinish: 20 });
  });

  it("omits cycle members and predecessors constrained only through them", () => {
    const out = latestTimes(
      [t("pre", 0, 5), t("x", 5, 10), t("y", 10, 15), t("free", 0, 15)],
      [l("pre", "x", "FS"), l("x", "y", "FS"), l("y", "x", "FS")],
    );
    expect(out.has("x")).toBe(false);
    expect(out.has("y")).toBe(false);
    expect(out.has("pre")).toBe(false); // its only chain to the end runs through the cycle
    expect(out.get("free")).toEqual({ latestStart: 0, latestFinish: 15 });
  });

  it("ignores non-finite dates, unknown link endpoints, self-links and duplicate ids", () => {
    const out = latestTimes(
      [t("a", 0, 10), t("nan", Number.NaN, 5), t("a", 100, 200)],
      [l("a", "ghost", "FS"), l("a", "a", "FS")],
    );
    expect(out.size).toBe(1);
    expect(out.get("a")).toEqual({ latestStart: 0, latestFinish: 10 });
  });
});

describe("criticalTaskIds", () => {
  it("with no links, exactly the tasks ending at the project end are critical", () => {
    expect(criticalTaskIds([t("a", 0, 10), t("b", 5, 20), t("c", 15, 20)], [])).toEqual(["b", "c"]);
  });

  it("marks the driving chain critical and slack branches not", () => {
    const tasks = [t("a", 0, 10), t("b", 10, 20), t("slack", 0, 5)];
    const links = [l("a", "b", "FS")];
    expect(criticalTaskIds(tasks, links)).toEqual(["a", "b"]);
  });

  it("honors the tolerance option", () => {
    const tasks = [t("a", 0, 10), t("b", 15, 20)];
    const links = [l("a", "b", "FS")];
    // a's latest finish is 15: 5 ms of float.
    expect(criticalTaskIds(tasks, links)).toEqual(["b"]);
    expect(criticalTaskIds(tasks, links, { toleranceMs: 5 })).toEqual(["a", "b"]);
    expect(criticalTaskIds(tasks, links, { toleranceMs: 4 })).toEqual(["b"]);
  });

  it("honors SS/FF/SF constraints and lag in the backward pass", () => {
    // SS: b cannot start later than c's latest start minus lag.
    const out = latestTimes([t("b", 0, 10), t("c", 5, 20)], [l("b", "c", "SS", 5)]);
    expect(out.get("b")?.latestStart).toBe(0);
    expect(criticalTaskIds([t("b", 0, 10), t("c", 5, 20)], [l("b", "c", "SS", 5)])).toEqual([
      "b",
      "c",
    ]);
  });

  it("never reports a cycle member critical", () => {
    const tasks = [t("x", 0, 10), t("y", 0, 10)];
    const links = [l("x", "y", "FS"), l("y", "x", "FS")];
    expect(criticalTaskIds(tasks, links)).toEqual([]);
  });

  it("returns [] for an empty task set", () => {
    expect(criticalTaskIds([], [])).toEqual([]);
  });
});
