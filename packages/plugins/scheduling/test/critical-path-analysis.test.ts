/**
 * The pure analysis pass: float quantification, classification thresholds, negative float,
 * summary/cycle exclusion, critical links and parallel path detection — plus the color resolver.
 *
 * docs/specs/plugins/scheduling.md §7.1–§7.2. This is the CPM-equivalence acceptance suite:
 * `analyze`/`latestTimesOf` here run over `@stargantt/sdk`'s `sdk/cpm` (§7.1), and every
 * expectation below holds byte for byte against the same fixtures and expected values.
 */
import { describe, expect, it } from "vitest";
import type { Link, LinkId, ReadonlyDataView, Task, TaskId } from "@stargantt/plugin-data-store";
import { analyze, emptyAnalysis, latestTimesOf, linkSlack } from "../src/internal/critical-path/analysis";
import type { LatestTimesMap } from "../src/internal/critical-path/analysis";
import {
  createColorResolver,
  FALLBACK_CRITICAL_BAR,
  FALLBACK_CRITICAL_FLOAT,
  FALLBACK_NEAR_CRITICAL_BAR,
  FALLBACK_NEGATIVE_FLOAT,
  TOKEN_CRITICAL_BAR,
  TOKEN_CRITICAL_FLOAT,
  TOKEN_NEAR_CRITICAL_BAR,
  TOKEN_NEGATIVE_FLOAT,
} from "../src/internal/critical-path/colors";
import type { ThemeReader } from "../src/internal/critical-path/colors";

const DAY = 86_400_000;

function task(id: TaskId, startDays: number, endDays: number, type?: Task["type"]): Task {
  const t: Task = { id, parentId: null, name: String(id), start: startDays * DAY, end: endDays * DAY };
  if (type !== undefined) t.type = type;
  return t;
}

function link(id: LinkId, sourceId: TaskId, targetId: TaskId, type: Link["type"] = "FS", lag?: number): Link {
  const l: Link = { id, sourceId, targetId, type };
  if (lag !== undefined) l.lag = lag;
  return l;
}

/** A minimal hand-built view: only the members the analysis reads are populated meaningfully. */
function view(tasks: Task[], links: Link[] = []): ReadonlyDataView {
  const byId = new Map<TaskId, Task>(tasks.map((t) => [t.id, t]));
  const linksByTask = new Map<TaskId, { in: Link[]; out: Link[] }>();
  const slot = (id: TaskId): { in: Link[]; out: Link[] } => {
    let s = linksByTask.get(id);
    if (s === undefined) {
      s = { in: [], out: [] };
      linksByTask.set(id, s);
    }
    return s;
  };
  for (const l of links) {
    slot(l.sourceId).out.push(l);
    slot(l.targetId).in.push(l);
  }
  return {
    byId,
    children: new Map(),
    linksByTask,
    calendars: new Map(),
    resources: new Map(),
    assignmentsByTask: new Map(),
  };
}

function lt(entries: [TaskId, number, number][]): LatestTimesMap {
  return new Map(entries.map(([id, ls, lf]) => [id, { latestStart: ls * DAY, latestFinish: lf * DAY }]));
}

const ZERO = { criticalMs: 0, nearMs: 0 };

describe("float quantification", () => {
  it("computes zero total float along a tight chain and slack elsewhere", () => {
    const v = view(
      [task("a", 0, 2), task("b", 2, 4), task("c", 4, 6), task("d", 0, 1)],
      [link("l1", "a", "b"), link("l2", "b", "c")],
    );
    const latest = lt([
      ["a", 0, 2],
      ["b", 2, 4],
      ["c", 4, 6],
      ["d", 5, 6],
    ]);
    const r = analyze(v, latest, ZERO);
    expect(r.floats.get("a")).toEqual({ totalFloat: 0, freeFloat: 0 });
    expect(r.floats.get("b")).toEqual({ totalFloat: 0, freeFloat: 0 });
    expect(r.floats.get("c")).toEqual({ totalFloat: 0, freeFloat: 0 });
    expect(r.floats.get("d")).toEqual({ totalFloat: 5 * DAY, freeFloat: 5 * DAY });
    expect([...r.classes.keys()].sort()).toEqual(["a", "b", "c"]);
    expect(r.classes.get("a")).toBe("critical");
  });

  it("free float is the minimum link slack over the outgoing links, lag respected", () => {
    const v = view(
      [task("a", 0, 2), task("b", 3, 5), task("c", 6, 7)],
      [link("l1", "a", "b", "FS", DAY), link("l2", "a", "c")],
    );
    const latest = lt([
      ["a", 0, 2],
      ["b", 3, 5],
      ["c", 6, 7],
    ]);
    const r = analyze(v, latest, ZERO);
    expect(r.floats.get("a")?.freeFloat).toBe(0);
  });
});

describe("linkSlack per link type", () => {
  const s = task("s", 0, 2);
  const t = task("t", 5, 8);
  it.each([
    ["FS", 3 * DAY],
    ["SS", 5 * DAY],
    ["FF", 6 * DAY],
    ["SF", 8 * DAY],
  ] as const)("%s", (type, expected) => {
    expect(linkSlack(link("l", "s", "t", type), s, t)).toBe(expected);
  });
});

describe("classification thresholds", () => {
  it("critical threshold and near-critical band in days", () => {
    const v = view([task("a", 0, 2), task("b", 0, 2), task("c", 0, 2)]);
    const latest = lt([
      ["a", 0, 2], // TF 0 -> critical
      ["b", 1.5, 3.5], // TF 1.5d -> near with band 2d
      ["c", 4, 6], // TF 4d -> unclassified
    ]);
    const r = analyze(v, latest, { criticalMs: 0, nearMs: 2 * DAY });
    expect(r.classes.get("a")).toBe("critical");
    expect(r.classes.get("b")).toBe("nearCritical");
    expect(r.classes.get("c")).toBeUndefined();
  });

  it("a non-zero critical threshold widens what counts as critical", () => {
    const v = view([task("a", 0, 2)]);
    const r = analyze(v, lt([["a", 1, 3]]), { criticalMs: DAY, nearMs: 0 });
    expect(r.classes.get("a")).toBe("critical");
  });

  it("negative total float classifies as negativeFloat", () => {
    const v = view([task("x", 0, 2), task("y", 1, 3)], [link("l", "x", "y")]);
    const latest = lt([
      ["x", -1, 1],
      ["y", 1, 3],
    ]);
    const r = analyze(v, latest, ZERO);
    expect(r.classes.get("x")).toBe("negativeFloat");
    expect(r.floats.get("x")?.totalFloat).toBe(-DAY);
    expect(r.criticalLinks.has("l")).toBe(true);
    expect(r.paths).toHaveLength(1);
  });
});

describe("exclusions", () => {
  it("summary tasks carry no float and never classify", () => {
    const v = view([task("sum", 0, 2, "summary"), task("a", 0, 2)]);
    const latest = lt([
      ["sum", 0, 2],
      ["a", 0, 2],
    ]);
    const r = analyze(v, latest, ZERO);
    expect(r.floats.has("sum")).toBe(false);
    expect(r.classes.has("sum")).toBe(false);
    expect(r.classes.get("a")).toBe("critical");
  });

  it("cycle members and their cycle-constrained predecessors carry no float, class or path (§7.1)", () => {
    // p -> a <-> b (a real cycle), plus an independent tight task z ending at the project finish.
    const v = view(
      [task("p", 0, 1), task("a", 1, 3), task("b", 3, 5), task("z", 0, 5)],
      [link("lp", "p", "a"), link("l1", "a", "b"), link("l2", "b", "a")],
    );
    const latest = latestTimesOf(v);
    expect(latest.has("a")).toBe(false);
    expect(latest.has("b")).toBe(false);
    // p's only chain to the project end runs through the cycle -- omitted too.
    expect(latest.has("p")).toBe(false);
    const r = analyze(v, latest, ZERO);
    for (const id of ["p", "a", "b"]) {
      expect(r.floats.has(id)).toBe(false);
      expect(r.classes.has(id)).toBe(false);
      for (const path of r.paths) expect(path.tasks).not.toContain(id);
    }
    expect(r.classes.get("z")).toBe("critical");
    expect(r.paths).toEqual([{ tasks: ["z"], links: [] }]);
  });
});

describe("critical links and parallel paths", () => {
  it("detects two parallel critical chains as two separate paths, ordered by start", () => {
    const v = view(
      [task("a", 0, 2), task("b", 2, 4), task("p", 1, 3), task("q", 3, 4)],
      [link("l1", "a", "b"), link("l2", "p", "q")],
    );
    const latest = lt([
      ["a", 0, 2],
      ["b", 2, 4],
      ["p", 1, 3],
      ["q", 3, 4],
    ]);
    const r = analyze(v, latest, ZERO);
    expect(r.criticalLinks).toEqual(new Set(["l1", "l2"]));
    expect(r.paths).toHaveLength(2);
    expect(r.paths[0]).toEqual({ tasks: ["a", "b"], links: ["l1"] });
    expect(r.paths[1]).toEqual({ tasks: ["p", "q"], links: ["l2"] });
  });

  it("a link with consumed slack does not join two critical tasks into one path", () => {
    const v = view([task("a", 0, 2), task("b", 3, 4)], [link("l", "a", "b")]);
    const latest = lt([
      ["a", 0, 2],
      ["b", 3, 4],
    ]);
    const r = analyze(v, latest, ZERO);
    expect(r.criticalLinks.size).toBe(0);
    expect(r.paths).toHaveLength(2);
    expect(r.paths.map((p) => p.tasks)).toEqual([["a"], ["b"]]);
  });

  it("near-critical tasks never join a path", () => {
    const v = view([task("a", 0, 2), task("b", 2, 4)], [link("l", "a", "b")]);
    const latest = lt([
      ["a", 0.5, 2.5],
      ["b", 2.5, 4.5],
    ]);
    const r = analyze(v, latest, { criticalMs: 0, nearMs: DAY });
    expect(r.classes.get("a")).toBe("nearCritical");
    expect(r.criticalLinks.size).toBe(0);
    expect(r.paths).toHaveLength(0);
  });

  it("empty data yields the empty analysis", () => {
    const r = analyze(view([]), new Map(), ZERO);
    expect(r.floats.size).toBe(0);
    expect(r.paths).toHaveLength(0);
  });
});

describe("emptyAnalysis", () => {
  it("builds a fresh, independent object on every call (§1.3 rule 1 is per-instance state)", () => {
    const a = emptyAnalysis();
    const b = emptyAnalysis();
    expect(a).not.toBe(b);
    expect(a.floats).not.toBe(b.floats);
    expect(a.classes).not.toBe(b.classes);
    expect(a.criticalLinks).not.toBe(b.criticalLinks);
    expect(a.paths).not.toBe(b.paths);
    (a.floats as unknown as Map<TaskId, unknown>).set("x", 1);
    expect(emptyAnalysis().floats.size).toBe(0);
  });
});

describe("classification boundaries", () => {
  it("includes the exact upper edge of the near-critical band", () => {
    const v = view([task("a", 0, 2)]);
    const latest = lt([["a", 3, 5]]); // totalFloat = 3 days
    const r = analyze(v, latest, { criticalMs: DAY, nearMs: 2 * DAY });
    expect(r.classes.get("a")).toBe("nearCritical");
  });

  it("with nearMs 0, a task exactly at the critical threshold is critical, one past it is unclassified", () => {
    const v = view([task("a", 0, 2), task("b", 0, 2)]);
    const latest = lt([
      ["a", 1, 3], // totalFloat = 1 day, exactly criticalMs
      ["b", 1.001, 3.001],
    ]);
    const r = analyze(v, latest, { criticalMs: DAY, nearMs: 0 });
    expect(r.classes.get("a")).toBe("critical");
    expect(r.classes.get("b")).toBeUndefined();
  });
});

describe("free-float fallback", () => {
  it("a task whose only successors are summaries falls back to the project-finish distance", () => {
    const v = view(
      [task("a", 0, 2), task("sum", 0, 9, "summary"), task("z", 0, 6)],
      [link("l1", "a", "sum")],
    );
    const latest = lt([
      ["a", 4, 6],
      ["z", 0, 6],
    ]);
    const r = analyze(v, latest, ZERO);
    expect(r.floats.get("a")?.freeFloat).toBe(4 * DAY);
  });
});

/* ------------------------------------------------------------------ *
 * Color resolver (§7.3)
 * ------------------------------------------------------------------ */

const NO_OVERRIDES = {
  criticalColorOverride: undefined,
  nearCriticalColorOverride: undefined,
  negativeFloatColorOverride: undefined,
  floatColorOverride: undefined,
};

describe("createColorResolver", () => {
  it("falls back to the documented defaults when theme is undefined", () => {
    const colors = createColorResolver(NO_OVERRIDES, undefined);
    expect(colors.critical()).toBe(FALLBACK_CRITICAL_BAR);
    expect(colors.nearCritical()).toBe(FALLBACK_NEAR_CRITICAL_BAR);
    expect(colors.negativeFloat()).toBe(FALLBACK_NEGATIVE_FLOAT);
    expect(colors.float()).toBe(FALLBACK_CRITICAL_FLOAT);
  });

  it("falls back to the documented defaults when the token is unset", () => {
    const theme: ThemeReader = { get: () => "" };
    const colors = createColorResolver(NO_OVERRIDES, theme);
    expect(colors.critical()).toBe(FALLBACK_CRITICAL_BAR);
    expect(colors.float()).toBe(FALLBACK_CRITICAL_FLOAT);
  });

  it("reads the CSS custom property through theme.get when no override is configured", () => {
    const theme: ThemeReader = {
      get: (token) =>
        token === TOKEN_CRITICAL_BAR
          ? "rgb(1, 2, 3)"
          : token === TOKEN_NEAR_CRITICAL_BAR
            ? "rgb(4, 5, 6)"
            : token === TOKEN_NEGATIVE_FLOAT
              ? "rgb(7, 8, 9)"
              : token === TOKEN_CRITICAL_FLOAT
                ? "rgb(10, 11, 12)"
                : "",
    };
    const colors = createColorResolver(NO_OVERRIDES, theme);
    expect(colors.critical()).toBe("rgb(1, 2, 3)");
    expect(colors.nearCritical()).toBe("rgb(4, 5, 6)");
    expect(colors.negativeFloat()).toBe("rgb(7, 8, 9)");
    expect(colors.float()).toBe("rgb(10, 11, 12)");
  });

  it("prefers the config override over the theme token", () => {
    const theme: ThemeReader = { get: () => "rgb(1, 2, 3)" };
    const colors = createColorResolver({ ...NO_OVERRIDES, criticalColorOverride: "#0000aa" }, theme);
    expect(colors.critical()).toBe("#0000aa");
  });

  it("reads the token fresh on every call, not cached at construction", () => {
    let value = "rgb(1, 1, 1)";
    const theme: ThemeReader = { get: () => value };
    const colors = createColorResolver(NO_OVERRIDES, theme);
    expect(colors.critical()).toBe("rgb(1, 1, 1)");
    value = "rgb(2, 2, 2)";
    expect(colors.critical()).toBe("rgb(2, 2, 2)");
  });
});
