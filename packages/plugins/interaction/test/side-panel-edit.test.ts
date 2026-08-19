// @vitest-environment happy-dom
/**
 * `internal/side-panel/edit.ts` — the field-level accept/reject decision, the rejected-edit
 * marking, and the edit controller that turns a field's `change` into a command dispatch
 * (docs/specs/plugins/interaction.md §6.10, the `panel*` renamed message keys of §8).
 *
 * Exercised against this package's shared `InteractionMessages` catalog.
 */
import { describe, expect, it } from "vitest";
import type { Task } from "@stargantt/plugin-data-store";
import { DEFAULT_MESSAGES } from "../src/messages";
import { buildField } from "../src/internal/side-panel/fields";
import type { Field } from "../src/internal/side-panel/fields";
import {
  createEditController,
  createInvalidMarks,
  decideEditWithReason,
  setInvalid,
  clearInvalid,
} from "../src/internal/side-panel/edit";

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 0, 5);

function task(over: Partial<Task> = {}): Task {
  return { id: "t1", parentId: null, name: "Design", start: T0, end: T0 + 5 * DAY, progress: 0.4, ...over };
}

/* ------------------------------------------------------------------ *
 * `decideEditWithReason`
 * ------------------------------------------------------------------ */

describe("decideEditWithReason", () => {
  it("name: unchanged when equal, update otherwise", () => {
    expect(decideEditWithReason("name", task(), "Design")).toEqual({ kind: "unchanged" });
    expect(decideEditWithReason("name", task(), "Build")).toEqual({ kind: "update", name: "Build" });
  });

  it("start: rejects an unparsable date or one that would invert the range", () => {
    expect(decideEditWithReason("start", task(), "nope")).toEqual({ kind: "reject", reason: "invalidDate" });
    expect(decideEditWithReason("start", task(), "2026-01-11")).toEqual({ kind: "reject", reason: "dateOrder" });
    expect(decideEditWithReason("start", task(), "2026-01-05")).toEqual({ kind: "unchanged" });
    expect(decideEditWithReason("start", task(), "2026-01-06")).toEqual({
      kind: "move",
      start: Date.UTC(2026, 0, 6),
      end: task().end,
    });
  });

  it("end: rejects an unparsable date or one at/before start", () => {
    expect(decideEditWithReason("end", task(), "bad")).toEqual({ kind: "reject", reason: "invalidDate" });
    expect(decideEditWithReason("end", task(), "2026-01-05")).toEqual({ kind: "reject", reason: "dateOrder" });
    expect(decideEditWithReason("end", task(), "2026-01-12")).toEqual({
      kind: "move",
      start: task().start,
      end: Date.UTC(2026, 0, 12),
    });
  });

  it("progress: rejects out-of-range or non-numeric, unchanged when equal, otherwise progress", () => {
    expect(decideEditWithReason("progress", task(), "1.5")).toEqual({ kind: "reject", reason: "progressRange" });
    expect(decideEditWithReason("progress", task(), "")).toEqual({ kind: "reject", reason: "progressRange" });
    expect(decideEditWithReason("progress", task(), "0.4")).toEqual({ kind: "unchanged" });
    expect(decideEditWithReason("progress", task(), "0.9")).toEqual({ kind: "progress", progress: 0.9 });
  });

  it("rejects a calendar-invalid date (strict ISO parsing)", () => {
    expect(decideEditWithReason("start", task(), "2024-02-30")).toEqual({
      kind: "reject",
      reason: "invalidDate",
    });
  });
});

/* ------------------------------------------------------------------ *
 * `setInvalid` / `clearInvalid` / `createInvalidMarks`
 * ------------------------------------------------------------------ */

function field(): Field {
  return buildField(document, { label: "Start", type: "date", inputId: "sg-side-panel-t-start" });
}

describe("setInvalid / clearInvalid", () => {
  it("marks aria-invalid and the modifier class, with the cause text attached and referenced", () => {
    const f = field();
    setInvalid(f, "bad date");
    expect(f.input.getAttribute("aria-invalid")).toBe("true");
    expect(f.input.classList.contains("sg-side-panel-input--invalid")).toBe(true);
    expect(f.error?.textContent).toBe("bad date");
    expect(f.input.getAttribute("aria-errormessage")).toBe(f.error?.getAttribute("id"));
    expect(f.error?.parentNode).toBe(f.wrap);
  });

  it("marks without a cause text too (no error element attached)", () => {
    const f = field();
    setInvalid(f);
    expect(f.input.getAttribute("aria-invalid")).toBe("true");
    expect(f.error?.parentNode).toBeNull();
  });

  it("clearInvalid detaches the error element and drops the attributes", () => {
    const f = field();
    setInvalid(f, "bad date");
    clearInvalid(f);
    expect(f.input.getAttribute("aria-invalid")).toBeNull();
    expect(f.input.getAttribute("aria-errormessage")).toBeNull();
    expect(f.input.classList.contains("sg-side-panel-input--invalid")).toBe(false);
    expect(f.error?.parentNode).toBeNull();
    expect(f.error?.textContent).toBe("");
  });
});

describe("createInvalidMarks", () => {
  it("mark() disarms a pending clear, so a same-frame store refresh does not wipe it", () => {
    const f = field();
    const marks = createInvalidMarks([f]);
    marks.arm();
    marks.mark(f, "bad");
    expect(marks.armed).toBe(false);
    marks.applyPending();
    // Not cleared: the clear was disarmed by mark().
    expect(f.input.getAttribute("aria-invalid")).toBe("true");
    expect(marks.causeOf(f)).toBe("bad");
  });

  it("applyPending clears every field only when a clear is armed", () => {
    const f = field();
    const marks = createInvalidMarks([f]);
    marks.mark(f, "bad");
    marks.applyPending(); // not armed yet — no-op
    expect(f.input.getAttribute("aria-invalid")).toBe("true");

    marks.arm();
    marks.applyPending();
    expect(f.input.getAttribute("aria-invalid")).toBeNull();
    expect(marks.causeOf(f)).toBeUndefined();
  });
});

/* ------------------------------------------------------------------ *
 * `createEditController`
 * ------------------------------------------------------------------ */

interface Rig {
  dispatched: { kind: string; args: unknown[] }[];
  announced: string[];
  scheduled: number;
  marks: ReturnType<typeof createInvalidMarks>;
  fields: { name: Field; start: Field; end: Field; progress: Field };
  current: Task | undefined;
  controller: ReturnType<typeof createEditController>;
}

function rig(): Rig {
  const fields = {
    name: buildField(document, { label: "Name", type: "text", inputId: "n" }),
    start: buildField(document, { label: "Start", type: "date", inputId: "s" }),
    end: buildField(document, { label: "End", type: "date", inputId: "e" }),
    progress: buildField(document, { label: "Progress", type: "number", inputId: "p" }),
  };
  const marks = createInvalidMarks(Object.values(fields));
  const dispatched: { kind: string; args: unknown[] }[] = [];
  const announced: string[] = [];
  let scheduled = 0;
  let current: Task | undefined = task();
  const controller = createEditController({
    messages: DEFAULT_MESSAGES,
    fields,
    marks,
    currentTask: () => current,
    commands: {
      update: (id, name) => dispatched.push({ kind: "update", args: [id, name] }),
      move: (id, start, end) => dispatched.push({ kind: "move", args: [id, start, end] }),
      setProgress: (id, progress) => dispatched.push({ kind: "setProgress", args: [id, progress] }),
    },
    announcer: () => ({ announce: (m: string) => announced.push(m) }),
    schedule: () => {
      scheduled += 1;
    },
  });
  return {
    get dispatched() {
      return dispatched;
    },
    get announced() {
      return announced;
    },
    get scheduled() {
      return scheduled;
    },
    marks,
    fields,
    get current() {
      return current;
    },
    set current(v: Task | undefined) {
      current = v;
    },
    controller,
  };
}

describe("createEditController", () => {
  it("does nothing without a current task", () => {
    const r = rig();
    r.current = undefined;
    r.controller.change("name", "Build");
    expect(r.dispatched).toEqual([]);
  });

  it("dispatches update/move/setProgress for accepted values", () => {
    const r = rig();
    r.controller.change("name", "Build");
    r.controller.change("start", "2026-01-06");
    r.controller.change("progress", "0.9");
    expect(r.dispatched).toEqual([
      { kind: "update", args: ["t1", "Build"] },
      { kind: "move", args: ["t1", Date.UTC(2026, 0, 6), task().end] },
      { kind: "setProgress", args: ["t1", 0.9] },
    ]);
  });

  it("an unchanged value dispatches nothing and marks nothing", () => {
    const r = rig();
    r.controller.change("name", "Design");
    expect(r.dispatched).toEqual([]);
    expect(r.fields.name.input.getAttribute("aria-invalid")).toBeNull();
  });

  it("a rejected value marks the field, announces once with the panel*-label, and schedules a refresh", () => {
    const r = rig();
    r.controller.change("end", "2026-01-01");
    expect(r.dispatched).toEqual([]);
    expect(r.fields.end.input.getAttribute("aria-invalid")).toBe("true");
    expect(r.announced).toEqual(["End: invalid value, edit not applied"]);
    expect(r.scheduled).toBe(1);
  });

  it("reads from the built-in input when `raw` is omitted", () => {
    const r = rig();
    r.fields.name.input.value = "From input";
    r.controller.change("name");
    expect(r.dispatched).toEqual([{ kind: "update", args: ["t1", "From input"] }]);
  });

  it("without an announcer the rejection still marks, silently", () => {
    const fields = {
      name: buildField(document, { label: "Name", type: "text", inputId: "n2" }),
      start: buildField(document, { label: "Start", type: "date", inputId: "s2" }),
      end: buildField(document, { label: "End", type: "date", inputId: "e2" }),
      progress: buildField(document, { label: "Progress", type: "number", inputId: "p2" }),
    };
    const marks = createInvalidMarks(Object.values(fields));
    const controller = createEditController({
      messages: DEFAULT_MESSAGES,
      fields,
      marks,
      currentTask: () => task(),
      commands: { update: () => {}, move: () => {}, setProgress: () => {} },
      announcer: () => undefined,
      schedule: () => {},
    });
    controller.change("progress", "9");
    expect(fields.progress.input.getAttribute("aria-invalid")).toBe("true");
  });
});
