# Plugin: undo-redo (`stargantt.undo-redo`)

Package: `@stargantt/plugin-undo-redo` — Layer 5.
Status: normative. Design note: undo-redo is an independent plugin, deliberately not absorbed into data-store.

## Purpose

Transaction history: recording applied transactions, reverse-patch replay, gesture coalescing with net-zero compression, snapshot serialize/restore, undo/redo commands and key chords, toolbar-state exposure.

## Service

### `stargantt.history` → `HistoryService`

Store-shaped. Every stack mutation (record, merge, undo, redo, clear, limit eviction, restore) sets the store exactly once.

```ts
export interface HistoryState {
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  /** Depth of the undo stack (0 when nothing is undoable). */
  readonly depth: number;
}

export interface HistoryService {
  readonly state: Store<HistoryState>;
  /** Pops the newest undo entry, dispatches its patches inverted in reverse
   *  order as ONE `history/apply` transaction with origin `"history"`, moves
   *  the entry to the redo stack, and announces `undone`. No-op when empty. */
  undo(): void;
  /** Pops the newest redo entry, re-dispatches its patches verbatim as ONE
   *  `history/apply` transaction with origin `"history"`, moves it back to
   *  the undo stack, and announces `redone`. No-op when empty. */
  redo(): void;
  /** Empties both stacks. */
  clear(): void;
  /** Label of the transaction the next undo() would revert, or undefined. */
  peekUndo(): string | undefined;
  /** Label of the transaction the next redo() would re-apply, or undefined. */
  peekRedo(): string | undefined;
  /** Every undoable label, next-to-revert first. */
  undoLabels(): readonly string[];
  /** Every redoable label, next-to-re-apply first. */
  redoLabels(): readonly string[];
  /** Both stacks as a plain JSON-serializable value (see Snapshot below). */
  serialize(): HistorySnapshot;
  /** Replaces both stacks with a serialize()d value. All-or-nothing: an
   *  unrecognised or malformed snapshot changes nothing and returns false;
   *  a match replaces both stacks in one step (re-applying the configured
   *  limit to the restored undo stack), sets the store once, returns true. */
  restore(snapshot: unknown): boolean;
}
```

Design notes: `depth` always equals `undoLabels().length`. There is deliberately no `bindButtons(targets)` member — toolbar wiring is one line of store subscription, `ctx.own(history.state.subscribe(sync))` (single-channel rule: no second notification path exists for it).

`HistoryEntry` is `{ id, label, patches, coalesceKey? }`, taken from the applied `Transaction` (patch objects shared, arrays copied).

## Recording (normative)

Recording consumes the settle signal the data-store spec fixes (data-store.md "Apply flow"):

1. On `data/didApplyTransaction`, record the event's `transaction` to the history. The event fires exactly once per applied transaction, after its store burst, and carries the final patch list — will-phase appends and summary promotion included — so one undo reverts the user action AND its automatic follow-on.
2. Cancelled transactions, failed applies, and empty-patch no-ops never fire the settle signal, so nothing is remembered and nothing can be committed for them — there is no pending state and no pairing. (Design note: a will-hook + store-burst pairing would be unsound under cancellation by an earlier-registered handler, a throwing apply, and nested dispatch from a will-handler; the settle signal closes all three.) Nested dispatches settle inner-first, so the outer transaction is recorded last and undone first.
3. A transaction with an empty final patch list records nothing.
4. A transaction whose `origin === "history"` (the replay origin) is never recorded — replays are recognized by this cause, never by a "currently replaying" flag, so a foreign transaction dispatched synchronously during a replay is still recorded as new history.
5. Bulk paths (`load()`, `materializeChildren()`) carry no transaction and record nothing.

**Origin sensitivity note.** The only origin-sensitive logic in this plugin is the `"history"` check above. In particular, data-store's custom-field batch-write origin `"stargantt.data-store/setValues"` is never inspected: `setValues` transactions are recorded as ordinary history entries.

### Coalescing and net-zero compression

- `record(tx)` always clears the redo stack (a new user action invalidates redo).
- When the new entry's `coalesceKey` is defined and equals the previous undo entry's, the two merge into a single entry (previous `id` and `label` kept, patch lists concatenated).
- **Net-zero drop:** if the merged patch list has net-zero effect, the merged entry is removed from the stack entirely (a `liveUpdate` drag returning to its origin leaves no history entry). `isNetZero(patches)` rules:
  - An empty list is net-zero.
  - Only update-shaped patches qualify: `task/update`, `link/update`, `resource/update`, `assignment/update`. Any other op → not net-zero.
  - A patch carrying `clears` → not net-zero.
  - A `link/update` whose `before.id !== after.id` → not net-zero (no stable entity key).
  - Per entity (task id / link id / resource id / assignment composite key), each touched field's original value (first `before`, `UNSET` sentinel when absent) is compared with its final value by `Object.is`; every field must round-trip exactly.
- Otherwise the entry is pushed; the undo stack is capped at `limit` by evicting the oldest (`shift`), on push and on redo-return alike.
- One store set per `record` outcome (merge, drop, or push).

### Replay

- `undo()`: patches inverted last-applied-first via the data-store's published `invertPatch` (imported, never re-implemented), sparse holes skipped, dispatched as one `history/apply { patches, origin: "history" }` — one atomic transaction, one store burst.
- `redo()`: the entry's patches verbatim, same single-dispatch rule.
- Announcements: after a completed undo/redo, the message (`undone` / `redone`) is spoken through the optionally resolved `stargantt.focus` service's `announce()`; the empty string suppresses the announcement (live region untouched, not blanked); no a11y plugin → silent.

### Snapshot serialize/restore

- `HistorySnapshot = { version: number; undo: readonly HistoryEntry[]; redo: readonly HistoryEntry[] }` (both stacks oldest-first). Treat as opaque; survives `JSON.stringify`/`parse`.
- `HISTORY_SNAPSHOT_VERSION = 1`. `restore()` validates the whole value before touching anything: wrong shape, wrong version, or ANY malformed entry (per-patch structural validation of every patch variant) → current stacks untouched, `false`. No partial outcome. A successful restore deep-copies entries (entry object + patches array fresh; patch objects shared), re-applies `limit`, sets the store once, returns `true`.
- History is in-memory plugin state; it does not survive instance disposal — serialize/restore is the host's carry-over path across recreation.

## Extension points

None defined. Contributes to `keys/bindings` (defined by the a11y plugin; buffered and inert without it): one binding per configured undo chord and per redo chord.

## Commands

`history/undo`, `history/redo` — payloadless, publicly emittable, exactly `service.undo()` / `service.redo()`. (`history/apply` is provided by data-store.)

## Events

- Consumes `data/didApplyTransaction` (the recording settle signal, §Recording) — the only event edge. `data/willApplyTransaction` is not consumed.
- Emits none of its own: history state is observed via store subscription on `HistoryService`.

## Config

Factory: `undoRedo(config?: UndoRedoConfig)`. All fields optional; unusable values fall back to defaults.

| Field | Type | Default | Semantics |
|---|---|---|---|
| `limit` | `number` | `200` | Undo-stack cap before oldest eviction; non-positive/non-integer/non-finite ignored. |
| `messages` | `Partial<UndoRedoMessages>` | — | Per-key override; non-string ignored; `""` suppresses that announcement entirely. |
| `keys` | `{ undo?: string[]; redo?: string[] }` | `undo: ["Ctrl+Z", "Meta+Z"]`, `redo: ["Ctrl+Shift+Z", "Meta+Shift+Z", "Ctrl+Y"]` | Chord syntax `Modifier+…+Key`, modifiers `Ctrl`/`Alt`/`Shift`/`Meta`, case- and order-insensitive. An array REPLACES its default entirely; `[]` leaves that operation chordless (commands stay available). |

## Messages

`UndoRedoMessages` — 2 keys:

| Key | Default |
|---|---|
| `undone` | `"Undone"` |
| `redone` | `"Redone"` |

## Internal modules

`history.ts` (stacks, coalescing, limit — pure, hostless), `apply.ts` (replay origin constant; re-export of data-store's `invertPatch`), `internal/net-zero.ts`, `internal/snapshot-validation.ts`, `types.ts`, `index.ts` (wiring only).

## Dependencies

hard: `data` (the `data/didApplyTransaction` settle signal; `history/apply` dispatch; `invertPatch` import). optional: `focus` announcements via `ctx.useOptional` at call time (the a11y plugin starts later — late resolution).

## Third-party surface

- **Consumable services:** `stargantt.history` (`HistoryService`) — history state store plus the replay/introspection/snapshot members above.
- **Contributable extension points:** none defined by this plugin.
- **Subscribable events:** none of its own; history state is observed via store subscription.
- **Commands:** `history/undo` / `history/redo` are publicly emittable; third-party mutations made through data commands participate in undo automatically (command → reversible patch), and a third-party command that stamps a `coalesceKey` coalesces exactly like a drag.
- **Reserved namespaces (documentation convention only):** the `history/` command namespace and the `stargantt.history` service ID; the `"history"` transaction origin is reserved for replays. Not enforced in core.
- **Hardening:** `restore()` treats its argument as fully untrusted (full structural validation, all-or-nothing); snapshots handed out are fresh copies so callers cannot grow or reorder the live stacks.
