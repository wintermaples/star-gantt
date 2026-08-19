// docs/specs/plugins/interaction.md §5 / §10 — the two seams whose owner is the a11y plugin
// (`stargantt.a11y`, same layer).
//
// Contributing to a point and reading a service the owner declares in its own package is the
// established pattern of this repository (`packages/plugins/task-bars/src/internal/deps.ts`'s
// `RowsReader`, mirroring tree-grid's `stargantt.rows`): the *shape* is declared here as a
// hand-maintained structural mirror instead of imported, and only the key is passed through one
// narrow cast.
//
// Why a mirror instead of `import type { FocusService } from "@stargantt/plugin-a11y"`: a11y
// already type-imports THIS package (it contributes to interaction-owned surfaces), so a devDep
// edge in the other direction would recreate the task-bars<->tree-grid build cycle that must
// stay ruled out.
// `FocusChannel` below is kept in MANUAL SYNC with `FocusService` as specified in
// docs/specs/plugins/a11y.md ("### `stargantt.focus` -> `FocusService`") — `state` (a
// `Store<{ focused?: TaskId }>`), `focus(id)`, `announce(message)`. A change to that shape on the
// a11y side is a breaking change here too and must be mirrored by hand.
import type { PluginContext, Store } from "@stargantt/core";
import type { TaskId } from "@stargantt/plugin-data-store";

/**
 * One chord contributed to the a11y plugin's `keys/bindings` point.
 *
 * The core buffers a contribution whose point has no owner yet, so a composition without the a11y
 * plugin simply never delivers these — the chords stay buffered and inert.
 */
export interface KeyBinding {
  /** The chord string, e.g. `"Ctrl+Shift+ArrowRight"`. */
  key: string;
  /** Runs the chord's action. */
  run(): void;
  /** Whether the chord currently applies; a chord without one always applies. */
  when?(): boolean;
}

/** Contributes one key binding to the point the a11y plugin owns. */
export function contributeKeyBinding(ctx: PluginContext, binding: KeyBinding): void {
  // Called as a method so the context keeps its receiver; only the key is widened.
  ctx.contribute("keys/bindings" as never, binding as never);
}

/** The whole of `stargantt.focus`'s observable state (docs/specs/plugins/a11y.md `FocusState`). */
export interface FocusState {
  /** The task the keyboard focus is on, or `undefined` when it is on none. */
  readonly focused: TaskId | undefined;
}

/**
 * The keyboard-focus channel the a11y plugin publishes as `stargantt.focus` — a hand-maintained
 * structural mirror of `FocusService` (see the module doc above for why it is not imported).
 */
export interface FocusChannel {
  /** The focused-task store. Subscribe for every effective placement. */
  readonly state: Store<FocusState>;
  /** Places the roving focus on the task's row; ignored for an unknown or hidden-row id. */
  focus(id: TaskId): void;
  /** Speaks one message through the chart's live region. */
  announce(text: string): void;
}

/**
 * The focus channel, resolved late and admitted structurally, or `undefined` when no usable service
 * is composed.
 *
 * Late, because the a11y plugin starts after this one: the lookup happens at use time, never at
 * `setup()`. Structural, because the service's authoritative declaration belongs to its own package
 * — a contribution missing any required member leaves the keyboard announcements silent instead of
 * throwing.
 */
export function focusChannel(ctx: PluginContext): () => FocusChannel | undefined {
  let resolved: FocusChannel | undefined;
  return () => {
    if (resolved !== undefined) return resolved;
    const service: unknown = ctx.useOptional("stargantt.focus" as never);
    if (typeof service !== "object" || service === null) return undefined;
    const candidate = service as Partial<Record<keyof FocusChannel, unknown>>;
    if (
      typeof candidate.state !== "object" ||
      candidate.state === null ||
      typeof (candidate.state as Partial<Store<unknown>>).get !== "function" ||
      typeof (candidate.state as Partial<Store<unknown>>).subscribe !== "function" ||
      typeof candidate.focus !== "function" ||
      typeof candidate.announce !== "function"
    ) {
      return undefined;
    }
    resolved = service as FocusChannel;
    return resolved;
  };
}
