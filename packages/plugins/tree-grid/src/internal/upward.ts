// docs/specs/plugins/tree-grid.md § Extension points — the points this plugin contributes to that
// are owned by higher layers. Contributing upward is the sanctioned direction (architecture.md
// §5), and a type-only import of the owning package is allowed with it: the bar types and the
// `taskbars/*` keys below come straight from their owner, erased at emit, so no runtime dependency
// is added.
//
// `sidepanel/fields` is the exception, and PERMANENTLY so: `SidePanelFieldContribution`/
// `SidePanelFieldHandle` below stay a structural (duck-typed) declaration; do NOT replace them
// with `import type { … } from "@stargantt/plugin-interaction"`, even though that package exists
// now and exports the same two names. `@stargantt/plugin-interaction`'s own `package.json`
// already carries `@stargantt/plugin-tree-grid` as a `devDependency` (several of its `internal/*`
// modules type-import `RowsService`/`TimelineService`/etc. from this package); adding the reverse
// edge here would close a real 2-cycle in the pnpm workspace's devDependency graph — the same
// shape as the documented `task-bars`⇄`tree-grid` cycle — that makes `vite build`/`tsc` race
// under concurrent workspace builds. (Note: this is a *workspace build-graph* concern, not a
// `lint:arch` one — `tools/lint-deps.mjs` exempts type-only imports from its layer check
// entirely, so the two are not in tension; the risk is purely the pnpm build-order race.) Until
// the cycle is broken (dropping one side's dev-only type import, hoisting the shared type to a
// third location, or serializing this pair in the root build script), this file's own declaration
// is the interface.
//
// Manual-sync obligation: keep `SidePanelFieldContribution`/`SidePanelFieldHandle` below
// byte-identical (modulo comments) to their canonical definitions in
// `packages/plugins/interaction/src/types.ts` (re-exported from `interaction`'s public surface via
// `src/index.ts`). A change to either side without the other silently drifts the two packages'
// notion of a side-panel field contribution apart.
//
// The core buffers a contribution whose point has no owner yet, so a composition without task-bars
// or a side panel simply never sees these.
import type { PluginContext } from "@stargantt/core";
import type { Task } from "@stargantt/plugin-data-store";

export type {
  BarBox,
  BarOverlayRenderer,
  BarStyle,
  BarStyleProvider,
} from "@stargantt/plugin-task-bars";

/** A section a side-panel field contribution keeps up to date inside the detail pane. */
export interface SidePanelFieldHandle {
  /**
   * Called on every panel refresh with the tasks currently selected, in selection order, and with
   * an empty array when nothing is selected. Update the section's DOM from it; do not dispatch
   * commands from here.
   */
  update(selectedTasks: readonly Readonly<Task>[]): void;
}

/**
 * A custom section added below the detail pane's built-in fields.
 *
 * The section is never hidden by the panel: it stays in the DOM for every selection state, so a
 * section that should disappear when nothing is selected hides itself.
 */
export interface SidePanelFieldContribution {
  /** Stable identifier, reflected on the section element as its `data-field-id` attribute. */
  id: string;
  /**
   * Called once with an empty section element owned by the side panel. Append the section's DOM
   * here and return a handle to receive selection updates, or return nothing for a static section.
   * Do not detach or restyle the element itself.
   */
  mount(host: HTMLElement): SidePanelFieldHandle | void;
}

/** The upward points whose owner is not composed in this package's type program yet. */
export interface UpwardContributions {
  "sidepanel/fields": SidePanelFieldContribution;
}

/**
 * Contributes to an extension point whose owning plugin does not exist yet.
 *
 * The value is type-checked against the shape declared above; only the key is passed through
 * unchecked. Retire this together with the structural declarations above when the owner lands.
 */
export function contributeUpward<K extends keyof UpwardContributions>(
  ctx: PluginContext,
  point: K,
  value: UpwardContributions[K],
): void {
  // Called as a method so the context keeps its receiver; only the two arguments are widened.
  ctx.contribute(point as never, value as never);
}
