// @vitest-environment happy-dom
// docs/specs/plugins/export.md §1.5 — the parse → validate → diff → (dryRun | dialog | apply)
// pipeline and the harvest-and-cancel batch's real-dispatch behavior, against a real
// `@stargantt/plugin-data-store`, plus the option-branching tests for `dryRun`/`filter`/`dialog`
// (§1's resolution notes).
import { afterEach, describe, expect, it } from "vitest";
import { applyChanges } from "../src/internal/formats/apply-plan";
import { guardFor } from "../src/internal/embed/guard";
import type { ExportWiring } from "../src/internal/wiring";
import { resolveMessages } from "../src/internal/messages";
import { resolveConfig } from "../src/config";
import type { Task } from "@stargantt/plugin-data-store";
import { boot, DAY, sampleData } from "./_boot";
import type { Booted } from "./_boot";

let booted: Booted | undefined;
afterEach(() => {
  booted?.dispose();
  booted = undefined;
});

describe("importJson: harvest-and-cancel single-transaction apply (§1.5)", () => {
  it("a multi-add import fires exactly one settled transaction", () => {
    booted = boot();
    const b = booted;
    const result = b.service.importJson(
      JSON.stringify([
        { id: "n1", name: "New 1", start: 0, end: DAY },
        { id: "n2", name: "New 2", start: 0, end: DAY },
        { id: "n3", parentId: "n1", name: "New 3", start: 0, end: DAY },
      ]),
    );
    expect(result.applied).toEqual({ added: 3, updated: 0, removed: 0 });
    expect(b.transactions).toHaveLength(1);
    // Four patches, not three: n1 gains a child in this transaction, so the store's summary
    // invariant appends its promotion to the same one.
    expect(b.transactions[0]?.patches.map((p) => p.op)).toEqual([
      "task/add",
      "task/add",
      "task/add",
      "task/update",
    ]);
    expect(b.transactions[0]?.origin).toBe("import");
    expect(b.data.getTask("n1")?.type).toBe("summary");
    expect(b.data.getTask("n3")?.parentId).toBe("n1");
    expect(b.applied).toEqual([{ result: { added: 3, updated: 0, removed: 0 }, cause: "api" }]);
  });

  it("a mixed add/update/remove import is still one transaction, adds-then-updates-then-removes", () => {
    const { tasks } = sampleData();
    booted = boot({ tasks });
    const b = booted;
    const result = b.service.importJson(
      JSON.stringify([
        { id: "a", parentId: null, name: "Design phase", start: 0, end: 10 * DAY, type: "summary" },
        { id: "a1", parentId: "a", name: "Wireframes v2", start: 0, end: 3 * DAY },
        { id: "a2", parentId: "a", name: 'Visual, "final" design', start: 3 * DAY, end: 8 * DAY },
        { id: "n1", parentId: null, name: "New root", start: 20 * DAY, end: 22 * DAY },
      ]),
      { removeMissing: true },
    );
    expect(result.applied).toEqual({ added: 1, updated: 1, removed: 1 });
    expect(b.transactions).toHaveLength(1);
    expect(b.transactions[0]?.patches.map((p) => p.op)).toEqual(["task/add", "task/update", "task/remove"]);
    expect(b.data.getTask("n1")).toBeDefined();
    expect(b.data.getTask("a1")?.name).toBe("Wireframes v2");
    expect(b.data.getTask("m1")).toBeUndefined();
  });

  it("a task/remove cascade (links, assignments) lands inside the same single transaction", () => {
    const { tasks, resources, assignments } = sampleData();
    booted = boot({ tasks, resources, assignments });
    const b = booted;
    b.dispatch("link/add", { sourceId: "a1", targetId: "a2", type: "FS" });
    b.transactions.length = 0; // the link/add above is not part of what this test measures
    // Every existing task except `a1`, verbatim (parentId included, so re-import proposes no
    // spurious re-parenting), plus one new root task — `removeMissing` then targets exactly `a1`.
    const kept = tasks
      .filter((t) => t.id !== "a1")
      .map((t) => ({ id: t.id, parentId: t.parentId, name: t.name, start: t.start, end: t.end }));
    const result = b.service.importJson(
      JSON.stringify([{ id: "n1", parentId: null, name: "New 1", start: 0, end: DAY }, ...kept]),
      { removeMissing: true },
    );
    expect(result.applied?.removed).toBe(1);
    expect(b.transactions).toHaveLength(1);
    const ops = b.transactions[0]?.patches.map((p) => p.op) ?? [];
    expect(ops).toContain("link/remove");
    expect(ops).toContain("assignment/remove");
    expect(b.data.getTask("a1")).toBeUndefined();
    expect(b.data.getTask("a2")).toBeDefined();
  });

  it("sibling adds in one batch get distinct, strictly increasing orderKeys, dispatched for real", () => {
    booted = boot();
    const b = booted;
    b.service.importJson(
      JSON.stringify([
        { id: "n1", name: "New 1", start: 0, end: DAY },
        { id: "n2", name: "New 2", start: 0, end: DAY },
        { id: "n3", name: "New 3", start: 0, end: DAY },
      ]),
    );
    const keys = ["n1", "n2", "n3"].map((id) => b.data.getTask(id)?.orderKey ?? "");
    expect(new Set(keys).size).toBe(3);
    expect([...keys].sort()).toEqual(keys);
    const rootIds = () => [...(b.data.query().children.get(null) ?? [])];
    const at = rootIds().indexOf("n1") + 1;
    b.dispatch("task/add", { task: { id: "mid", parentId: null, name: "Mid", start: 0, end: DAY }, index: at });
    const order = rootIds();
    expect(order.indexOf("mid")).toBeGreaterThan(order.indexOf("n1"));
    expect(order.indexOf("mid")).toBeLessThan(order.indexOf("n2"));
  });

  it("a foreign transaction raised inside the harvest window is neither canceled nor absorbed", () => {
    booted = boot();
    const b = booted;
    let injected = false;
    b.on("data/willApplyTransaction", (e) => {
      if (e.transaction.origin === "import" && !injected) {
        injected = true;
        b.dispatch("task/update", { id: "does-not-exist", after: { name: "noop" }, origin: "foreign" });
      }
    });
    // "does-not-exist" makes the foreign dispatch a no-op transaction-wise (nothing to assert on
    // the store), but it must not be swallowed into, or cancel, the import batch itself.
    const result = b.service.importJson(
      JSON.stringify([
        { id: "n1", name: "New 1", start: 0, end: DAY },
        { id: "n2", name: "New 2", start: 0, end: DAY },
      ]),
    );
    expect(result.applied).toEqual({ added: 2, updated: 0, removed: 0 });
    const importTx = b.transactions.filter((t) => t.origin === "import");
    expect(importTx).toHaveLength(1);
    expect(importTx[0]?.patches.map((p) => p.op)).toEqual(["task/add", "task/add"]);
  });

  it("id-less adds land under the ids the harvest minted (unit: applyChanges against the real store)", () => {
    booted = boot();
    const b = booted;
    const wiring: ExportWiring = {
      ctx: b.testHost.ctxOf("stargantt.export"),
      config: resolveConfig(undefined),
      messages: resolveMessages(undefined, () => {}),
      data: b.data,
      view: undefined as never,
      timeline: undefined as never,
      theme: undefined as never,
      reportError: () => {},
      disposed: () => false,
    };
    const guard = guardFor(wiring);
    const result = applyChanges(
      wiring,
      guard,
      [
        { kind: "add", task: { parentId: null, name: "Anon 1", start: 0, end: DAY } as unknown as Task },
        { kind: "add", task: { parentId: null, name: "Anon 2", start: 0, end: DAY } as unknown as Task },
      ],
      "api",
    );
    expect(result).toEqual({ added: 2, updated: 0, removed: 0 });
    expect(b.transactions).toHaveLength(1);
    const ids = (b.transactions[0]?.patches ?? [])
      .filter((p) => p.op === "task/add")
      .map((p) => (p.op === "task/add" ? p.task.id : undefined));
    expect(ids).toHaveLength(2);
    expect(ids[0]).not.toBeUndefined();
    expect(ids[1]).not.toBeUndefined();
    expect(b.data.getTask(ids[0] as never)?.name).toBe("Anon 1");
    expect(b.data.getTask(ids[1] as never)?.name).toBe("Anon 2");
  });

  it("apply([]) / an all-no-op change list opens no transaction and counts nothing", () => {
    booted = boot();
    const b = booted;
    const result = b.service.importJson(JSON.stringify([]));
    expect(result.applied).toEqual({ added: 0, updated: 0, removed: 0 });
    expect(b.transactions).toHaveLength(0);
    expect(b.applied).toHaveLength(0);
  });
});

describe("importCsv / importJson: option branching (§1, resolution notes)", () => {
  it("dryRun stops before apply: changes computed, `applied` absent, nothing dispatched", () => {
    booted = boot();
    const b = booted;
    const result = b.service.importJson(JSON.stringify([{ id: "n1", name: "N1", start: 0, end: DAY }]), {
      dryRun: true,
    });
    expect(result.applied).toBeUndefined();
    expect(result.changes).toEqual([{ kind: "add", task: { id: "n1", parentId: null, name: "N1", start: 0, end: DAY } }]);
    expect(b.transactions).toHaveLength(0);
  });

  it("filter keeps only the changes it accepts, applies just those, and reports post-filter changes", () => {
    booted = boot();
    const b = booted;
    const result = b.service.importJson(
      JSON.stringify([
        { id: "keep", name: "Keep", start: 0, end: DAY },
        { id: "drop", name: "Drop", start: 0, end: DAY },
      ]),
      { filter: (c) => c.kind === "add" && c.task.id === "keep" },
    );
    expect(result.applied).toEqual({ added: 1, updated: 0, removed: 0 });
    expect(result.changes.map((c) => (c.kind === "add" ? c.task.id : ""))).toEqual(["keep"]);
    expect(b.data.getTask("keep")).toBeDefined();
    expect(b.data.getTask("drop")).toBeUndefined();
  });

  it("a throwing filter excludes that change (fail-safe) and is reported via core/pluginError", () => {
    booted = boot();
    const b = booted;
    const result = b.service.importJson(
      JSON.stringify([
        { id: "boom", name: "Boom", start: 0, end: DAY },
        { id: "fine", name: "Fine", start: 0, end: DAY },
      ]),
      {
        filter: (c) => {
          if (c.kind === "add" && c.task.id === "boom") throw new Error("nope");
          return true;
        },
      },
    );
    expect(result.applied).toEqual({ added: 1, updated: 0, removed: 0 });
    expect(b.data.getTask("boom")).toBeUndefined();
    expect(b.data.getTask("fine")).toBeDefined();
    expect(b.errors.map((e) => e.pluginId)).toContain("stargantt.export");
  });

  it("dialog:true opens the dialog instead of applying; `applied` is absent from the result", () => {
    booted = boot();
    const b = booted;
    const result = b.service.importCsv("name,start,end\nBrand new,1970-01-01,1970-01-03\n", { dialog: true });
    expect(result.applied).toBeUndefined();
    expect(b.chartPane.querySelector(".sg-ie-dialog")).not.toBeNull();
    expect(b.data.getTask("import-1")).toBeUndefined();
  });

  it("dialog: true overrides dryRun", () => {
    booted = boot();
    const b = booted;
    b.service.importCsv("name,start,end\nX,1970-01-01,1970-01-03\n", { dialog: true, dryRun: true });
    expect(b.chartPane.querySelector(".sg-ie-dialog")).not.toBeNull();
  });
});

describe("read-only interplay (§2.1, §1.5)", () => {
  it("importJson applies nothing, reports all-zero counts, and emits no applied event while read-only", () => {
    booted = boot({ config: { viewerEmbed: { readOnly: true } } });
    const b = booted;
    const result = b.service.importJson(JSON.stringify([{ id: "n1", name: "N1", start: 0, end: DAY }]));
    expect(result.applied).toEqual({ added: 0, updated: 0, removed: 0 });
    expect(b.transactions).toHaveLength(0);
    expect(b.applied).toHaveLength(0);
    expect(b.data.getTask("n1")).toBeUndefined();
  });
});

