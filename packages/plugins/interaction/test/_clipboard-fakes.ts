/**
 * Integration boot for the `clipboard` feature's own tests: a real `@stargantt/core` host with the
 * REAL `dataStore()` plugin (clipboard's commands must actually create/update tasks — a read-only
 * double, as `test/wiring.test.ts` uses for the other features, cannot exercise that), service
 * doubles for `stargantt.view` / `stargantt.tree-grid` / `stargantt.task-bars` (interaction's other
 * three hard dependencies, which clipboard itself never reads), and an optional fake `stargantt.a11y`
 * for the focus-channel announcements and the `keys/bindings` chord contributions. Kept separate
 * from `test/_fakes.ts` per this task's file-scope rule: new doubles live in their own prefixed
 * file.
 */
import { createTestHost, mockStore } from "@stargantt/sdk";
import { dataStore } from "@stargantt/plugin-data-store";
import type { AnyPlugin, PluginContext } from "@stargantt/core";
import type { DataService, Task, TaskId } from "@stargantt/plugin-data-store";
import { interaction } from "../src/index";
import { rowsOf } from "./_fakes";

/** One chord contributed to the point the a11y plugin owns. */
export interface KeyBindingProbe {
  key: string;
  when?(): boolean;
  run(): void;
}

/**
 * Dispatches `clipboard/copy` / `clipboard/paste` / `clipboard/duplicate` — this plugin's own
 * commands, registered through `internal/clipboard/wire.ts`'s narrow cast rather than a
 * `declare module` augmentation this task's file scope cannot add (see that file's own comment,
 * and this task's report). Test-side dispatch needs the same narrow cast.
 */
export function dispatchCommand(ctx: PluginContext, key: string, payload?: unknown): void {
  (ctx.dispatch as unknown as (key: string, payload: unknown) => void)(key, payload);
}

/** One stand-in plugin registered under a real provider's id, publishing its services. */
function provider(id: string, services: Record<string, unknown>): AnyPlugin {
  return {
    meta: { id },
    setup(ctx): void {
      for (const [key, impl] of Object.entries(services)) ctx.provide(key as never, impl as never);
    },
  };
}

export interface BootOptions {
  config?: Parameters<typeof interaction>[0];
  /** Seeded via the real store's `load()` before the host is returned. */
  tasks?: readonly Task[];
  /** Row order for `stargantt.rows` (also what visible-row-order capture/paste reads). */
  rowOrder?: readonly TaskId[];
  /** Whether an a11y stand-in is composed (focus channel + `keys/bindings`). Default `true`. */
  a11y?: boolean;
  /** The task the keyboard focus sits on, when `a11y` is composed. */
  focused?: TaskId;
}

export function boot(options: BootOptions = {}): {
  ctx: PluginContext;
  host: ReturnType<typeof createTestHost>;
  data: DataService;
  root: HTMLElement;
  /** Every transaction the store actually applied (`data/didApplyTransaction`), in order. */
  transactions: unknown[];
  /** Everything spoken through the focus channel's live region (`a11y` composed only). */
  spoken: string[];
  /** Every `core/pluginError` the composition reported. */
  faults: unknown[];
  /** The chords contributed to the a11y plugin's `keys/bindings` point. */
  keys(): readonly KeyBindingProbe[];
  /** The task the fake focus channel currently holds, after any `focus(id)` call (`a11y` composed only). */
  focused(): TaskId | undefined;
  /**
   * Fires a native `copy`/`paste` event, optionally on a descendant `target` (bubbling to the
   * chart root, where the feature listens) so the text-entry guard can be exercised.
   *
   * `fireCopy` returns what was written to the (fake) system clipboard, or `undefined` when
   * nothing was. `firePaste` returns `dispatchEvent`'s own result: `false` once the listener called
   * `preventDefault()` (i.e. it recognized and handled the paste), `true` otherwise (left to the
   * browser / another handler).
   */
  fireCopy(target?: HTMLElement): string | undefined;
  firePaste(text: string, target?: HTMLElement): boolean;
} {
  const rowOrder = options.rowOrder ?? (options.tasks ?? []).map((t) => t.id);
  const transactions: unknown[] = [];
  const spoken: string[] = [];
  const faults: unknown[] = [];

  const store = dataStore();
  const view = provider("stargantt.view", {
    "stargantt.view": {
      invalidate: () => {},
      viewport: mockStore({ scrollLeft: 0, scrollTop: 0, width: 800, height: 600 }),
      scrollTo: () => {},
      chartPaneElement: () => document.createElement("div"),
    },
    "stargantt.timeline": {
      tToX: (t: number) => t,
      xToT: (x: number) => x,
      pxPerMs: 1,
      zoomLevel: mockStore({ id: "day", pxPerDay: 24, scales: [] }),
      requestOriginExtension: () => {},
      releaseOriginExtension: () => {},
    },
    "stargantt.theme": { get: () => "" },
  });
  const treeGrid = provider("stargantt.tree-grid", {
    "stargantt.rows": rowsOf({ order: rowOrder }),
    "stargantt.grid": { setSelected: () => {} },
  });
  const taskBars = provider("stargantt.task-bars", {
    // `barRect` is read by the tooltip feature's focus-follow (§6.4a), which every composition here
    // carries (tooltip is one of the four preset-bundled groups — always wired, §6): once the
    // post-paste focus move (this file's fake `stargantt.focus.focus()`) publishes to the real
    // `FocusState` store, tooltip's own `lifecycle/ready` subscription reacts to it. `undefined`
    // here (no bar geometry known) is exactly what a composition with hidden/off-screen rows
    // reports, and keeps the focus-follow a safe no-op (it dismisses instead of showing).
    "stargantt.task-bars": {
      barBoxOf: () => undefined,
      visibleBoxes: () => [],
      hasOwnBar: () => false,
      barRect: () => undefined,
    },
  });

  // Subscribes inside its own `setup()` (tier 0, before `interaction` and `dataStore` — both depend
  // on nothing else composed here except each other transitively) so no fault/transaction raised
  // during another plugin's own `setup()` is missed the way a post-hoc `host.host.on(...)` would be.
  let bindings: { get(): KeyBindingProbe[] } | undefined;
  const recorder: AnyPlugin = {
    meta: { id: "test.recorder" },
    setup(ctx): void {
      ctx.on("core/pluginError", (e) => faults.push(e.error));
      ctx.on("data/didApplyTransaction", (e) => transactions.push(e.transaction));
    },
  };

  // docs/specs/plugins/a11y.md `FocusService` — `state` (a `Store<{ focused?: TaskId }>`), `focus(id)`,
  // `announce(message)`. The mutable store lets `focus(id)` calls (e.g. clipboard's post-paste focus
  // move) be observed back through `focused()` below, exactly like the real service.
  const focusState = mockStore<{ focused: TaskId | undefined }>({ focused: options.focused });

  const plugins: AnyPlugin[] = [recorder, store, view, treeGrid, taskBars, interaction(options.config)];
  if (options.a11y !== false) {
    const a11y: AnyPlugin = {
      meta: { id: "stargantt.a11y" },
      setup(ctx): void {
        ctx.provide("stargantt.focus" as never, {
          state: focusState,
          focus: (id: TaskId) => focusState.set({ focused: id }),
          announce: (text: string) => spoken.push(text),
        } as never);
        bindings = (
          ctx.defineExtensionPoint as unknown as (
            key: string,
            reduce: (inputs: KeyBindingProbe[]) => KeyBindingProbe[],
          ) => { get(): KeyBindingProbe[] }
        )("keys/bindings", (inputs) => inputs);
      },
    };
    plugins.push(a11y);
  }

  const root = document.createElement("div");
  const host = createTestHost({ plugins, element: root });
  const data = host.host.service("stargantt.data");
  if (options.tasks !== undefined && options.tasks.length > 0) data.load([...options.tasks]);

  // Dispatched on `target` (defaulting to `root` itself) with `bubbles: true`, so a real
  // `dispatchEvent` sets `event.target` to whatever originated it — `root`, or a descendant
  // text-entry element for the text-entry guard tests — and lets it bubble up to the `wireClipboard`
  // listener on `root`, exactly like a genuine browser copy/paste. `clipboardData` has no accessor
  // on a plain `Event`, so `Object.defineProperty` adds it directly, which is exactly what a real
  // `ClipboardEvent` does.
  function fireCopy(target: HTMLElement = root): string | undefined {
    let written: string | undefined;
    const event = new Event("copy", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", {
      value: { setData: (_t: string, v: string) => (written = v) },
      configurable: true,
    });
    target.dispatchEvent(event);
    return written;
  }

  function firePaste(text: string, target: HTMLElement = root): boolean {
    const event = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", {
      value: { getData: () => text },
      configurable: true,
    });
    return target.dispatchEvent(event);
  }

  return {
    ctx: host.ctxOf("stargantt.interaction"),
    host,
    data,
    root,
    transactions,
    spoken,
    faults,
    keys: () => bindings?.get() ?? [],
    focused: () => focusState.get().focused,
    fireCopy,
    firePaste,
  };
}
