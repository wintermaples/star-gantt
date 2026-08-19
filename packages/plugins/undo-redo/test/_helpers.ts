import { Gantt, definePlugin } from "@stargantt/core";
import type { AnyPlugin, GanttInstance } from "@stargantt/core";
import { dataStore } from "@stargantt/plugin-data-store";
import type {
  Assignment,
  DataService,
  Link,
  Patch,
  Resource,
  Task,
  TaskId,
  Transaction,
} from "@stargantt/plugin-data-store";
import { undoRedo } from "../src/index";
import type { HistoryService, UndoRedoConfig } from "../src/types";

/** The core references `HTMLElement` as a type only, so a plain object is enough under node. */
export const fakeRoot = (): HTMLElement => ({}) as unknown as HTMLElement;

export interface Harness {
  gantt: GanttInstance;
  data: DataService;
  history: HistoryService;
}

export function start(
  config?: UndoRedoConfig,
  extra: readonly AnyPlugin[] = [],
  before: readonly AnyPlugin[] = [],
): Harness {
  const gantt = Gantt.create({
    element: fakeRoot(),
    plugins: [...before, dataStore(), undoRedo(config), ...extra],
  });
  return {
    gantt,
    data: gantt.service("stargantt.data"),
    history: gantt.service("stargantt.history"),
  };
}

export function makeTask(id: TaskId, over: Partial<Task> = {}): Task {
  return { id, parentId: null, name: `task ${String(id)}`, start: 0, end: 10, ...over };
}

/** Order-insensitive snapshot of the store's observable content. */
export function snapshot(data: DataService): string {
  const json = data.toJSON();
  const byId = (a: { id: unknown }, b: { id: unknown }): number =>
    String(a.id) < String(b.id) ? -1 : 1;
  return JSON.stringify({
    tasks: [...json.tasks].sort(byId),
    links: [...json.links].sort(byId),
  });
}

export function tx(over: Partial<Transaction> = {}): Transaction {
  return {
    id: "t1",
    label: "Transaction",
    patches: [{ op: "task/add", task: makeTask("a") }],
    origin: "user",
    ...over,
  };
}

export function updatePatch(id: TaskId, before: Partial<Task>, after: Partial<Task>): Patch {
  return { op: "task/update", id, before, after };
}

// docs/specs/plugins/data-store.md "Services" — thin convenience wrappers around the
// `links`/`resources`/`assignments` store properties, iterated to a plain array.
export function allLinks(data: DataService): Link[] {
  return [...data.links.get().values()];
}

export function allResources(data: DataService): Resource[] {
  return [...data.resources.get().values()];
}

export function allAssignments(data: DataService): Assignment[] {
  return [...data.assignments.get().values()].flat();
}

/**
 * A plugin with no dependency on data-store that unconditionally cancels every transaction from
 * the will phase. Meant to be listed in `start()`'s `before` array — i.e. registered, and so set
 * up, *before* `dataStore()`/`undoRedo()` — to prove that undo-redo's recording (which now
 * consumes only the post-apply `data/didApplyTransaction` settle signal, never
 * `data/willApplyTransaction`) never records a cancelled transaction regardless of which handler
 * cancelled it or when that handler was registered relative to undo-redo itself
 * (docs/specs/plugins/undo-redo.md "Recording").
 */
export function cancelerPlugin(): AnyPlugin {
  return definePlugin<void>({
    meta: { id: "test.canceler" },
    setup(ctx) {
      ctx.on("data/willApplyTransaction", (e) => {
        e.preventDefault();
      });
    },
  });
}

/**
 * A stand-in for the a11y plugin's `stargantt.focus` service: pushes every announced message onto
 * `spoken`. Registered under the a11y plugin id (`stargantt.a11y`) so `undoRedo()`'s declared
 * `optional: ["stargantt.a11y"]` soft dependency resolves it (docs/specs/plugins/undo-redo.md
 * "Dependencies").
 */
export function focusStub(spoken: string[]): AnyPlugin {
  return definePlugin<void>({
    meta: { id: "stargantt.a11y" },
    setup(ctx) {
      (ctx.provide as unknown as (key: string, impl: unknown) => void)("stargantt.focus", {
        announce(message: string): void {
          spoken.push(message);
        },
      });
    },
  });
}

/** One row per `keys/bindings` contribution, as the a11y plugin's own extension point would see. */
export interface KeyBindingLike {
  key: string;
  run(): void;
}

/**
 * A stand-in for the a11y plugin's `keys/bindings` extension point (docs/specs/plugins/a11y.md
 * "Defined: keys/bindings"): declares the point with the `collect` strategy (contribution order,
 * no last-wins folding — that merge policy is a11y's own concern, not undo-redo's) and exposes the
 * accumulated bindings.
 */
export function bindingsCollector(): { plugin: AnyPlugin; bindings(): KeyBindingLike[] } {
  let get: (() => KeyBindingLike[]) | undefined;
  const plugin = definePlugin<void>({
    meta: { id: "stargantt.a11y" },
    setup(ctx) {
      const point = (
        ctx.defineExtensionPoint as unknown as (
          key: string,
          reduce: (inputs: KeyBindingLike[]) => KeyBindingLike[],
        ) => { get(): KeyBindingLike[] }
      )("keys/bindings", (inputs) => [...inputs]);
      get = () => point.get();
    },
  });
  return { plugin, bindings: () => get?.() ?? [] };
}
