import { expect, test } from "./_fixtures";
import { FIXED_TIME, settle } from "./_fixtures";

// E2E for examples/data-sync.html: the data-sync plugin's source area (a `localAdapter` seeded
// with a tiny project, no server) and offline area (a REAL browser IndexedDB snapshot), composed
// as an OPT-IN plugin on top of `presetStandard()` per docs/specs/plugins/data-sync.md. Also
// covers the bundle surface for the data-sync, portfolio, i18n and perf-tools plugin factories'
// exports, and a small in-page `createDictionary()` smoke test for i18n.
//
// The offline round-trip test below is data-sync.md's named scenario (§4.1/§4.2): load from
// source, make a local edit (dispatched as a real `task/add` command — the pending tracker's
// positive control, §2.3), save offline, a REAL page reload (fresh `Gantt` instance, nothing
// carried in JS memory), restore offline, and assert the edit survived. The persistence claim
// gets its own positive/negative control pair: restoring WITH a saved snapshot brings the added
// task back; the identical gesture (reload, click "Restore offline") after "Clear offline" does
// not — same buttons, same reload, opposite outcome, so the pass cannot be vacuous ("always
// empty" would fail the first half; "always whatever was there before" would fail the second).
//
// No screenshot baselines in this file: nothing here calls `toHaveScreenshot`.
//
// Explicitly out of scope here: lazy loading and realtime (data-sync.md §3/§5) — this page wires
// only the source and offline areas; `followFilter`, `graphql`, and the REST adapter (no network
// in this suite, matching the corpus's zero-server E2E policy).

const CONTAINER = "#chart";

declare const gantt: {
  dispatch(cmd: string, payload: unknown): void;
  on(event: string, fn: (e: unknown) => void): { dispose(): void };
  service(key: "stargantt.data"): {
    getTask(id: string): { id: string; name: string; start: number; end: number } | undefined;
    tasks: { get(): ReadonlyMap<string, unknown> };
  };
  service(key: "stargantt.data-sync"): {
    load(): Promise<{ ok: boolean }>;
    pending(): { creates: number; updates: number; removes: number };
    offline: {
      save(): Promise<{ ok: boolean; tasks?: number }>;
      restore(): Promise<{ ok: boolean; tasks?: number }>;
      clear(): Promise<{ ok: boolean }>;
    };
  };
};

declare const window: Window & {
  __lastOp?: Promise<unknown>;
  StarGantt: Record<string, unknown>;
};

/** Awaits the promise the last-clicked button's handler stashed on `window.__lastOp`
 *  (examples/data-sync.html's testability hook — see its header comment). */
async function awaitLastOp(page: import("@playwright/test").Page): Promise<void> {
  await page.evaluate(() => window.__lastOp);
}

async function click(page: import("@playwright/test").Page, id: string): Promise<void> {
  await page.click(`#${id}`);
  await awaitLastOp(page);
}

async function bootDataSync(page: import("@playwright/test").Page, openExample: import("./_fixtures").OpenExample): Promise<void> {
  await openExample("data-sync.html", { ready: `${CONTAINER} canvas`, fixedTime: FIXED_TIME });
  await settle(page);
}

async function taskCount(page: import("@playwright/test").Page): Promise<number> {
  return page.evaluate(() => gantt.service("stargantt.data").tasks.get().size);
}

async function hasTask(page: import("@playwright/test").Page, id: string): Promise<boolean> {
  return page.evaluate((taskId) => gantt.service("stargantt.data").getTask(taskId) !== undefined, id);
}

async function pending(page: import("@playwright/test").Page) {
  return page.evaluate(() => gantt.service("stargantt.data-sync").pending());
}

test.describe("bundle surface", () => {
  test("the IIFE global exposes the data-sync, portfolio, i18n and perf-tools plugin factories and data-sync's hostless factories as functions", async ({
    page,
    openExample,
  }) => {
    await bootDataSync(page, openExample);
    const kinds = await page.evaluate(() => {
      const g = window.StarGantt;
      return {
        dataSync: typeof g.dataSync,
        portfolio: typeof g.portfolio,
        i18n: typeof g.i18n,
        perfTools: typeof g.perfTools,
        restAdapter: typeof g.restAdapter,
        localAdapter: typeof g.localAdapter,
        graphqlAdapter: typeof g.graphqlAdapter,
        webSocketTransport: typeof g.webSocketTransport,
        sseTransport: typeof g.sseTransport,
        createDictionary: typeof g.createDictionary,
      };
    });
    expect(kinds).toEqual({
      dataSync: "function",
      portfolio: "function",
      i18n: "function",
      perfTools: "function",
      restAdapter: "function",
      localAdapter: "function",
      graphqlAdapter: "function",
      webSocketTransport: "function",
      sseTransport: "function",
      createDictionary: "function",
    });
    // Discriminating negative control: a name that is genuinely absent from the global reports
    // "undefined", proving the check above is not vacuously true for any string.
    const bogus = await page.evaluate(() => typeof (window.StarGantt as Record<string, unknown>).notARealExport);
    expect(bogus).toBe("undefined");
  });
});

test.describe("offline snapshot round-trip", () => {
  test("load, edit, save offline, reload, restore — the edit survives; clear + the identical gesture does not resurrect it", async ({
    page,
    openExample,
  }) => {
    await bootDataSync(page, openExample);

    // A fresh instance starts empty: no autoLoad, no autoRestore.
    expect(await taskCount(page)).toBe(0);

    // --- load from source ---
    await click(page, "load-from-source");
    await expect(page.locator("#status")).toContainText("sync/sourceSynced");
    expect(await taskCount(page)).toBe(2);
    expect(await hasTask(page, "design")).toBe(true);
    expect(await hasTask(page, "build")).toBe(true);

    // --- user edit: pending-tracker positive control (part 1 of 2) ---
    expect(await pending(page)).toEqual({ creates: 0, updates: 0, removes: 0 });
    await click(page, "add-task");
    expect(await hasTask(page, "added-1")).toBe(true);
    expect(await pending(page)).toEqual({ creates: 1, updates: 0, removes: 0 });

    // --- save offline ---
    await click(page, "save-offline");
    await expect(page.locator("#status")).toContainText("sync/offlineSaved");
    await expect(page.locator("#status")).toContainText("tasks: 3");
    // save() only reads — it is not a bulk store replacement — so the pending edit is untouched.
    expect(await pending(page)).toEqual({ creates: 1, updates: 0, removes: 0 });

    // --- a REAL page reload: fresh Gantt instance, nothing carried in JS memory ---
    await page.reload();
    await expect(page.locator(`${CONTAINER} canvas`).first()).toBeVisible();
    await settle(page);
    expect(await taskCount(page)).toBe(0); // fresh instance, nothing loaded yet
    expect(await hasTask(page, "added-1")).toBe(false);

    // --- restore offline: the positive control ---
    await click(page, "restore-offline");
    await expect(page.locator("#status")).toContainText("sync/offlineRestored");
    await expect(page.locator("#status")).toContainText("tasks: 3");
    expect(await hasTask(page, "design")).toBe(true);
    expect(await hasTask(page, "added-1")).toBe(true); // the edit survived the reload
    // Pending-tracker sanity (part 2 of 2): restore() is a bulk replacement (§6.1) — it clears the
    // pending set. Combined with the `{ creates: 1, ... }` reading right after "add task" above,
    // this is the discriminating pair the task calls for (1 then 0, not just 0).
    expect(await pending(page)).toEqual({ creates: 0, updates: 0, removes: 0 });

    // --- clear offline, then the IDENTICAL gesture (reload, click "Restore offline") ---
    await click(page, "clear-offline");
    await expect(page.locator("#status")).toContainText("sync/offlineCleared");

    await page.reload();
    await expect(page.locator(`${CONTAINER} canvas`).first()).toBeVisible();
    await settle(page);
    expect(await taskCount(page)).toBe(0);

    await click(page, "restore-offline"); // same button, same reload, now nothing persisted
    expect(await hasTask(page, "added-1")).toBe(false);
    expect(await hasTask(page, "design")).toBe(false);
    expect(await taskCount(page)).toBe(0); // restore() resolved { ok: false }; the store is untouched
  });
});

test.describe("i18n smoke", () => {
  test("createDictionary()'s catalog()/t()/state track locale, fallbacks, and per-key overrides in-page", async ({
    page,
    openExample,
  }) => {
    await bootDataSync(page, openExample);
    const result = await page.evaluate(() => {
      const g = window.StarGantt as {
        createDictionary(config?: unknown): {
          t(key: string): string | undefined;
          has(key: string, locale?: string): boolean;
          setLocale(locale: string): void;
          state: { get(): { locale: string; resolutionOrder: readonly string[] } };
          catalog<T extends object>(prefix: string, defaults: T): T;
        };
      };
      const dict = g.createDictionary({
        locale: "ja-JP",
        translations: { ja: { "demo.greeting": "こんにちは" } },
      });
      const defaults = { greeting: "Hello", nonString: 42 };
      const catalogged = dict.catalog("demo", defaults);
      return {
        // The active tag resolves through its shortened prefix ("ja-JP" -> "ja") to the
        // registered "ja" table (i18n.md §1.2).
        greeting: dict.t("demo.greeting"),
        missing: dict.t("demo.nonexistent"),
        resolutionOrder: dict.state.get().resolutionOrder,
        // catalog() overrides only string-valued defaults and leaves non-string ones (builders)
        // untouched — the discriminating half of this probe.
        cataloggedGreeting: catalogged.greeting,
        cataloggedNonString: catalogged.nonString,
        // defaults itself must be a distinct, un-mutated object (i18n.md §1.4).
        defaultsUnmutated: defaults.greeting === "Hello" && catalogged !== defaults,
      };
    });
    expect(result.greeting).toBe("こんにちは");
    expect(result.missing).toBeUndefined();
    expect(result.resolutionOrder).toEqual(["ja-jp", "ja", "en"]);
    expect(result.cataloggedGreeting).toBe("こんにちは");
    expect(result.cataloggedNonString).toBe(42);
    expect(result.defaultsUnmutated).toBe(true);
  });
});
