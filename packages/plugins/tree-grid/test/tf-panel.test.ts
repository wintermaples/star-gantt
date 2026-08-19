import { describe, expect, it } from "vitest";
import type { Task, TaskId } from "@stargantt/plugin-data-store";
import { installDom } from "./_harness/index";
import type { FakeElement, FakeInput } from "./_harness/index";
import { makePanelContribution } from "../src/internal/task-fields/panel";
import { DEFAULT_MESSAGES } from "../src/internal/messages";
import type { TaskFieldsPatch } from "../src/types";

const MS_DAY = 86_400_000;

function mountPanel() {
  const dom = installDom();
  const host = dom.document.createElement("div");
  const commits: { id: TaskId; patch: TaskFieldsPatch }[] = [];
  const contribution = makePanelContribution({
    messages: { ...DEFAULT_MESSAGES },
    commit: (id, patch) => void commits.push({ id, patch }),
    listen: (target, type, fn) =>
      (target as unknown as FakeElement).addEventListener(type, fn as () => void),
  });
  const handle = contribution.mount(host as unknown as HTMLElement);
  if (handle === undefined || handle === null) throw new Error("expected a handle");
  // Children: heading, one labelled row per control — except actualStart/actualEnd (the side
  // panel's field section), which share one `.sg-taskfields-row-grid` wrapper as its two children
  // instead of two direct rows.
  const row = (index: number): FakeElement => {
    const r =
      index < 4
        ? host.children[index + 1]
        : index < 6
          ? host.children[5]?.children[index - 4]
          : host.children[6];
    if (r === undefined) throw new Error(`missing row ${index}`);
    return r;
  };
  const control = (index: number): FakeInput => {
    const c = row(index)?.children[1];
    if (c === undefined) throw new Error(`missing control ${index}`);
    return c as FakeInput;
  };
  return { host, handle, commits, control, row };
}

function task(id: string, fields?: Record<string, unknown>): Task {
  const t: Task = { id, parentId: null, name: id, start: 0, end: MS_DAY };
  if (fields !== undefined) t.meta = { taskFields: fields };
  return t;
}

// Control order inside the section: status, priority, tags, deadline, actualStart, actualEnd,
// notes.
const STATUS = 0;
const TAGS = 2;
const DEADLINE = 3;
const NOTES = 6;

describe("side-panel section", () => {
  it("mounts a heading and seven labelled controls with catalog text", () => {
    const p = mountPanel();
    expect(p.host.children[0]?.textContent).toBe("Task fields");
    // heading + statusRow + priorityRow + tagsRow + deadlineRow + actualDatesGrid + notesRow.
    expect(p.host.children).toHaveLength(7);
    expect(p.host.children[1]?.children[0]?.textContent).toBe("Status");
    // The actual-start/actual-end rows share one 2-column grid wrapper.
    expect(p.host.children[5]?.className).toBe("sg-taskfields-row-grid");
    expect(p.host.children[5]?.children).toHaveLength(2);
  });

  it("associates every control with its label via for/id", () => {
    const p = mountPanel();
    for (let i = 0; i < 7; i++) {
      const label = p.row(i)?.children[0];
      const control = p.control(i);
      const forId = label?.getAttribute("for");
      expect(forId).toBeTruthy();
      expect(control.getAttribute("id")).toBe(forId);
    }
    // Ids stay unique across panel instances (per-mount prefix).
    const q = mountPanel();
    expect(q.control(0).getAttribute("id")).not.toBe(p.control(0).getAttribute("id"));
  });

  it("update() fills controls from the first selected task and disables when empty", () => {
    const p = mountPanel();
    p.handle.update([
      task("a", { status: "in-progress", tags: ["x", "y"], deadline: MS_DAY, notes: "n" }),
      task("b", { status: "done" }),
    ]);
    expect(p.control(STATUS).value).toBe("in-progress");
    expect(p.control(TAGS).value).toBe("x, y");
    expect(p.control(DEADLINE).value).toBe("1970-01-02");
    expect(p.control(NOTES).value).toBe("n");
    expect(p.control(STATUS).getAttribute("disabled")).toBeNull();

    p.handle.update([]);
    expect(p.control(STATUS).getAttribute("disabled")).not.toBeNull();
    expect(p.control(STATUS).value).toBe("");
  });

  it("commits one field patch per change, to the first selected task", () => {
    const p = mountPanel();
    p.handle.update([task("a")]);

    p.control(STATUS).value = "done";
    p.control(STATUS).fire("change");
    expect(p.commits).toEqual([{ id: "a", patch: { status: "done" } }]);

    p.control(TAGS).value = "a, b, a";
    p.control(TAGS).fire("change");
    expect(p.commits[1]).toEqual({ id: "a", patch: { tags: ["a", "b"] } });

    p.control(DEADLINE).value = "1970-01-05";
    p.control(DEADLINE).fire("change");
    expect(p.commits[2]).toEqual({ id: "a", patch: { deadline: 4 * MS_DAY } });

    p.control(DEADLINE).value = "bogus"; // unparsable — ignored
    p.control(DEADLINE).fire("change");
    expect(p.commits).toHaveLength(3);

    // A calendar-invalid date is rejected, never rolled over.
    p.control(DEADLINE).value = "2024-02-30";
    p.control(DEADLINE).fire("change");
    expect(p.commits).toHaveLength(3);

    p.control(NOTES).value = ""; // empty clears
    p.control(NOTES).fire("change");
    expect(p.commits[3]).toEqual({ id: "a", patch: { notes: undefined } });
  });

  it("ignores changes while nothing is selected", () => {
    const p = mountPanel();
    p.handle.update([]);
    p.control(STATUS).value = "done";
    p.control(STATUS).fire("change");
    expect(p.commits).toEqual([]);
  });
});
