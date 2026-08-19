/**
 * `@stargantt/plugin-undo-redo` — id `stargantt.undo-redo`.
 *
 * `dependsOn: ["stargantt.data-store"]`, optionally `stargantt.a11y`. Provides `stargantt.history`,
 * registers `history/undo` and `history/redo`, contributes to `keys/bindings`
 * (docs/specs/plugins/undo-redo.md "Extension points" / "Config"). When a focus owner is present
 * the outcome of a step is spoken through it.
 *
 * Pure logic: no DOM, no canvas, no timers.
 */
import { createStore, definePlugin } from "@stargantt/core";
import type { Plugin, PluginContext, WritableStore } from "@stargantt/core";
import { REPLAY_ORIGIN, invertPatch } from "./apply";
import { DEFAULT_LIMIT, History } from "./history";
import type { HistoryService, HistoryState, UndoRedoConfig, UndoRedoMessages } from "./types";
// Type-only: brings `@stargantt/plugin-data-store`'s declaration merging (the `task/*` commands,
// the `history/apply` batch-replay command, and the `data/didApplyTransaction` settle signal) into
// the program without adding a second runtime dependency beyond the one `apply.ts` already creates
// by re-exporting `invertPatch`.
import type { Patch } from "@stargantt/plugin-data-store";
// Type-only: brings `@stargantt/plugin-a11y`'s declaration merging (the `stargantt.focus` service
// and the `keys/bindings` extension point) into the program the same way, without adding a second
// runtime dependency — erased at emit, same as the `data-store` import above.
import type { FocusService, KeyBinding } from "@stargantt/plugin-a11y";

export type {
  HistoryEntry,
  HistoryService,
  HistorySnapshot,
  HistoryState,
  UndoRedoConfig,
  UndoRedoMessages,
} from "./types";

declare module "@stargantt/core" {
  interface Services {
    "stargantt.history": HistoryService;
  }
  interface Commands {
    "history/undo": void; // docs/specs/plugins/undo-redo.md "Commands"
    "history/redo": void; // docs/specs/plugins/undo-redo.md "Commands"
  }
}

/*
 * `keys/bindings` (an extension point) and `stargantt.focus` (a service) are both owned by the
 * a11y plugin (docs/specs/plugins/a11y.md), which this plugin only ever touches optionally and
 * late — `stargantt.a11y` is `optional`, never `dependsOn`, below, and both calls stay
 * buffered/inert exactly as documented when a11y is absent from the composition. Both
 * helpers are thin wrappers around the public `ctx.contribute` / `ctx.useOptional` methods, typed
 * against a11y's own `KeyBinding` / `FocusService` (imported type-only above): no cast is
 * needed once that module augmentation is in the program, since `keys/bindings` and
 * `stargantt.focus` are then real members of `ExtensionPoints`/`Services` rather than unknown
 * string keys.
 */
function contributeKeyBinding(ctx: PluginContext, binding: KeyBinding): void {
  ctx.contribute("keys/bindings", binding);
}

function useOptionalFocus(ctx: PluginContext): FocusService | undefined {
  return ctx.useOptional("stargantt.focus");
}

// docs/specs/plugins/undo-redo.md "Config" — `keys/bindings` has the shape
// `{ key: string; run(): void }` but specifies no key-string syntax and no default chords for
// undo/redo; the a11y plugin owns the matching. These are the conventional chords of both platform
// families, written in the plainest `Modifier+KEY` form: `Meta` is the macOS Command key, and
// `Ctrl+Y` is the Windows redo alias.
const DEFAULT_UNDO_KEYS: readonly string[] = ["Ctrl+Z", "Meta+Z"];
const DEFAULT_REDO_KEYS: readonly string[] = ["Ctrl+Shift+Z", "Meta+Shift+Z", "Ctrl+Y"];

/**
 * The configured chord list for one operation, or its default when none was configured.
 *
 * A given array replaces the default in full — including the empty array, which leaves the
 * operation without any chord.
 */
function chordsFor(configured: string[] | undefined, fallback: readonly string[]): readonly string[] {
  return Array.isArray(configured) ? configured : fallback;
}

// docs/specs/plugins/undo-redo.md "Config" — a limit that is not a positive finite integer is
// ignored, so the default stands.
function limitFor(configured: number | undefined): number {
  return typeof configured === "number" && Number.isInteger(configured) && configured > 0
    ? configured
    : DEFAULT_LIMIT;
}

// docs/specs/plugins/undo-redo.md "Messages" — the wording is a replaceable catalog; these are its
// built-in English defaults, and omitting `messages` reproduces them byte for byte.
/** Spoken after a history step actually replayed something. */
const DEFAULT_MESSAGES: UndoRedoMessages = {
  undone: "Undone",
  redone: "Redone",
};

// "Uniform message-catalog convention" (per data-store.md / undo-redo.md "Config") — per-key
// shallow override, and a member that is not a string is unusable and leaves its default in
// place. Both members are plain strings, so no builder guarding is needed here.
function resolveMessages(overrides: Partial<UndoRedoMessages> | undefined): UndoRedoMessages {
  return {
    undone: typeof overrides?.undone === "string" ? overrides.undone : DEFAULT_MESSAGES.undone,
    redone: typeof overrides?.redone === "string" ? overrides.redone : DEFAULT_MESSAGES.redone,
  };
}

/**
 * Creates the undo/redo plugin: it records every applied transaction and replays it in reverse on
 * undo, forward again on redo.
 *
 * With no argument it keeps 200 steps and binds the platform-conventional chords — `Ctrl+Z` and
 * `Meta+Z` for undo, `Ctrl+Shift+Z`, `Meta+Shift+Z` and `Ctrl+Y` for redo.
 */
export function undoRedo(config: UndoRedoConfig = {}): Plugin<void> {
  // Configurable plugins are exported as factories because the host passes no per-plugin config to
  // `setup()`: any configuration is closed over here and the produced plugin itself takes `void`
  // (docs/specs/plugins/undo-redo.md "Config").
  return definePlugin<void>({
    meta: {
      id: "stargantt.undo-redo",
      dependsOn: ["stargantt.data-store"],
      // The a11y plugin's `stargantt.focus` service is used to speak the outcome of an undo/redo
      // step when it is present — a strictly optional, late-resolved lookup (`useOptionalFocus`
      // above).
      optional: ["stargantt.a11y"],
    },

    setup(ctx) {
      // docs/specs/plugins/undo-redo.md "Service" — `HistoryState`. Every stack mutation the
      // `History` class performs (push, merge, undo, redo, clear, limit-eviction, restore) sets
      // this store exactly once.
      const state: WritableStore<HistoryState> = createStore<HistoryState>({
        canUndo: false,
        canRedo: false,
        depth: 0,
      });
      const publishState = (): void => {
        state.set({
          canUndo: history.canUndo(),
          canRedo: history.canRedo(),
          depth: history.undoEntries().length,
        });
      };
      const history = new History(limitFor(config.limit), publishState);
      // Resolved once here, from the config the factory closed over; mutating that object
      // afterwards has no effect (docs/specs/plugins/undo-redo.md "Config").
      const messages = resolveMessages(config.messages);

      // docs/specs/plugins/undo-redo.md "Recording": record directly from the
      // authoritative settle signal data-store fires once per applied transaction, after its own
      // store burst, carrying the *final* patch list — will-phase appends and summary promotion
      // included (docs/specs/plugins/data-store.md "Apply flow"), which is what makes "one undo
      // reverts the user action *and* its automatic follow-on" work. A transaction cancelled in
      // the will phase, one whose atomic apply throws, and an empty-patch no-op never fire the
      // settle signal, so there is nothing to remember and nothing to pair — no pending state, no
      // wrapper. (Superseded design note: an earlier version of this plugin paired
      // `data/willApplyTransaction` with the `tasks` store burst itself; that pairing was unsound
      // under cancellation by an earlier-registered handler, a throwing apply, and nested dispatch
      // from a will-handler — the settle signal closes all three, so `data/willApplyTransaction`
      // is not consumed here at all.) Nested dispatches settle inner-first, so a will-handler's own
      // nested command is recorded *before* the outer transaction that triggered it.
      ctx.on("data/didApplyTransaction", (e) => {
        const tx = e.transaction;
        if (tx.patches.length === 0) return;
        // A replayed step is recognized by its cause — the `REPLAY_ORIGIN` every undo/redo
        // dispatch carries — never by a "currently replaying" flag: a flag would also swallow a
        // *foreign* transaction some other plugin dispatches synchronously while a replay runs,
        // which is new history and must be recorded.
        if (tx.origin === REPLAY_ORIGIN) return;
        history.record(tx);
      });

      // docs/specs/plugins/undo-redo.md "Replay" / a11y.md "Announcements" — `stargantt.focus` is
      // provided by the a11y plugin, which may start *after* this one, so the service cannot be
      // resolved during `setup()`; the lookup is deferred to the moment an announcement is made. A
      // composition without the a11y plugin simply announces nothing. The empty string suppresses
      // the announcement entirely: the live region is left untouched for that step instead of
      // being cleared with blank text.
      const announce = (message: string): void => {
        if (message === "") return;
        useOptionalFocus(ctx)?.announce(message);
      };

      const service: HistoryService = {
        state,
        // docs/specs/plugins/data-store.md — one `history/apply` dispatch
        // per step, not one command per patch: the whole entry replays as a single transaction, so
        // a large entry costs one atomic apply and one `tasks` burst instead of N of each.
        undo() {
          const entry = history.popUndo();
          if (entry === undefined) return;
          // Reverse order: a patch list is undone last-applied-first. Push-compact rather than a
          // pre-sized array: a sparse `patches` entry (an `undefined` hole) must not leave a hole
          // in `inverted` too, which `history/apply` would choke on mid-transaction.
          const patches = entry.patches;
          const inverted: Patch[] = [];
          for (let i = patches.length - 1; i >= 0; i--) {
            const patch = patches[i];
            if (patch !== undefined) inverted.push(invertPatch(patch));
          }
          ctx.dispatch("history/apply", { patches: inverted, origin: REPLAY_ORIGIN });
          announce(messages.undone);
        },
        redo() {
          const entry = history.popRedo();
          if (entry === undefined) return;
          ctx.dispatch("history/apply", { patches: [...entry.patches], origin: REPLAY_ORIGIN });
          announce(messages.redone);
        },
        clear() {
          history.clear();
        },
        peekUndo() {
          return history.peekUndo();
        },
        peekRedo() {
          return history.peekRedo();
        },
        undoLabels() {
          return history.undoLabels();
        },
        redoLabels() {
          return history.redoLabels();
        },
        serialize() {
          return history.serialize();
        },
        // A successful restore routes through `History.restore()`, whose own `_onChange()` call is
        // what publishes the store; nothing here sets it a second time.
        restore(snapshot) {
          return history.restore(snapshot);
        },
      };

      ctx.provide("stargantt.history", service);

      ctx.registerCommand("history/undo", () => {
        service.undo();
      });
      ctx.registerCommand("history/redo", () => {
        service.redo();
      });

      // `keys/bindings` is defined by the a11y plugin, which starts *after*
      // `undo-redo`; the core buffers a contribution made before its point is defined. Without
      // that plugin in the composition the chords simply do not exist and the commands stay
      // reachable.
      for (const key of chordsFor(config.keys?.undo, DEFAULT_UNDO_KEYS)) {
        contributeKeyBinding(ctx, {
          key,
          run: () => {
            service.undo();
          },
        });
      }
      for (const key of chordsFor(config.keys?.redo, DEFAULT_REDO_KEYS)) {
        contributeKeyBinding(ctx, {
          key,
          run: () => {
            service.redo();
          },
        });
      }

      // The core owns disposal of everything the plugin holds. Uses `reset()`, not the public
      // `clear()`, so teardown does not set the store against a half-disposed composition.
      ctx.own({
        dispose(): void {
          history.reset();
        },
      });
    },
  });
}
