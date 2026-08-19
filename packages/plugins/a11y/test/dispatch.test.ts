// docs/specs/plugins/a11y.md § Extension points — "Dispatch rules".
/**
 * `internal/dispatch.ts` on its own: the input guards, the pointer-claim scope, and the "last
 * matching binding whose `when` allows it wins" rule — all without booting a chart
 * (`references/code-quality.md` §1).
 */
import { describe, expect, it } from "vitest";
import { createKeyScope, isInGridHeader, isTextEntry, runStroke } from "../src/internal/dispatch";
import type { ScopeRoot } from "../src/internal/dispatch";
import { chordCache } from "../src/internal/keys";
import type { KeyStroke } from "../src/internal/keys";
import type { KeyBinding } from "../src/types";

/** A minimal element for the guard walks: a tag, attributes and a parent. */
function node(tagName: string, attrs: Record<string, string> = {}, parent: unknown = null): unknown {
  return {
    tagName,
    className: attrs["class"] ?? "",
    parentNode: parent,
    getAttribute: (name: string): string | null => attrs[name] ?? null,
  };
}

function stroke(key: string, mods: Partial<KeyStroke> = {}): KeyStroke {
  return {
    key,
    ctrlKey: mods.ctrlKey ?? false,
    altKey: mods.altKey ?? false,
    shiftKey: mods.shiftKey ?? false,
    metaKey: mods.metaKey ?? false,
  };
}

interface Run {
  claims: number;
  faults: unknown[];
  ran: string[];
  claimed: boolean;
}

function route(bindings: KeyBinding[], s: KeyStroke): Run {
  const out: Run = { claims: 0, faults: [], ran: [], claimed: false };
  const chordOf = chordCache();
  out.claimed = runStroke(s, {
    bindings: () => bindings,
    chordOf,
    fault: (error) => out.faults.push(error),
    onClaim: () => {
      out.claims += 1;
    },
  });
  return out;
}

/** A binding that records that it ran. */
function record(ran: string[], key: string, name: string, when?: () => boolean): KeyBinding {
  const binding: KeyBinding = { key, run: () => ran.push(name) };
  if (when !== undefined) binding.when = when;
  return binding;
}

describe("the text-entry guard", () => {
  it("claims keystrokes on an input or a textarea", () => {
    expect(isTextEntry(node("INPUT"))).toBe(true);
    expect(isTextEntry(node("textarea"))).toBe(true);
    expect(isTextEntry(node("div"))).toBe(false);
    expect(isTextEntry(null)).toBe(false);
  });

  it("claims a descendant of a contenteditable region, but not of contenteditable='false'", () => {
    const editable = node("div", { contenteditable: "true" });
    expect(isTextEntry(node("span", {}, editable))).toBe(true);
    const off = node("div", { contenteditable: "false" });
    expect(isTextEntry(node("span", {}, off))).toBe(false);
  });
});

describe("the grid-header guard", () => {
  it("claims a columnheader cell and anything inside the header container", () => {
    expect(isInGridHeader(node("div", { role: "columnheader" }))).toBe(true);
    const header = node("div", { class: "sg-grid-header" });
    expect(isInGridHeader(node("span", {}, header))).toBe(true);
    expect(isInGridHeader(node("div", { class: "sg-grid-row" }))).toBe(false);
  });
});

describe("the pointer claim", () => {
  const inside = { tag: "inside" };
  const outside = { tag: "outside" };
  const body = { tag: "body" };
  const root: ScopeRoot = {
    contains: (target: unknown) => target === inside,
    ownerDocument: { body, documentElement: { tag: "html" } },
  };

  it("dispatches to the chart's own target with or without a claim", () => {
    const scope = createKeyScope(root);
    expect(scope.inScope(inside)).toBe(true);
    expect(scope.inScope(body)).toBe(false);
  });

  it("dispatches a keystroke at body focus only while the claim is held", () => {
    const scope = createKeyScope(root);
    scope.notePointerDown(inside);
    expect(scope.inScope(body)).toBe(true);
    // A press elsewhere on the page, or the focus leaving the chart, releases it.
    scope.notePointerDown(outside);
    expect(scope.inScope(body)).toBe(false);
    scope.notePointerDown(inside);
    scope.noteFocusIn(outside);
    expect(scope.inScope(body)).toBe(false);
    // …and a focus move that stays inside the chart does not.
    scope.notePointerDown(inside);
    scope.noteFocusIn(inside);
    expect(scope.inScope(body)).toBe(true);
  });

  it("never treats a target outside the chart as in scope, claim or no claim", () => {
    const scope = createKeyScope(root);
    scope.notePointerDown(inside);
    expect(scope.inScope(outside)).toBe(false);
  });
});

describe("runStroke: last matching binding wins", () => {
  it("runs the most recent contribution of a chord and claims the stroke", () => {
    const ran: string[] = [];
    const out = route(
      [record(ran, "ArrowDown", "early"), record(ran, "ArrowDown", "late")],
      stroke("ArrowDown"),
    );
    expect(out.claimed).toBe(true);
    expect(out.claims).toBe(1);
    expect(ran).toEqual(["late"]);
  });

  it("leaves an unclaimed stroke alone", () => {
    const ran: string[] = [];
    const out = route([record(ran, "ArrowDown", "down")], stroke("q"));
    expect(out.claimed).toBe(false);
    expect(out.claims).toBe(0);
    expect(ran).toEqual([]);
  });

  it("falls through to an earlier contribution when the later `when` is false", () => {
    const ran: string[] = [];
    const out = route(
      [record(ran, "Ctrl+J", "early"), record(ran, "Ctrl+J", "late", () => false)],
      stroke("j", { ctrlKey: true }),
    );
    expect(ran).toEqual(["early"]);
    expect(out.claims).toBe(1);
  });

  it("treats a throwing `when` as false and reports it", () => {
    const ran: string[] = [];
    const out = route(
      [
        record(ran, "Ctrl+K", "k", () => {
          throw new Error("boom");
        }),
      ],
      stroke("k", { ctrlKey: true }),
    );
    expect(ran).toEqual([]);
    expect(out.claimed).toBe(false);
    expect(out.faults.length).toBe(1);
  });

  it("reports a throwing `run` instead of letting it escape, having already claimed", () => {
    const out = route(
      [
        {
          key: "Ctrl+K",
          run: () => {
            throw new Error("boom");
          },
        },
      ],
      stroke("k", { ctrlKey: true }),
    );
    expect(out.claimed).toBe(true);
    expect(out.claims).toBe(1);
    expect(out.faults.length).toBe(1);
  });

  it("ignores a binding whose key string names no chord", () => {
    const ran: string[] = [];
    const out = route([record(ran, "Hyper+K", "hyper")], stroke("k"));
    expect(out.claimed).toBe(false);
    expect(ran).toEqual([]);
  });

  it("admits a `{ key, run }` contribution with no optional members at all", () => {
    // The structural shape sibling plugins (undo-redo, interaction) contribute through their own
    // narrow shims: neither `description` nor `when` is required.
    const ran: string[] = [];
    const out = route([{ key: "Ctrl+Z", run: () => ran.push("undo") }], stroke("z", { ctrlKey: true }));
    expect(out.claimed).toBe(true);
    expect(ran).toEqual(["undo"]);
  });
});
