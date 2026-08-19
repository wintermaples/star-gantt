// @vitest-environment happy-dom
// docs/specs/plugins/export.md §2.2 — snapshot tokens and URLs. `createSnapshot`/`snapshotUrl`
// merge into `snapshot(options)`, and `applySnapshot(token)`/`restoreFromUrl(url?)` merge into
// `applySnapshot(source?)` (§1's fold map).
import { afterEach, describe, expect, it } from "vitest";
import {
  buildSnapshotUrl,
  decodeBase64Url,
  decodeSnapshot,
  encodeBase64Url,
  encodeSnapshot,
  extractSnapshotToken,
} from "../src/internal/embed/snapshot";
import { DISPOSED_MESSAGE } from "../src/internal/wiring";
import { boot, DAY, sampleData } from "./_boot";
import type { Booted } from "./_boot";

let booted: Booted | undefined;
afterEach(() => {
  booted?.dispose();
  booted = undefined;
});

describe("base64url codec", () => {
  it("round-trips arbitrary bytes without padding or unsafe characters", () => {
    for (const len of [0, 1, 2, 3, 4, 61, 255]) {
      const bytes = Uint8Array.from({ length: len }, (_, i) => (i * 37 + len) % 256);
      const text = encodeBase64Url(bytes);
      expect(text).toMatch(/^[A-Za-z0-9_-]*$/);
      expect(decodeBase64Url(text)).toEqual(bytes);
    }
  });

  it("rejects text outside the alphabet", () => {
    expect(decodeBase64Url("ab+/")).toBeUndefined();
    expect(decodeBase64Url("a")).toBeUndefined();
  });

  it("rejects a char code past the 256-entry decode table instead of misreading it as 0", () => {
    expect(decodeBase64Url("あAAA")).toBeUndefined();
    expect(decodeBase64Url("Aあ")).toBeUndefined();
  });

  it("round-trips non-ASCII project data through encode/decodeSnapshot", () => {
    const data = { tasks: [{ id: "1", name: "あ" }], links: [], calendars: [], resources: [], assignments: [] };
    const token = encodeSnapshot(data);
    expect(decodeSnapshot(token)).toEqual({ data, droppedTasks: 0 });
  });

  it("rejects a token whose decoded size would exceed the 4MiB ceiling", () => {
    // 6,000,000 valid base64url chars (a multiple of 4) decode to 4,500,000 bytes — past the
    // 4MiB (4,194,304-byte) ceiling — without needing a genuinely huge fixture on disk.
    const token = "A".repeat(6_000_000);
    expect(decodeBase64Url(token)).toBeUndefined();
  });

  it("still decodes a token right at the boundary of the ceiling", () => {
    const n = 5_592_406;
    const bytes = decodeBase64Url("A".repeat(n));
    expect(bytes?.length).toBe(4 * 1024 * 1024);
  });
});

describe("snapshot tokens (service)", () => {
  it("round-trips the whole project through snapshot()/applySnapshot()", () => {
    const { tasks, resources, assignments } = sampleData();
    booted = boot({ tasks, resources, assignments });
    const token = booted.service.snapshot();
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);

    booted.dispatch("task/update", { id: "a1", after: { name: "Mutated" } });
    booted.dispatch("task/remove", { ids: ["m1"] });
    expect(booted.data.getTask("m1")).toBeUndefined();

    expect(booted.service.applySnapshot(token)).toBe(true);
    expect(booted.data.getTask("a1")?.name).toBe("Wireframes");
    expect(booted.data.getTask("a1")?.progress).toBe(1);
    expect(booted.data.getTask("m1")?.name).toBe("Launch");
    expect(booted.snapshotApplied).toEqual([{ source: "api", droppedTasks: 0 }]);
  });

  it("restores while read-only (load() is exempt from the veto)", () => {
    const { tasks } = sampleData();
    let b1 = boot({ tasks });
    const token = b1.service.snapshot();
    b1.dispose();

    booted = boot({ config: { viewerEmbed: { readOnly: true } } });
    expect(booted.service.applySnapshot(token)).toBe(true);
    expect(booted.data.getTask("a1")?.name).toBe("Wireframes");
    b1 = undefined as never;
  });

  it("rejects unusable tokens silently, touching nothing", () => {
    booted = boot();
    const before = booted.data.toJSON();
    for (const bad of [
      "",
      "not/base64!",
      encodeBase64Url(new TextEncoder().encode("[1,2]")),
      encodeBase64Url(new TextEncoder().encode('{"schema":"other","data":{}}')),
      42 as unknown as string,
    ]) {
      expect(booted.service.applySnapshot(bad)).toBe(false);
    }
    expect(booted.data.toJSON()).toEqual(before);
    expect(booted.snapshotApplied).toEqual([]);
    expect(booted.errors).toEqual([]);
  });

  // Review m1 — every facade member checks `ExportWiring.disposed()` at entry, the same guard the
  // image path (`../../src/index.ts`'s `begin()`) already enforces.
  it("throws the disposed-instance error once the plugin is torn down", () => {
    booted = boot();
    booted.dispose();
    expect(() => booted?.service.snapshot()).toThrowError(DISPOSED_MESSAGE);
  });
});

describe("snapshot URLs (service)", () => {
  it("snapshot({ url }) puts the token in the fragment of the given base", () => {
    booted = boot();
    const url = booted.service.snapshot({ url: "https://example.test/gantt" });
    expect(url).toMatch(/^https:\/\/example\.test\/gantt#sg-snapshot=[A-Za-z0-9_-]+$/);
  });

  it("replaces an existing parameter and preserves other fragment content", () => {
    expect(buildSnapshotUrl("https://x.test/#view=week&sg-snapshot=OLD", "sg-snapshot", "NEW")).toBe(
      "https://x.test/#view=week&sg-snapshot=NEW",
    );
  });

  it("extracts from the fragment first, then the query string", () => {
    expect(extractSnapshotToken("https://x.test/?sg-snapshot=Q#sg-snapshot=F", "p")).toBeUndefined();
    expect(extractSnapshotToken("https://x.test/?sg-snapshot=Q#sg-snapshot=F", "sg-snapshot")).toBe("F");
    expect(extractSnapshotToken("https://x.test/?sg-snapshot=Q", "sg-snapshot")).toBe("Q");
    expect(extractSnapshotToken("https://x.test/", "sg-snapshot")).toBeUndefined();
  });

  it("applySnapshot(url) restores from a shared URL and reports source url", () => {
    const { tasks } = sampleData();
    let b1 = boot({ tasks });
    const url = b1.service.snapshot({ url: "https://example.test/embed.html" });
    b1.dispose();

    booted = boot({ config: { viewerEmbed: { readOnly: true } } });
    expect(booted.service.applySnapshot(url)).toBe(true);
    expect(booted.data.getTask("m1")?.name).toBe("Launch");
    expect(booted.snapshotApplied).toEqual([{ source: "url", droppedTasks: 0 }]);
    b1 = undefined as never;
  });

  it("applySnapshot(url) returns false for a URL without the parameter, and without a token there is nothing to restore", () => {
    booted = boot();
    expect(booted.service.applySnapshot("https://example.test/")).toBe(false);
    expect(booted.snapshotApplied).toEqual([]);
  });

  it("autoRestore without a usable location is a silent no-op", () => {
    booted = boot({ config: { viewerEmbed: { autoRestore: true } } });
    expect(booted.errors).toEqual([]);
    expect(booted.snapshotApplied).toEqual([]);
  });

  it("honors a custom snapshotParam and falls back to the default for a blank one", () => {
    booted = boot({ config: { viewerEmbed: { snapshotParam: "snap" } } });
    const url = booted.service.snapshot({ url: "https://x.test/" });
    expect(url).toContain("#snap=");

    const restored = boot({ config: { viewerEmbed: { snapshotParam: "  " } } });
    try {
      expect(restored.service.snapshot({ url: "https://x.test/" })).toContain("#sg-snapshot=");
    } finally {
      restored.dispose();
    }
  });

  it("rejects a snapshotParam containing &, =, or # and falls back to the default", () => {
    for (const bad of ["a&b", "a=b", "a#b"]) {
      const b = boot({ config: { viewerEmbed: { snapshotParam: bad } } });
      try {
        expect(b.service.snapshot({ url: "https://x.test/" })).toContain("#sg-snapshot=");
      } finally {
        b.dispose();
      }
    }
  });

  it("a token present in both the fragment and the query string: the fragment wins", () => {
    const { tasks } = sampleData();
    let b1 = boot({ tasks });
    const fragmentToken = b1.service.snapshot();
    b1.dispose();

    booted = boot({ config: { viewerEmbed: { readOnly: true } } });
    const queryToken = encodeBase64Url(
      new TextEncoder().encode(JSON.stringify({ schema: "stargantt/snapshot/v1", data: { tasks: [] } })),
    );
    const url = `https://example.test/?sg-snapshot=${queryToken}#sg-snapshot=${fragmentToken}`;
    expect(booted.service.applySnapshot(url)).toBe(true);
    // The fragment's task ("m1") is present, proving the fragment (not the query) was applied.
    expect(booted.data.getTask("m1")?.name).toBe("Launch");
    b1 = undefined as never;
  });

  it("reads the correct window for the mount point (iframe correctness), not a bare `window` global", () => {
    booted = boot();
    // Simulate this plugin mounting inside an iframe whose own window differs from whatever a
    // bare `window` reference in the test environment would resolve to. `defaultView` is a
    // getter-only accessor on the real Document prototype, so it is overridden per-instance
    // through `defineProperty` rather than plain assignment.
    const original = Object.getOwnPropertyDescriptor(Document.prototype, "defaultView");
    Object.defineProperty(document, "defaultView", {
      configurable: true,
      value: { location: { href: "https://embedded.test/frame" } },
    });
    try {
      const url = booted.service.snapshot({ url: true });
      expect(url.startsWith("https://embedded.test/frame#sg-snapshot=")).toBe(true);
    } finally {
      if (original !== undefined) Object.defineProperty(document, "defaultView", original);
      else delete (document as unknown as { defaultView?: unknown }).defaultView;
    }
  });
});

// §2.2's trust boundary: a snapshot URL is as trusted as the page carrying it, but is still
// untrusted *data*, so decodeSnapshot applies minimal per-task validation before load.
describe("hostile-but-well-formed snapshot payloads", () => {
  it("passes through a huge task count and deeply nested unknown field values unchanged (still no deep validation)", () => {
    const deepValue = (): unknown => {
      let v: unknown = "leaf";
      for (let i = 0; i < 50; i += 1) v = { nested: v };
      return v;
    };
    const hostileData = {
      tasks: Array.from({ length: 2000 }, (_, i) => ({ id: `t${i}`, name: `Task ${i}`, start: i, end: i + 1, weird: deepValue() })),
      links: [],
      calendars: [],
      resources: [],
      assignments: [],
    };
    const token = encodeSnapshot(hostileData);
    const decoded = decodeSnapshot(token);
    expect(decoded?.droppedTasks).toBe(0);
    expect(decoded?.data.tasks).toHaveLength(2000);
    expect(decoded?.data.tasks[0]).toEqual(hostileData.tasks[0]);
  });

  it("drops task entries with an unusable id, keeping the rest and reporting the count", () => {
    const hostileData = {
      tasks: [
        { id: "ok1", start: 0, end: 10 },
        { id: 42, start: 0, end: 10 },
        { id: null, start: 0, end: 10 },
        { id: { nested: true }, start: 0, end: 10 },
        {},
        "not-an-object",
      ],
      links: [],
      calendars: [],
      resources: [],
      assignments: [],
    };
    const token = encodeSnapshot(hostileData);
    const decoded = decodeSnapshot(token);
    expect(decoded?.droppedTasks).toBe(4);
    expect(decoded?.data.tasks).toEqual([
      { id: "ok1", start: 0, end: 10 },
      { id: 42, start: 0, end: 10 },
    ]);
  });

  it("drops task entries whose present start/end is not a finite number, but keeps a missing start/end", () => {
    const hostileData = {
      tasks: [
        { id: "a", start: 0, end: 10 },
        { id: "b", start: Number.NaN, end: 10 },
        { id: "c", start: 0, end: Number.POSITIVE_INFINITY },
        { id: "d", start: "0", end: 10 },
        { id: "e" },
      ],
      links: [],
      calendars: [],
      resources: [],
      assignments: [],
    };
    const token = encodeSnapshot(hostileData);
    const decoded = decodeSnapshot(token);
    expect(decoded?.droppedTasks).toBe(3);
    expect(decoded?.data.tasks.map((t) => (t as { id: unknown }).id)).toEqual(["a", "e"]);
  });

  it("surfaces the dropped-task count through viewerembed/snapshotApplied when applied end to end", () => {
    booted = boot();
    const hostileData = {
      tasks: [
        { id: "ok", start: 0, end: DAY },
        { id: null, start: 0, end: DAY },
      ],
      links: [],
      calendars: [],
      resources: [],
      assignments: [],
    };
    const token = encodeSnapshot(hostileData);
    expect(booted.service.applySnapshot(token)).toBe(true);
    expect(booted.snapshotApplied).toEqual([{ source: "api", droppedTasks: 1 }]);
    expect(booted.data.getTask("ok")).toBeDefined();
  });
});
