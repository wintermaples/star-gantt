/**
 * docs/specs/plugins/scheduling.md §5.5 — link classification (conflicting / driving) and the
 * dependency-path walk, plus the ordered-pair rule (§5.2) and the emphasis state machine.
 * Hostless.
 */
import { describe, expect, it } from "vitest";
import type { Link, LinkId, TaskId } from "@stargantt/plugin-data-store";
import { linkStatus, linkTimes, pathLinkIds } from "../src/internal/links/analysis";
import { createLinkEmphasis } from "../src/internal/links/emphasis";
import { isPairLinked } from "../src/internal/links/pairs";
import { stubData, stubLink, stubTask } from "./links-doubles";

const DAY = 86_400_000;

describe("linkTimes / linkStatus (§5.5)", () => {
  const source = stubTask("a", { start: 0, end: 2 * DAY });

  it("FS constrains target.start from source.end", () => {
    const l = stubLink("l", "a", "b", "FS");
    const onTime = stubTask("b", { start: 2 * DAY, end: 3 * DAY });
    expect(linkTimes(l, source, onTime)).toEqual({ required: 2 * DAY, actual: 2 * DAY });
    expect(linkStatus(l, source, onTime)).toEqual({ conflicting: false, driving: true });
  });

  it("a target strictly earlier than required is conflicting, not driving", () => {
    const l = stubLink("l", "a", "b", "FS");
    const early = stubTask("b", { start: DAY, end: 2 * DAY });
    expect(linkStatus(l, source, early)).toEqual({ conflicting: true, driving: false });
  });

  it("a target later than required is neither conflicting nor driving", () => {
    const l = stubLink("l", "a", "b", "FS");
    const late = stubTask("b", { start: 3 * DAY, end: 4 * DAY });
    expect(linkStatus(l, source, late)).toEqual({ conflicting: false, driving: false });
  });

  it("lag shifts the constraint; negative lag is lead", () => {
    const lagged: Link = stubLink("l", "a", "b", "FS", DAY);
    const at3 = stubTask("b", { start: 3 * DAY, end: 4 * DAY });
    expect(linkStatus(lagged, source, at3)).toEqual({ conflicting: false, driving: true });
    const lead: Link = stubLink("l", "a", "b", "FS", -DAY);
    const at1 = stubTask("b", { start: DAY, end: 2 * DAY });
    expect(linkStatus(lead, source, at1)).toEqual({ conflicting: false, driving: true });
  });

  it("SS/FF/SF read the ends their type names", () => {
    const target = stubTask("b", { start: 0, end: 2 * DAY });
    // SS: target.start (0) vs source.start (0) — driving.
    expect(linkStatus(stubLink("l", "a", "b", "SS"), source, target).driving).toBe(true);
    // FF: target.end (2d) vs source.end (2d) — driving.
    expect(linkStatus(stubLink("l", "a", "b", "FF"), source, target).driving).toBe(true);
    // SF: target.end (2d) vs source.start (0) — later than required, neither.
    expect(linkStatus(stubLink("l", "a", "b", "SF"), source, target)).toEqual({
      conflicting: false,
      driving: false,
    });
  });

  it("is millisecond-exact: one ms early conflicts, exactly on time drives", () => {
    const l = stubLink("l", "a", "b", "FS");
    expect(linkStatus(l, source, stubTask("b", { start: 2 * DAY - 1, end: 3 * DAY })).conflicting).toBe(
      true,
    );
    expect(linkStatus(l, source, stubTask("b", { start: 2 * DAY, end: 3 * DAY })).driving).toBe(true);
    expect(linkStatus(l, source, stubTask("b", { start: 2 * DAY + 1, end: 3 * DAY })).driving).toBe(
      false,
    );
  });
});

/** A linksByTask index over the given links. */
function indexOf(links: Link[]): { linksByTask: Map<TaskId, { in: Link[]; out: Link[] }> } {
  const linksByTask = new Map<TaskId, { in: Link[]; out: Link[] }>();
  const bucket = (id: TaskId): { in: Link[]; out: Link[] } => {
    let b = linksByTask.get(id);
    if (b === undefined) {
      b = { in: [], out: [] };
      linksByTask.set(id, b);
    }
    return b;
  };
  for (const l of links) {
    bucket(l.sourceId).out.push(l);
    bucket(l.targetId).in.push(l);
  }
  return { linksByTask };
}

describe("pathLinkIds (§5.5)", () => {
  //  a → b → c → d, plus x → b (a second predecessor) and c → y (a second successor).
  const view = indexOf([
    stubLink("ab", "a", "b", "FS"),
    stubLink("bc", "b", "c", "FS"),
    stubLink("cd", "c", "d", "FS"),
    stubLink("xb", "x", "b", "FS"),
    stubLink("cy", "c", "y", "FS"),
  ]);

  const ids = (seeds: string[]): string[] => [...pathLinkIds(view, seeds)].map(String).sort();

  it("walks upstream and downstream transitively from one seed", () => {
    expect(ids(["b"])).toEqual(["ab", "bc", "cd", "cy", "xb"]);
  });

  it("an endpoint seed sees only its own side", () => {
    expect(ids(["a"])).toEqual(["ab", "bc", "cd", "cy"]);
    expect(ids(["d"])).toEqual(["ab", "bc", "cd", "xb"]);
  });

  it("a task with no links contributes nothing", () => {
    expect(ids(["z"])).toEqual([]);
  });

  it("unions several seeds", () => {
    expect(ids(["a", "d"])).toEqual(["ab", "bc", "cd", "cy", "xb"]);
  });

  it("terminates on a cyclic link table", () => {
    const cyclic = indexOf([stubLink("ab", "a", "b", "FS"), stubLink("ba", "b", "a", "FS")]);
    const out: Set<LinkId> = pathLinkIds(cyclic, ["a"]);
    expect([...out].sort()).toEqual(["ab", "ba"]);
  });
});

describe("isPairLinked (§5.2)", () => {
  const data = stubData(
    [stubTask("a"), stubTask("b"), stubTask("c")],
    [stubLink("ab", "a", "b", "FS")],
  );

  it("answers for the ordered pair the link runs in", () => {
    expect(isPairLinked(data.query(), "a", "b")).toBe(true);
  });

  it("treats the reverse direction as a different pair", () => {
    expect(isPairLinked(data.query(), "b", "a")).toBe(false);
  });

  it("answers false for an unlinked pair and an unknown source", () => {
    expect(isPairLinked(data.query(), "a", "c")).toBe(false);
    expect(isPairLinked(data.query(), "zz", "b")).toBe(false);
  });
});

describe("the emphasis state (§5.4 / §5.5)", () => {
  it("reports only real transitions, so a repaint is never wasted", () => {
    const e = createLinkEmphasis();
    expect(e.setHover("l0")).toBe(true);
    expect(e.setHover("l0")).toBe(false);
    expect(e.setSelected("l0")).toBe(true);
    expect(e.setSelected("l0")).toBe(false);
    expect(e.setPath(new Set(["l1"]))).toBe(true);
    expect(e.setPath(new Set(["l1"]))).toBe(false);
    expect(e.setPath(new Set(["l1", "l2"]))).toBe(true);
  });

  it("emphasizes the hovered link and everything on the path", () => {
    const e = createLinkEmphasis();
    expect(e.anyEmphasized()).toBe(false);
    e.setHover("l0");
    e.setPath(new Set(["l1"]));
    expect(e.emphasized("l0")).toBe(true);
    expect(e.emphasized("l1")).toBe(true);
    expect(e.emphasized("l2")).toBe(false);
    expect(e.anyEmphasized()).toBe(true);
  });

  it("keeps selection separate from emphasis", () => {
    const e = createLinkEmphasis();
    e.setSelected("l0");
    expect(e.isSelected("l0")).toBe(true);
    expect(e.emphasized("l0")).toBe(false);
    expect(e.anyEmphasized()).toBe(false);
    expect(e.selected()).toBe("l0");
    e.setSelected(null);
    expect(e.selected()).toBeNull();
  });
});
