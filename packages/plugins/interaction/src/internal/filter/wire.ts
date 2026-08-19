// docs/specs/plugins/interaction.md §2.3 (`FilterService`) / §3 (`rows/height`, `overlay-corner`) /
// §6.8 (config) — the search box, the filter panel and the row hiding they drive.
/**
 * Wiring entry point of the `filter` feature, published as `stargantt.filter` (§2.3): there is no
 * `filter/changed` event — state is published through the `FilterState` store.
 *
 * `model.ts` / `search-index.ts` / `toolbar.ts` are pure/hostless; this module is the only one that
 * touches `ctx`, `data`, `view` and the `FilterState` store — bridging the pure model to the public
 * surface, exactly like every other feature's `wire*` entry point.
 */
import { createStore } from "@stargantt/core";
import type { SlotGrant } from "@stargantt/core";
import type { DataService } from "@stargantt/plugin-data-store";
// Type-only: loads tree-grid's `declare module "@stargantt/core"` augmentation (`rows/height`,
// `view/rowsInvalidate`) into this program, so this module's own `ctx.contribute("rows/height", …)`
// / `ctx.dispatch("view/rowsInvalidate", …)` calls type-check on their own merits rather than only
// because `src/index.ts` happens to import the same augmentation elsewhere in the package (type-only:
// erased at emit, so this stays a devDependency, not a runtime one).
import type {} from "@stargantt/plugin-tree-grid";
import type { PeripheralWiring } from "../peripheral";
import { FilterModel, normalizeQuery } from "./model";
import type { Fault } from "./model";
import { SearchIndex, resourceNames } from "./search-index";
import { createToolbar, FILTER_CORNERS, isFilterCorner } from "./toolbar";
import type { FilterCorner, Toolbar } from "./toolbar";
import type { FilterCriteria, FilterFieldDef, FilterService, FilterState, FilterView } from "./types";

/** The built-in filterable fields: assigned resource names, and the task's type. */
function builtInFields(data: DataService): FilterFieldDef[] {
  return [
    { id: "resource", label: "Resource", value: (task) => resourceNames(data.query(), task.id) },
    { id: "type", label: "Type", value: (task) => task.type ?? "task" },
  ];
}

function usableField(field: unknown): field is FilterFieldDef {
  if (field === null || typeof field !== "object") return false;
  const f = field as Partial<FilterFieldDef>;
  return typeof f.id === "string" && typeof f.label === "string" && typeof f.value === "function";
}

function isNest(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** The feature's own four config fields (§6.8), read permissively per §6 rule 3. */
interface ResolvedFilterConfig {
  searchBox: boolean;
  filterPanel: boolean;
  fields: FilterFieldDef[];
  views: Record<string, FilterView>;
}

function resolveFilterConfig(raw: Record<string, unknown>, data: DataService): ResolvedFilterConfig {
  const rawFields = raw["fields"];
  const rawViews = raw["views"];
  return {
    searchBox: raw["searchBox"] === true,
    filterPanel: raw["filterPanel"] === true,
    fields: Array.isArray(rawFields) ? rawFields.filter(usableField) : builtInFields(data),
    views: isNest(rawViews) ? (rawViews as Record<string, FilterView>) : {},
  };
}

/**
 * The corner a `claimSlot("overlay-corner", "top-right", ...)` grant resolves to: the requested
 * corner when granted, the proposed alternative when it names one of the four known corners,
 * `"top-right"` otherwise (no free slot left — the same corner the request itself named, so the
 * toolbar still renders predictably rather than picking an arbitrary fallback).
 */
export function resolveCorner(grant: SlotGrant): FilterCorner {
  return grant.granted || !isFilterCorner(grant.alternative) ? "top-right" : grant.alternative;
}

/** Wires the filter feature into the composition. */
export function wireFilter(deps: PeripheralWiring): void {
  const { ctx, messages } = deps;
  const data = ctx.use("stargantt.data");
  const config = resolveFilterConfig(deps.config, data);

  const fault: Fault = (_where, error) => deps.reportError(error);

  const index = new SearchIndex(() => data.query());
  const fieldsById = new Map(config.fields.map((f) => [f.id, f]));
  const model = new FilterModel(() => data.query(), index, fieldsById, fault);
  model.seedViews(config.views);

  /* --- row hiding through the public `rows/height` point --------------- */
  // docs/specs/plugins/interaction.md §3 — a hidden row's height overrides to 0; returning
  // `undefined` declines, so with no active filter the contribution is inert and the grid's
  // geometry (and the committed baselines) are untouched.
  ctx.contribute("rows/height", (task, _defaultHeight) => {
    if (!model.isActive()) return undefined;
    return model.isVisible(task.id) ? undefined : 0;
  });

  const store = createStore<FilterState>({
    query: "",
    criteria: null,
    active: false,
    matchCount: 0,
  });

  let toolbar: Toolbar | undefined;

  /**
   * Applies a state change: re-derive, publish the new snapshot, and force the grid to re-measure.
   *
   * Publish order (§2.3 / the abolished `filter/changed`'s documented emission order):
   * the store is set — so a subscriber reading `FilterService.state` inside its own callback sees
   * the new state — before `view/rowsInvalidate` is dispatched.
   */
  function publish(): void {
    model.invalidate();
    store.set({
      query: model.query(),
      criteria: model.criteria(),
      active: model.isActive(),
      matchCount: model.matchCount(),
    });
    // docs/specs/plugins/interaction.md §3 / tree-grid.md's `view/rowsInvalidate` — the tree-grid's
    // own payload-less rebuild command: it re-runs the flattening and re-consults the `rows/height`
    // reduction (where the filter takes effect) and emits `rows/changed`, without naming any task.
    ctx.dispatch("view/rowsInvalidate", undefined);
  }

  const service: FilterService = {
    state: store,
    setQuery(text) {
      if (typeof text !== "string") return;
      // Whitespace-only text counts as empty, so compare normalized forms: setting " " while the
      // query is already "" (or vice versa) is not a usable change and must not force a recompute.
      if (normalizeQuery(text) === normalizeQuery(model.query())) return;
      model.setQuery(text);
      publish();
    },
    setCriteria(criteria) {
      model.setCriteria(criteria);
      publish();
    },
    clear() {
      model.setQuery("");
      model.setCriteria(null);
      publish();
    },
    isTaskVisible: (id) => model.isVisible(id),
    saveView: (name) => model.saveView(name),
    applyView(name) {
      const found = model.applyView(name);
      if (found) publish();
      return found;
    },
    deleteView: (name) => model.deleteView(name),
    viewNames: () => model.viewNames(),
  };
  ctx.provide("stargantt.filter", service);

  // The toolbar's counter is plain DOM text, not re-derived on every read the way `rows/height` is,
  // so every effective store publish is a second, independent reason for it to refresh (besides the
  // data-change path below).
  ctx.own(
    store.subscribe(() => {
      toolbar?.refreshCounter();
    }),
  );

  // On a data change: invalidates the index and the derived sets
  // (recomputed lazily at the next consult, as with any change) and, while a query or usable
  // criteria are currently configured, republishes — which both refreshes `matchCount`/`active` in
  // the store for anything subscribed to it and re-dispatches `view/rowsInvalidate`. The dispatch is
  // load-bearing, not an optimization: `dependsOn` only orders `setup()`, not listener execution, so
  // another plugin's own `data/tasksChanged`-equivalent handler (task-bars reading row geometry for
  // its repaint) can force an eager `rows/height` consult that lands on the row model's cache before
  // this handler's own invalidation ran — without the republish nothing then re-triggers it, and a
  // query/criteria set before the host's first `data.load()` would show a permanent stale count
  // against the store it was set against. `hasFilterInputs()` is a cheap, data-independent check, so
  // an inert composition (no query/criteria ever set) pays nothing extra.
  ctx.own(
    data.tasks.subscribe(() => {
      index.invalidate();
      if (model.hasFilterInputs()) publish();
    }),
  );

  /* --- opt-in UI --------------------------------------------------------- */
  const wantsUi = config.searchBox || config.filterPanel;
  if (!wantsUi) return;

  // docs/specs/plugins/interaction.md §3 — arbitrated in code: the first claimant of a (group,
  // slot) pair occupies it; a later claimant may follow the proposed alternative or not. This
  // feature follows it, exactly as tree-grid's conditional-format legend does.
  //
  // Claimed here, at setup() — review round 1 major M2 fix. The claim itself touches no DOM (only
  // the toolbar mount below needs `stargantt.view`'s pane element, which is why THAT stays deferred
  // to `lifecycle/ready`); deferring the claim too made `claimSlot`'s registration-order determinism
  // (§3's corner-slot arbitration note) depend on `lifecycle/ready` LISTENER order instead of plugin
  // registration order, so a later-registered composition (e.g. the resource heatmap, perf-tools)
  // could still win a contested `top-right` over this feature by having its own `lifecycle/ready`
  // handler run first.
  const grant = ctx.claimSlot("overlay-corner", "top-right", FILTER_CORNERS);
  const corner: FilterCorner = resolveCorner(grant);

  ctx.on("lifecycle/ready", () => {
    if (toolbar !== undefined) return;
    const view = ctx.use("stargantt.view");
    const pane = view.chartPaneElement();

    toolbar = createToolbar(
      pane,
      {
        searchBox: config.searchBox,
        filterPanel: config.filterPanel,
        fields: config.fields,
        messages,
        corner,
      },
      {
        setQuery: (text) => service.setQuery(text),
        setFieldSelections(selections) {
          const current = model.criteria() ?? {};
          service.setCriteria({ ...current, fields: selections } as FilterCriteria);
        },
        fieldValues: (def, task) => model.fieldValues(def, task),
        view: () => data.query(),
        counterText() {
          if (!model.isActive()) return "";
          // The catalog's `matchCount` builder is already guarded (a throw is reported and
          // answered by the built-in default) by `resolveMessages` at setup — no local try/catch
          // needed here.
          return messages.matchCount(model.matchCount());
        },
      },
    );
    pane.appendChild(toolbar.root);
    ctx.own({ dispose: () => toolbar?.root.remove() });

    // Close the filter panel on an outside press. The document-level listener is the plugin's own
    // resource, registered exactly once through `ctx.own()`.
    const doc = pane.ownerDocument;
    const onDocPointerDown = (event: Event): void => {
      if (toolbar !== undefined && !toolbar.contains(event.target)) toolbar.closePanel();
    };
    doc.addEventListener("pointerdown", onDocPointerDown);
    ctx.own({ dispose: () => doc.removeEventListener("pointerdown", onDocPointerDown) });

    toolbar.refreshCounter();
  });
}
