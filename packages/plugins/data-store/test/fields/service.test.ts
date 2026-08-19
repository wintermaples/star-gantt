/**
 * docs/specs/plugins/data-store.md — Services (`stargantt.fields`).
 *
 * "One undo step" is verified at its actual source of truth: `setValue`/`setValues`
 * dispatch through the ordinary `task/update` transaction pipeline, so "one undo step" reduces to
 * "one `data/willApplyTransaction` firing, whose patches invert back to the prior state" — the
 * exact invariant the sibling `undo-redo` plugin relies on.
 */
import { describe, expect, it } from "vitest";
import type { Transaction } from "../../src/index";
import { invertPatches } from "../../src/patch";
import { boot, countTransactions, task } from "./_boot";

const MS_DAY = 86_400_000;

const FIELDS = [
  { key: "team", type: "text" },
  { key: "cost", type: "number" },
  { key: "review", type: "date" },
  { key: "risk", type: "select", options: ["Low", "High"] },
  { key: "total", type: "formula", formula: "cost * duration" },
] as const;

describe("FieldsService", () => {
  it("reports the resolved definitions in order", () => {
    const { service } = boot([...FIELDS]);
    expect(service.definitions().map((d) => d.key)).toEqual([
      "team",
      "cost",
      "review",
      "risk",
      "total",
    ]);
  });

  it("reads stored values defensively and writes them via one transaction each", () => {
    const { service, data, gantt } = boot([...FIELDS], [task("a")]);
    const transactions = countTransactions(gantt);
    expect(service.valueOf("a", "team")).toBeUndefined();

    service.setValue("a", "team", "core");
    service.setValue("a", "cost", 120);
    expect(service.valueOf("a", "team")).toBe("core");
    expect(service.valueOf("a", "cost")).toBe(120);
    expect(data.getTask("a")?.meta).toEqual({ customFields: { team: "core", cost: 120 } });
    expect(transactions.count()).toBe(2);

    // Unusable writes are silent no-ops — no transaction, no store publish.
    const before = transactions.count();
    service.setValue("a", "cost", "not a number");
    service.setValue("a", "risk", "Medium"); // not an option
    service.setValue("a", "total", 5); // formula fields are read-only
    service.setValue("a", "nope", 1); // unknown key
    service.setValue("zzz", "team", "x"); // unknown task
    expect(transactions.count()).toBe(before);
    expect(service.valueOf("a", "cost")).toBe(120);
    expect(service.valueOf("a", "risk")).toBeUndefined();
  });

  it("removes values with undefined, clearing an emptied meta bag", () => {
    const { service, data } = boot([...FIELDS], [task("a")]);
    service.setValue("a", "team", "core");
    service.setValue("a", "team", undefined);
    expect(data.getTask("a")?.meta).toBeUndefined();
  });

  it("preserves sibling meta keys and unknown field keys on write", () => {
    const { service, data } = boot(
      [...FIELDS],
      [task("a", { meta: { other: 1, customFields: { legacy: "kept" } } })],
    );
    service.setValue("a", "team", "core");
    expect(data.getTask("a")?.meta).toEqual({
      other: 1,
      customFields: { legacy: "kept", team: "core" },
    });
  });

  it("each setValue is exactly one transaction, invertible back to the prior state", () => {
    const { service, data, gantt } = boot([...FIELDS], [task("a")]);
    const applied: Transaction[] = [];
    gantt.on("data/willApplyTransaction", (e) => applied.push(e.transaction));

    service.setValue("a", "team", "core");
    service.setValue("a", "cost", 3);
    expect(applied).toHaveLength(2);
    expect(applied[0]?.patches).toHaveLength(1);
    expect(applied[1]?.patches).toHaveLength(1);

    // Undoing the second write (cost) restores the state after the first.
    gantt.dispatch("history/apply", { patches: invertPatches(applied[1]!.patches) });
    expect(service.valueOf("a", "cost")).toBeUndefined();
    expect(service.valueOf("a", "team")).toBe("core");

    // Undoing the first write (team) restores the fully empty state.
    gantt.dispatch("history/apply", { patches: invertPatches(applied[0]!.patches) });
    expect(service.valueOf("a", "team")).toBeUndefined();
    expect(data.getTask("a")?.meta).toBeUndefined();
  });

  it("computes formula values from stored fields and built-ins", () => {
    const { service } = boot([...FIELDS], [task("a", { end: 2 * MS_DAY })]); // duration = 2 days
    expect(service.valueOf("a", "total")).toBeUndefined(); // cost missing → soft failure
    service.setValue("a", "cost", 50);
    expect(service.valueOf("a", "total")).toBe(100);
    expect(service.displayValue("a", "total")).toBe("100");
  });

  it("lets formulas reference formulas, failing softly on cycles", () => {
    const { service } = boot(
      [
        { key: "cost", type: "number" },
        { key: "double", type: "formula", formula: "cost * 2" },
        { key: "quad", type: "formula", formula: "double * 2" },
        { key: "loopA", type: "formula", formula: "loopB + 1" },
        { key: "loopB", type: "formula", formula: "loopA + 1" },
      ],
      [task("a")],
    );
    service.setValue("a", "cost", 5);
    expect(service.valueOf("a", "quad")).toBe(20);
    expect(service.valueOf("a", "loopA")).toBeUndefined();
    expect(service.valueOf("a", "loopB")).toBeUndefined();
  });

  it("formats display values per type", () => {
    const { service } = boot([...FIELDS], [task("a")]);
    service.setValue("a", "cost", 1.256);
    service.setValue("a", "review", Date.UTC(2026, 0, 31));
    expect(service.displayValue("a", "cost")).toBe("1.26");
    expect(service.displayValue("a", "review")).toBe("2026-01-31");
    expect(service.displayValue("a", "team")).toBe("");
    expect(service.displayValue("a", "nope")).toBe("");
  });
});

describe("FieldsService.setValues", () => {
  // The decisive test: seeding N values through setValues must cost exactly one transaction
  // (one prospective undo entry), and inverting that one transaction's patches must revert every
  // one of them — this is the bug `setValues` exists to fix (`setValue` seeding 180 tasks x 2
  // fields pushed 360 entries onto the undo stack).
  it("writes many values as one transaction, reverted by inverting it in one step", () => {
    const tasks = Array.from({ length: 20 }, (_, i) => task(`t${i}`));
    const { service, data, gantt } = boot([...FIELDS], tasks);
    const applied: Transaction[] = [];
    gantt.on("data/willApplyTransaction", (e) => applied.push(e.transaction));

    const entries = tasks.flatMap((t) => [
      { id: t.id, key: "team", value: "core" },
      { id: t.id, key: "cost", value: 7 },
    ]);
    service.setValues(entries);

    for (const t of tasks) {
      expect(service.valueOf(t.id, "team")).toBe("core");
      expect(service.valueOf(t.id, "cost")).toBe(7);
    }
    expect(applied).toHaveLength(1);
    expect(applied[0]?.patches).toHaveLength(20);

    gantt.dispatch("history/apply", { patches: invertPatches(applied[0]!.patches) });
    for (const t of tasks) {
      expect(data.getTask(t.id)?.meta).toBeUndefined();
    }
  });

  // A `setValues` call whose transaction is cancelled by another handler's `preventDefault()`
  // must not leave `pendingSetValuesPatches` set: a stale pending list would silently glue onto
  // a later, unrelated transaction that happens to carry the same origin.
  it("clears the pending batch when the transaction is cancelled", () => {
    const { service, data, gantt } = boot([...FIELDS], [task("a"), task("b")]);
    gantt.on("data/willApplyTransaction", (e) => {
      const first = e.transaction.patches[0];
      if (first?.op === "task/update" && first.id === "a") e.preventDefault();
    });
    service.setValues([
      { id: "a", key: "team", value: "core" },
      { id: "b", key: "team", value: "eng" },
    ]);
    // Cancelled: neither task's value was written.
    expect(service.valueOf("a", "team")).toBeUndefined();
    expect(service.valueOf("b", "team")).toBeUndefined();
    expect(data.getTask("a")?.meta).toBeUndefined();
    expect(data.getTask("b")?.meta).toBeUndefined();

    // A later, independent setValue for "b" must not pick up the stale pending batch's patch
    // for "a" — proof that `pendingSetValuesPatches` was cleared, not left dangling.
    service.setValue("b", "team", "solo");
    expect(service.valueOf("b", "team")).toBe("solo");
    expect(data.getTask("a")?.meta).toBeUndefined();
  });

  it("merges two entries for the same task into one patch, later entry winning per field", () => {
    const { service, data } = boot([...FIELDS], [task("a")]);
    service.setValues([
      { id: "a", key: "team", value: "core" },
      { id: "a", key: "team", value: "eng" }, // overwrites the entry above
      { id: "a", key: "cost", value: 5 },
    ]);
    expect(data.getTask("a")?.meta).toEqual({ customFields: { team: "eng", cost: 5 } });
  });

  it("merges entries across two tasks into two patches inside one transaction", () => {
    const { service, data, gantt } = boot([...FIELDS], [task("a"), task("b")]);
    const applied: Transaction[] = [];
    gantt.on("data/willApplyTransaction", (e) => applied.push(e.transaction));
    service.setValues([
      { id: "a", key: "team", value: "core" },
      { id: "b", key: "team", value: "ops" },
    ]);
    expect(data.getTask("a")?.meta).toEqual({ customFields: { team: "core" } });
    expect(data.getTask("b")?.meta).toEqual({ customFields: { team: "ops" } });
    expect(applied).toHaveLength(1);
    expect(applied[0]?.patches).toHaveLength(2);

    gantt.dispatch("history/apply", { patches: invertPatches(applied[0]!.patches) });
    expect(data.getTask("a")?.meta).toBeUndefined();
    expect(data.getTask("b")?.meta).toBeUndefined();
  });

  it("skips an entry naming an unknown task, writing the rest", () => {
    const { service, data } = boot([...FIELDS], [task("a")]);
    service.setValues([
      { id: "zzz", key: "team", value: "core" },
      { id: "a", key: "team", value: "eng" },
    ]);
    expect(data.getTask("a")?.meta).toEqual({ customFields: { team: "eng" } });
  });

  it("skips an entry naming an unknown field, writing the rest", () => {
    const { service, data } = boot([...FIELDS], [task("a")]);
    service.setValues([
      { id: "a", key: "nope", value: "x" },
      { id: "a", key: "team", value: "eng" },
    ]);
    expect(data.getTask("a")?.meta).toEqual({ customFields: { team: "eng" } });
  });

  it("skips an entry naming a formula field, writing the rest", () => {
    const { service, data } = boot([...FIELDS], [task("a")]);
    service.setValues([
      { id: "a", key: "total", value: 99 },
      { id: "a", key: "team", value: "eng" },
    ]);
    expect(data.getTask("a")?.meta).toEqual({ customFields: { team: "eng" } });
    expect(service.valueOf("a", "total")).toBeUndefined();
  });

  it("skips an entry with a value unusable for the field's type, writing the rest", () => {
    const { service, data } = boot([...FIELDS], [task("a")]);
    service.setValues([
      { id: "a", key: "cost", value: "not a number" as unknown as number },
      { id: "a", key: "risk", value: "Medium" }, // not one of the declared options
      { id: "a", key: "team", value: "eng" },
    ]);
    expect(data.getTask("a")?.meta).toEqual({ customFields: { team: "eng" } });
  });

  it("writes nothing and produces no transaction for an empty list", () => {
    const { service, data, gantt } = boot([...FIELDS], [task("a")]);
    const transactions = countTransactions(gantt);
    service.setValues([]);
    expect(data.getTask("a")?.meta).toBeUndefined();
    expect(transactions.count()).toBe(0);
  });

  it("writes nothing and produces no transaction when every entry is skipped", () => {
    const { service, data, gantt } = boot([...FIELDS], [task("a")]);
    const transactions = countTransactions(gantt);
    service.setValues([
      { id: "zzz", key: "team", value: "core" }, // unknown task
      { id: "a", key: "nope", value: "x" }, // unknown field
      { id: "a", key: "total", value: 1 }, // formula field
      { id: "a", key: "cost", value: "not a number" as unknown as number }, // unusable value
    ]);
    expect(data.getTask("a")?.meta).toBeUndefined();
    expect(transactions.count()).toBe(0);
  });

  it("clears an emptied meta bag inside a batch, and inverting the transaction restores it", () => {
    const { service, data, gantt } = boot([...FIELDS], [task("a"), task("b")]);
    service.setValue("a", "team", "core"); // separate step, outside the batch under test

    const applied: Transaction[] = [];
    gantt.on("data/willApplyTransaction", (e) => applied.push(e.transaction));
    service.setValues([
      { id: "a", key: "team", value: undefined }, // empties task a's meta entirely
      { id: "b", key: "team", value: "ops" },
    ]);
    expect(data.getTask("a")?.meta).toBeUndefined();
    expect(data.getTask("b")?.meta).toEqual({ customFields: { team: "ops" } });

    expect(applied).toHaveLength(1);
    gantt.dispatch("history/apply", { patches: invertPatches(applied[0]!.patches) });
    expect(data.getTask("a")?.meta).toEqual({ customFields: { team: "core" } });
    expect(data.getTask("b")?.meta).toBeUndefined();
  });

  it("preserves sibling meta keys and unknown field keys when merging a batch write", () => {
    const { service, data } = boot(
      [...FIELDS],
      [task("a", { meta: { other: 1, customFields: { legacy: "kept" } } })],
    );
    service.setValues([
      { id: "a", key: "team", value: "core" },
      { id: "a", key: "cost", value: 3 },
    ]);
    expect(data.getTask("a")?.meta).toEqual({
      other: 1,
      customFields: { legacy: "kept", team: "core", cost: 3 },
    });
  });
});
