// docs/specs/plugins/a11y.md
/**
 * Public types of `@stargantt/plugin-a11y`, plus the plugin's single
 * `declare module "@stargantt/core"` block (architecture.md chapter 1.4: one declaration site per
 * plugin).
 *
 * They live here rather than in `index.ts` so the internal modules can import them without a cycle
 * through the package entry.
 */
import type { ExtensionPointDecl, Store } from "@stargantt/core";
import type { TaskId } from "@stargantt/plugin-data-store";

/* ------------------------------------------------------------------ *
 * The focus service
 * ------------------------------------------------------------------ */

// docs/specs/plugins/a11y.md § Service
/**
 * The whole of the keyboard focus's observable state.
 *
 * Row-only: the mirror puts exactly one `gridcell` in each row, so there is no cell to focus and
 * nothing else to report.
 */
export interface FocusState {
  /** The focused task, or `undefined` when no row holds the focus. */
  readonly focused: TaskId | undefined;
}

// docs/specs/plugins/a11y.md § Service
/**
 * Reads and moves the roving keyboard focus, and speaks messages to screen-reader users.
 *
 * Obtained with `gantt.service("stargantt.focus")` from application code, or
 * `ctx.use("stargantt.focus")` from a plugin that declares `stargantt.a11y` as a dependency.
 *
 * The state is set only on an **effective** placement — a keyboard move, a pointer-follow, or a
 * `focus(id)` call that changed the focused task. The initial row-0 tabindex fallback the roving
 * focus always rests on is not a placement and sets nothing.
 */
export interface FocusService {
  /** The focused row. Subscribe for every effective placement; the value is a snapshot. */
  readonly state: Store<FocusState>;
  /**
   * Places the roving focus on the task's row. Ignored for an unknown id and for a hidden
   * (zero-height) row, exactly like an unknown id. Scrolls the row fully into view by the minimum
   * amount.
   */
  focus(id: TaskId): void;
  /**
   * Writes the message to the polite aria-live region.
   *
   * Known limitation: identical consecutive messages are not re-announced (the region speaks on
   * content change); callers vary the text if every occurrence must be spoken.
   */
  announce(message: string): void;
}

/* ------------------------------------------------------------------ *
 * The `keys/bindings` extension point
 * ------------------------------------------------------------------ */

// docs/specs/plugins/a11y.md § Extension points
/**
 * A keyboard shortcut contributed to the `keys/bindings` extension point.
 *
 * `key` names the chord as modifiers joined to a key by `+` — `"ArrowDown"`, `"Ctrl+Z"`,
 * `"Ctrl+Shift+Z"`, `"+"`. Modifier names (`Ctrl` — alias `Control` —, `Alt`, `Shift`, `Meta`) are
 * case-insensitive and may appear in any order. Single-character keys are matched
 * case-insensitively; for punctuation such as `"+"`, whose character already implies the shift key
 * on many layouts, the shift state is ignored unless the binding names `Shift` itself.
 *
 * Of all contributions naming the same canonical chord only the **last** registered runs, so a
 * plugin registered after another can replace its shortcut — including any of this plugin's own
 * defaults, which go through the point like anybody else's. Independently of all of this, no
 * binding ever runs while the keyboard focus sits on an `input`, a `textarea`, or an element inside
 * a `contenteditable` region, nor while it sits on a grid `columnheader`, nor for a keystroke
 * another handler has already claimed (`defaultPrevented`).
 */
export interface KeyBinding {
  key: string;
  run(): void;
  /**
   * Shown beside the chord in the shortcut-help dialog; undescribed bindings work but are not
   * listed, which is the right choice for internal aliases. Contributor-owned prose, in whatever
   * language the contributor writes it — not a catalog member.
   */
  description?: string;
  /**
   * Evaluated at dispatch time, after the chord already matches. Returning `false` skips this
   * binding — the scan continues, so an earlier contribution of the same chord still gets its
   * chance — without the binding being removed from the point. Absent means always active; a
   * `when` that throws is guarded (reported as `core/pluginError`) and treated as `false`.
   */
  when?(): boolean;
}

/* ------------------------------------------------------------------ *
 * Messages
 * ------------------------------------------------------------------ */

// docs/specs/plugins/a11y.md § Messages
/**
 * The task fields a row's spoken text is built from.
 *
 * `start` and `end` are epoch-millisecond instants, and `end` is exclusive; nothing here is
 * pre-formatted, so a builder is free to render them with `Intl` and the chart's locale.
 */
export interface RowTextParts {
  name: string;
  /** Task start, epoch ms. */
  start: number;
  /** Task end (exclusive), epoch ms. */
  end: number;
  /** Completion 0..1, absent when the task carries none. */
  progress?: number;
}

// docs/specs/plugins/a11y.md § Messages — 12 keys, all builders.
/**
 * The text a screen reader receives from this plugin.
 *
 * Every member is a builder, because every one of these strings embeds a value: the plugin supplies
 * the data and the wording — word order, separators, pluralization — belongs entirely to the host.
 * Dates render as ISO calendar days (UTC) regardless of locale; hosts localize inside their own
 * builders.
 */
export interface A11yMessages {
  /**
   * The accessible text of one mirrored row. Defaults to the name, then the period as
   * `"<start> – <end>"` (ISO days, UTC, around an en dash with spaces), then — only when
   * `progress` is present — the completion as a whole-percent string, all joined with `", "`.
   */
  rowText: (parts: RowTextParts) => string;
  /**
   * Announced when the focused row was expanded. `name` is absent when the store does not know the
   * toggled task. Defaults to `"<name>, expanded"`, or `"expanded"` without a name.
   */
  rowExpanded: (name: string | undefined) => string;
  /**
   * Announced when the focused row was collapsed. `name` is absent when the store does not know the
   * toggled task. Defaults to `"<name>, collapsed"`, or `"collapsed"` without a name.
   */
  rowCollapsed: (name: string | undefined) => string;
  /**
   * Announced after a keyboard selection chord effectively changed the selection. `count` is the
   * size of the resulting selection. Defaults to `"<count> selected"`.
   */
  selectionCount: (count: number) => string;
  /**
   * Announced after a header sort cycle step changed the sort state. `header` is the column's
   * visible label; `direction` is `"ascending"`, `"descending"`, or `null` when the cycle turned
   * sorting off. Defaults to `"<header>, sorted <direction>"`, or `"<header>, sort off"`.
   */
  sortChanged: (input: { header: string; direction: "ascending" | "descending" | null }) => string;
  /**
   * Announced after a keyboard-initiated inline edit committed. `name` is the edited task's name
   * after the commit, absent when the store no longer knows the task. Defaults to
   * `"<name>, updated"`, or `"updated"` without a name.
   */
  editCommitted: (name: string | undefined) => string;
  /**
   * The dependency description attached to a mirrored row (via `aria-describedby`) while the
   * dependency read-out is enabled. Defaults to `"Depends on: <names>"` and `"Blocks: <names>"`
   * (names joined with `", "`), the two segments joined with `". "`; an empty segment is left out.
   */
  rowDependencies: (parts: { predecessors: string[]; successors: string[] }) => string;
  /** The accessible name and visible heading of the shortcut-help dialog. Default `"Keyboard shortcuts"`. */
  shortcutHelpTitle: () => string;
  /** The accessible name of the shortcut-help dialog's close button. Default `"Close"`. */
  shortcutHelpClose: () => string;
  /**
   * Announced after a keyboard zoom step changed the timeline zoom level. `level` is the id of the
   * level now in force (`"day"`, `"week"`, …). Defaults to `"Zoom: <level>"`.
   */
  zoomChanged: (level: string) => string;
  /**
   * The caption of the screen-reader summary table. `total` is the number of tasks in the store and
   * `shown` how many of them the table holds (it is capped for very large charts). Defaults to
   * `"Gantt chart summary, <total> tasks"`, or `"Gantt chart summary, first <shown> of <total>
   * tasks"` when capped.
   */
  summaryTitle: (parts: { total: number; shown: number }) => string;
  /**
   * One column header of the screen-reader summary table. Defaults to `"Name"`, `"Start"`, `"End"`
   * and `"Progress"` for the four keys.
   */
  summaryHeader: (column: "name" | "start" | "end" | "progress") => string;
}

/* ------------------------------------------------------------------ *
 * Config
 * ------------------------------------------------------------------ */

// docs/specs/plugins/a11y.md § Config — 7 fields; an unusable value falls back to its default.
/** Options of the accessibility plugin. */
export interface A11yConfig {
  /**
   * The accessible name announced for the chart's row grid.
   *
   * Becomes the `aria-label` of the `role="treegrid"` element, so a page holding several widgets
   * can tell them apart. Defaults to `"Gantt chart"`. An empty or blank string is ignored and the
   * default used, since a nameless grid is announced as a bare "treegrid". Applied when the mirror
   * is created and never re-read.
   */
  label?: string;
  /**
   * Replacement screen-reader text, one key at a time.
   *
   * A key left out keeps its English default, and a key whose value is not a function is ignored.
   * A builder that throws is reported as a plugin error and the built-in default answers that one
   * call. The grid's accessible name is not part of this catalog — it is `label` above.
   */
  messages?: Partial<A11yMessages>;
  /**
   * Whether moving the keyboard focus also replaces the selection. Defaults to `true`: arrowing
   * through rows (or calling `FocusService.focus`) selects the focused task, so a chart with no
   * other visual distinction between focus and selection still shows where the focus is. Set to
   * `false` and focus moves on its own, drawn as its own stroke-only box.
   *
   * Without a composed `stargantt.selection` there is nothing to sync and this option has no
   * effect either way.
   */
  syncSelection?: boolean;
  /**
   * Whether each mirrored row also describes its task's dependencies to a screen reader, through
   * an `aria-describedby` node naming its predecessors and successors. Defaults to `false`; with
   * it off the mirror's DOM is byte-identical to the pre-feature output.
   */
  describeDependencies?: boolean;
  /**
   * Whether `?` opens a dialog listing the chart's current keyboard shortcuts. Defaults to
   * `false`. While the dialog is open no chart shortcut runs, and `Tab` / `Shift`+`Tab` cycle the
   * dialog's own focus ring so the close button is reachable without a pointer.
   */
  shortcutHelp?: boolean;
  /**
   * Whether the timeline zoom level can be stepped from the keyboard with plain `+` / `-`.
   * Defaults to `false`. The chords are never `Ctrl`+`±`, so the browser's own page zoom keeps
   * working; while this is on they shadow the `+` / `-` expand-collapse aliases, which stay
   * available on `ArrowRight` / `ArrowLeft`.
   */
  zoomKeys?: boolean;
  /**
   * Whether `Ctrl`+`Alt`+`S` builds — on demand only — a visually hidden table of every task, so a
   * screen-reader user can survey the whole chart with the reader's own table commands. Defaults to
   * `false`. Very large charts are capped at the first 1000 tasks, which the caption states.
   */
  summaryTable?: boolean;
}

/* ------------------------------------------------------------------ *
 * Declaration merging
 * ------------------------------------------------------------------ */

declare module "@stargantt/core" {
  interface Services {
    // docs/specs/plugins/a11y.md § Service
    "stargantt.focus": FocusService;
  }
  interface ExtensionPoints {
    // docs/specs/plugins/a11y.md § Extension points — collect, last wins.
    "keys/bindings": ExtensionPointDecl<KeyBinding, KeyBinding[]>;
  }
}
