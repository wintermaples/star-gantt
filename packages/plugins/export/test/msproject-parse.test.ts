// docs/specs/plugins/export.md §1.7 — MSPDI parsing.
// `parseMsProjectXml` is hostless and pure, exercised directly rather than through the service.
import { describe, expect, it } from "vitest";
import { parseMsProjectXml, parseMspDate } from "../src/internal/msproject/parse";

const DAY = 86_400_000;
const T = (day: string): number => Date.parse(`2026-01-${day}T00:00:00Z`);

/** A small MSPDI fixture: 2-level WBS, a link with lag, a resource, an assignment, baselines. */
function fixtureXml(): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Project xmlns="http://schemas.microsoft.com/project">
  <Name>Fixture</Name>
  <Tasks>
    <Task>
      <UID>0</UID><Name>Project summary</Name>
      <Start>2026-01-01T00:00:00</Start><Finish>2026-01-20T00:00:00</Finish>
    </Task>
    <Task>
      <UID>1</UID><Name>Phase &amp; scope</Name>
      <OutlineNumber>1</OutlineNumber><OutlineLevel>1</OutlineLevel>
      <Start>2026-01-01T00:00:00</Start><Finish>2026-01-10T00:00:00</Finish>
      <Summary>1</Summary>
      <Baseline><Number>0</Number><Start>2026-01-01T00:00:00</Start><Finish>2026-01-08T00:00:00</Finish></Baseline>
    </Task>
    <Task>
      <UID>2</UID><Name>Draft</Name>
      <OutlineNumber>1.1</OutlineNumber><OutlineLevel>2</OutlineLevel>
      <Start>2026-01-01T00:00:00</Start><Finish>2026-01-05T00:00:00</Finish>
      <PercentComplete>40</PercentComplete>
      <Baseline><Number>0</Number><Start>2026-01-01T00:00:00</Start><Finish>2026-01-04T00:00:00</Finish></Baseline>
      <Baseline><Number>1</Number><Start>2026-01-02T00:00:00</Start><Finish>2026-01-05T00:00:00</Finish></Baseline>
    </Task>
    <Task>
      <UID>3</UID><Name>Review</Name>
      <OutlineNumber>1.2</OutlineNumber><OutlineLevel>2</OutlineLevel>
      <Start>2026-01-06T00:00:00</Start><Finish>2026-01-10T00:00:00</Finish>
      <PredecessorLink><PredecessorUID>2</PredecessorUID><Type>1</Type><LinkLag>14400</LinkLag><LagFormat>7</LagFormat></PredecessorLink>
    </Task>
    <Task>
      <UID>4</UID><Name>Ship</Name>
      <OutlineNumber>2</OutlineNumber><OutlineLevel>1</OutlineLevel>
      <Start>2026-01-10T00:00:00</Start><Finish>2026-01-10T00:00:00</Finish>
      <Milestone>1</Milestone>
      <PredecessorLink><PredecessorUID>3</PredecessorUID><Type>3</Type></PredecessorLink>
    </Task>
  </Tasks>
  <Resources>
    <Resource><UID>0</UID><Name>Unassigned</Name></Resource>
    <Resource><UID>7</UID><Name>Bob</Name><MaxUnits>0.5</MaxUnits></Resource>
  </Resources>
  <Assignments>
    <Assignment><UID>1</UID><TaskUID>2</TaskUID><ResourceUID>7</ResourceUID><Units>0.5</Units></Assignment>
    <Assignment><UID>2</UID><TaskUID>99</TaskUID><ResourceUID>7</ResourceUID><Units>1</Units></Assignment>
  </Assignments>
</Project>`;
}

describe("parseMspDate", () => {
  it("rejects years below the four-digit floor instead of letting Date.UTC map them into 1900-1999", () => {
    // Date.UTC(99, ...) silently maps a two-digit year into 1999 — MSPDI years are always
    // four-digit, so anything shorter is rejected rather than misread.
    expect(parseMspDate("0100-02-29T00:00:00")).toBeUndefined();
    expect(parseMspDate("0999-12-31T00:00:00")).toBeUndefined();
    expect(parseMspDate("1000-01-01T00:00:00")).toBe(Date.UTC(1000, 0, 1));
  });

  it("rejects an explicit zone offset instead of silently misreading it (§1.7)", () => {
    expect(parseMspDate("2026-01-01T00:00:00+05:00")).toBeUndefined();
    expect(parseMspDate("2026-01-01T00:00:00Z")).toBe(Date.UTC(2026, 0, 1));
  });
});

describe("parseMsProjectXml", () => {
  it("parses tasks, skips UID 0, decodes entities and reads progress/type", () => {
    const doc = parseMsProjectXml(fixtureXml());
    expect(doc.tasks.map((t) => t.id)).toEqual(["1", "2", "3", "4"]);
    const phase = doc.tasks[0]!;
    expect(phase.name).toBe("Phase & scope");
    expect(phase.type).toBe("summary");
    expect(phase.start).toBe(T("01"));
    expect(phase.end).toBe(T("10"));
    expect(doc.tasks[1]!.progress).toBeCloseTo(0.4);
    expect(doc.tasks[3]!.type).toBe("milestone");
    expect(doc.issues).toEqual([]);
  });

  it("rebuilds the WBS hierarchy from dotted outline numbers", () => {
    const doc = parseMsProjectXml(fixtureXml());
    const byId = new Map(doc.tasks.map((t) => [t.id, t]));
    expect(byId.get("1")!.parentId).toBeNull();
    expect(byId.get("2")!.parentId).toBe("1");
    expect(byId.get("3")!.parentId).toBe("1");
    expect(byId.get("4")!.parentId).toBeNull();
  });

  it("falls back to the outline-level stack when no dotted code is present", () => {
    const xml = `<Project><Tasks>
      <Task><UID>1</UID><Name>Root</Name><OutlineLevel>1</OutlineLevel>
        <Start>2026-01-01T00:00:00</Start><Finish>2026-01-05T00:00:00</Finish></Task>
      <Task><UID>2</UID><Name>Child</Name><OutlineLevel>2</OutlineLevel>
        <Start>2026-01-01T00:00:00</Start><Finish>2026-01-02T00:00:00</Finish></Task>
      <Task><UID>3</UID><Name>Grandchild</Name><OutlineLevel>3</OutlineLevel>
        <Start>2026-01-01T00:00:00</Start><Finish>2026-01-02T00:00:00</Finish></Task>
      <Task><UID>4</UID><Name>Sibling</Name><OutlineLevel>2</OutlineLevel>
        <Start>2026-01-02T00:00:00</Start><Finish>2026-01-03T00:00:00</Finish></Task>
    </Tasks></Project>`;
    const doc = parseMsProjectXml(xml);
    const byId = new Map(doc.tasks.map((t) => [t.id, t]));
    expect(byId.get("2")!.parentId).toBe("1");
    expect(byId.get("3")!.parentId).toBe("2");
    expect(byId.get("4")!.parentId).toBe("1");
  });

  it("ignores a non-dotted-numeric OutlineNumber and uses the outline-level stack", () => {
    const xml = `<Project><Tasks>
      <Task><UID>1</UID><Name>Root</Name><OutlineNumber>A</OutlineNumber><OutlineLevel>1</OutlineLevel>
        <Start>2026-01-01T00:00:00</Start><Finish>2026-01-05T00:00:00</Finish></Task>
      <Task><UID>2</UID><Name>Child</Name><OutlineNumber>A.1</OutlineNumber><OutlineLevel>2</OutlineLevel>
        <Start>2026-01-01T00:00:00</Start><Finish>2026-01-02T00:00:00</Finish></Task>
    </Tasks></Project>`;
    const doc = parseMsProjectXml(xml);
    const byId = new Map(doc.tasks.map((t) => [t.id, t]));
    expect(byId.get("1")!.parentId).toBeNull();
    expect(byId.get("2")!.parentId).toBe("1");
    expect(doc.issues).toEqual([]);
  });

  it("reports an unknown dotted parent and falls back to the level stack", () => {
    const xml = `<Project><Tasks>
      <Task><UID>1</UID><Name>Orphan</Name><OutlineNumber>3.9.1</OutlineNumber>
        <Start>2026-01-01T00:00:00</Start><Finish>2026-01-02T00:00:00</Finish></Task>
    </Tasks></Project>`;
    const doc = parseMsProjectXml(xml);
    expect(doc.tasks[0]!.parentId).toBeNull();
    expect(doc.issues).toContainEqual({ code: "unknown-parent", taskId: "1", wbs: "3.9.1" });
  });

  it("maps predecessor links with type codes and tenth-of-minute lag", () => {
    const doc = parseMsProjectXml(fixtureXml());
    expect(doc.links).toHaveLength(2);
    const [fs, ss] = doc.links;
    expect(fs).toMatchObject({ sourceId: "2", targetId: "3", type: "FS", lag: DAY });
    expect(ss).toMatchObject({ sourceId: "3", targetId: "4", type: "SS" });
    expect(ss!.lag).toBeUndefined();
  });

  it("reads resources (skipping UID 0) and assignments (skipping unknown ends)", () => {
    const doc = parseMsProjectXml(fixtureXml());
    expect(doc.resources).toEqual([{ id: "7", name: "Bob", capacity: 0.5 }]);
    expect(doc.assignments).toEqual([{ taskId: "2", resourceId: "7", units: 0.5 }]);
  });

  it("groups per-task baselines by number, ordered", () => {
    const doc = parseMsProjectXml(fixtureXml());
    expect(doc.baselines.map((b) => [b.number, b.name])).toEqual([
      [0, "Baseline"],
      [1, "Baseline 1"],
    ]);
    expect(doc.baselines[0]!.tasks.map((t) => t.id)).toEqual(["1", "2"]);
    expect(doc.baselines[1]!.tasks).toEqual([{ id: "2", start: T("02"), end: T("05") }]);
  });

  it("is tolerant: bad dates, duplicate and missing UIDs are reported, the rest survive", () => {
    const xml = `<Project><Tasks>
      <Task><UID>1</UID><Name>Good</Name><Start>2026-01-01T00:00:00</Start><Finish>2026-01-02T00:00:00</Finish></Task>
      <Task><UID>2</UID><Name>Bad date</Name><Start>soon</Start><Finish>2026-01-02T00:00:00</Finish></Task>
      <Task><UID>1</UID><Name>Dup</Name><Start>2026-01-01T00:00:00</Start><Finish>2026-01-02T00:00:00</Finish></Task>
      <Task><Name>No uid</Name><Start>2026-01-01T00:00:00</Start><Finish>2026-01-02T00:00:00</Finish></Task>
    </Tasks></Project>`;
    const doc = parseMsProjectXml(xml);
    expect(doc.tasks.map((t) => t.id)).toEqual(["1"]);
    expect(doc.issues.map((i) => i.code).sort()).toEqual(["bad-date", "invalid-task", "invalid-task"]);
  });

  it("clamps end < start to end = start and treats zone-less dates as UTC", () => {
    const xml = `<Project><Tasks>
      <Task><UID>1</UID><Name>Backwards</Name><Start>2026-01-05T08:30:00</Start><Finish>2026-01-01T00:00:00</Finish></Task>
    </Tasks></Project>`;
    const doc = parseMsProjectXml(xml);
    expect(doc.tasks[0]!.start).toBe(Date.parse("2026-01-05T08:30:00Z"));
    expect(doc.tasks[0]!.end).toBe(doc.tasks[0]!.start);
  });

  it("rejects an out-of-range date (bad month/day) instead of producing an invalid Date", () => {
    const xml = `<Project><Tasks>
      <Task><UID>1</UID><Name>Bad</Name><Start>2024-13-45T00:00:00</Start><Finish>2026-01-02T00:00:00</Finish></Task>
    </Tasks></Project>`;
    const doc = parseMsProjectXml(xml);
    expect(doc.tasks).toEqual([]);
    expect(doc.issues).toContainEqual({ code: "bad-date", field: "start", value: "2024-13-45T00:00:00", uid: "1" });
  });

  it("fails soft on malformed XML, a wrong root, and non-string input", () => {
    for (const bad of ["<Project><Tasks></Project>", "<NotAProject/>", "", "plain text < broken"]) {
      const doc = parseMsProjectXml(bad);
      expect(doc.tasks).toEqual([]);
      expect(doc.issues[0]!.code).toBe("invalid-xml");
    }
    const doc = parseMsProjectXml(42 as unknown as string);
    expect(doc.issues[0]!.code).toBe("invalid-xml");
  });
});
