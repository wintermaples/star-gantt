// docs/specs/plugins/interaction.md §2.3 — the filter model: current query + criteria, the derived
// visible-row set, and the named views.
/**
 * The filter model. Pure logic: no DOM, no core imports — `wire.ts` is the only module that
 * bridges it to a `Store`/`ctx`.
 */
import type { ReadonlyDataView, ResourceId, Task, TaskId } from "@stargantt/plugin-data-store";
import type { FilterCriteria, FilterFieldDef, FilterView } from "./types";
import { SearchIndex, queryTerms } from "./search-index";

/** Reports a contained foreign-function throw; wired to `core/pluginError` by `wire.ts`. */
export type Fault = (where: string, error: unknown) => void;

/**
 * Deep-copies criteria for a saved view: `saveView` must snapshot the state at save time, not keep
 * a live reference the caller can still mutate through. `predicate` is preserved by reference —
 * functions aren't cloneable and a host-supplied closure is assumed stable.
 */
export function cloneCriteria(c: FilterCriteria | null): FilterCriteria | null {
  if (c === null) return null;
  const clone: FilterCriteria = { ...c };
  if (Array.isArray(c.resources)) clone.resources = [...c.resources];
  if (Array.isArray(c.types)) clone.types = [...c.types];
  if (c.fields !== undefined && c.fields !== null) {
    const fields: Record<string, readonly string[]> = {};
    for (const [id, values] of Object.entries(c.fields)) {
      fields[id] = Array.isArray(values) ? [...values] : values;
    }
    clone.fields = fields;
  }
  return clone;
}

/**
 * Normalizes a query for equality checks: whitespace-only text is equivalent to empty text (the
 * same rule `queryTerms` applies for matching), so trimming here is what makes "no usable change"
 * comparisons — e.g. skipping a no-op `setQuery` — agree with what actually changes the match set.
 */
export function normalizeQuery(text: string): string {
  return text.trim();
}

/**
 * Normalizes any input to the canonical `FilterCriteria | null` shape — an unusable non-object
 * value collapses to `null` — so `setCriteria` applies this rule exactly once instead of every
 * caller (the public service, `clear()`, `applyView()`) guarding it ad hoc.
 */
export function normalizeCriteria(criteria: FilterCriteria | null): FilterCriteria | null {
  return criteria === null || typeof criteria !== "object" ? null : criteria;
}

/** Whether the criteria object carries at least one usable condition. */
export function usableCriteria(criteria: FilterCriteria | null): boolean {
  if (criteria === null) return false;
  if (typeof criteria.text === "string" && criteria.text.trim().length > 0) return true;
  if (Array.isArray(criteria.resources) && criteria.resources.length > 0) return true;
  if (Array.isArray(criteria.types) && criteria.types.length > 0) return true;
  for (const key of ["progressMin", "progressMax", "startFrom", "startTo", "endFrom", "endTo"] as const) {
    if (Number.isFinite(criteria[key])) return true;
  }
  if (criteria.fields !== undefined && criteria.fields !== null) {
    for (const values of Object.values(criteria.fields)) {
      if (Array.isArray(values) && values.length > 0) return true;
    }
  }
  if (typeof criteria.predicate === "function") return true;
  return false;
}

/**
 * The task must be assigned to at least one of the selected resources. `wanted` is the criteria's
 * `resources` list as a `Set`, built once per recompute by the caller rather than once per task.
 */
function matchesResources(
  wanted: ReadonlySet<ResourceId> | undefined,
  task: Readonly<Task>,
  view: ReadonlyDataView,
): boolean {
  if (wanted === undefined) return true;
  const assignments = view.assignmentsByTask.get(task.id);
  if (assignments === undefined) return false;
  return assignments.some((a) => wanted.has(a.resourceId));
}

function matchesTypes(c: FilterCriteria, task: Readonly<Task>): boolean {
  if (!Array.isArray(c.types) || c.types.length === 0) return true;
  return c.types.includes(task.type ?? "task");
}

/** A task with no stated progress counts as 0. */
function matchesProgress(c: FilterCriteria, task: Readonly<Task>): boolean {
  const progress = Number.isFinite(task.progress) ? (task.progress as number) : 0;
  if (Number.isFinite(c.progressMin) && progress < (c.progressMin as number)) return false;
  if (Number.isFinite(c.progressMax) && progress > (c.progressMax as number)) return false;
  return true;
}

/** Half-open date windows: the start window is `[from, to)`, the end window `(from, to]`. */
function matchesDates(c: FilterCriteria, task: Readonly<Task>): boolean {
  if (Number.isFinite(c.startFrom) && !(task.start >= (c.startFrom as number))) return false;
  if (Number.isFinite(c.startTo) && !(task.start < (c.startTo as number))) return false;
  if (Number.isFinite(c.endFrom) && !(task.end > (c.endFrom as number))) return false;
  if (Number.isFinite(c.endTo) && !(task.end <= (c.endTo as number))) return false;
  return true;
}

export class FilterModel {
  private queryText = "";
  private crit: FilterCriteria | null = null;
  private stale = true;
  /** Visible ids (matches + their ancestors) while a filter is active; unused otherwise. */
  private visible = new Set<TaskId>();
  private matched = 0;
  private activeNow = false;
  private views = new Map<string, FilterView>();
  /** Latched barriers: a throwing foreign function is reported once, then ignored for good. */
  private predicateFaulted = false;
  private fieldFaulted = new Set<string>();

  constructor(
    private readonly view: () => ReadonlyDataView,
    private readonly index: SearchIndex,
    /** The composed filter fields, by id — resolves `FilterCriteria.fields` selections. */
    private readonly fields: ReadonlyMap<string, FilterFieldDef>,
    private readonly fault: Fault,
  ) {}

  setQuery(text: string): void {
    this.queryText = typeof text === "string" ? text : "";
    this.stale = true;
  }

  query(): string {
    return this.queryText;
  }

  setCriteria(criteria: FilterCriteria | null): void {
    this.crit = normalizeCriteria(criteria);
    this.stale = true;
  }

  criteria(): FilterCriteria | null {
    return this.crit;
  }

  /** Marks the derived sets stale, e.g. after a data change; recomputation is lazy. */
  invalidate(): void {
    this.stale = true;
  }

  /**
   * Whether a query or usable criteria are currently configured, without recomputing (or even
   * reading) the derived match/visibility sets `ensure()` would. Query and criteria are data-
   * independent inputs, so this is always accurate even while `stale` — unlike `isActive()`, it
   * needs no data view and forces no recomputation.
   */
  hasFilterInputs(): boolean {
    return queryTerms(this.queryText).length > 0 || usableCriteria(this.crit);
  }

  isActive(): boolean {
    this.ensure();
    return this.activeNow;
  }

  isVisible(id: TaskId): boolean {
    this.ensure();
    if (!this.activeNow) return true;
    return this.visible.has(id);
  }

  matchCount(): number {
    this.ensure();
    if (!this.activeNow) return this.view().byId.size;
    return this.matched;
  }

  /* --- named views ---------------------------------------------------- */

  saveView(name: string): void {
    if (typeof name !== "string" || name.length === 0) return;
    this.views.set(name, { query: this.queryText, criteria: cloneCriteria(this.crit) });
  }

  applyView(name: string): boolean {
    const view = this.views.get(name);
    if (view === undefined) return false;
    this.setQuery(typeof view.query === "string" ? view.query : "");
    this.setCriteria(view.criteria ?? null);
    return true;
  }

  deleteView(name: string): boolean {
    return this.views.delete(name);
  }

  viewNames(): string[] {
    return [...this.views.keys()];
  }

  /** Seeds the initial named views from config; unusable entries are skipped silently. */
  seedViews(views: Record<string, FilterView> | undefined): void {
    if (views === null || typeof views !== "object" || views === undefined) return;
    for (const [name, view] of Object.entries(views)) {
      if (name.length === 0 || view === null || typeof view !== "object") continue;
      this.views.set(name, view);
    }
  }

  /* --- recomputation -------------------------------------------------- */

  private ensure(): void {
    if (!this.stale) return;
    this.stale = false;
    const terms = queryTerms(this.queryText);
    const critActive = usableCriteria(this.crit);
    this.activeNow = terms.length > 0 || critActive;
    if (!this.activeNow) {
      this.visible = new Set();
      this.matched = 0;
      return;
    }

    const view = this.view();
    // The text terms — the query's plus the criteria's — are answered by the index first, so at
    // scale the per-task criteria loop below runs over the text survivors only.
    const critText = typeof this.crit?.text === "string" ? queryTerms(this.crit.text) : [];
    const allTerms = [...terms, ...critText];
    const textMatches = allTerms.length > 0 ? this.index.search(allTerms) : undefined;
    // Built once per recompute, not once per task in the loop below: the value depends only on
    // the criteria, so re-allocating it per task was pure waste at data scale.
    const wantedResources =
      Array.isArray(this.crit?.resources) && this.crit.resources.length > 0
        ? new Set(this.crit.resources)
        : undefined;

    const visible = new Set<TaskId>();
    let matched = 0;
    const source = textMatches ?? view.byId.keys();
    for (const id of source) {
      const task = view.byId.get(id);
      if (task === undefined) continue;
      if (critActive && !this.matchesCriteria(task, view, wantedResources)) continue;
      matched += 1;
      visible.add(id);
      // Keep the ancestor chain so a match retains its tree context. A parentId cycle in
      // malformed data terminates via the membership check.
      let parent = task.parentId;
      while (parent !== null && !visible.has(parent)) {
        const p = view.byId.get(parent);
        if (p === undefined) break;
        visible.add(parent);
        parent = p.parentId;
      }
    }
    this.visible = visible;
    this.matched = matched;
  }

  private matchesCriteria(
    task: Readonly<Task>,
    view: ReadonlyDataView,
    wantedResources: ReadonlySet<ResourceId> | undefined,
  ): boolean {
    const c = this.crit;
    if (c === null) return true;
    if (!matchesResources(wantedResources, task, view)) return false;
    if (!matchesTypes(c, task)) return false;
    if (!matchesProgress(c, task)) return false;
    if (!matchesDates(c, task)) return false;
    if (!this.matchesFields(c, task)) return false;
    return this.matchesPredicate(c, task);
  }

  /** Composed-field selections: the task must carry one of the selected values per field. */
  private matchesFields(c: FilterCriteria, task: Readonly<Task>): boolean {
    if (c.fields === undefined || c.fields === null) return true;
    for (const [fieldId, values] of Object.entries(c.fields)) {
      if (!Array.isArray(values) || values.length === 0) continue;
      const def = this.fields.get(fieldId);
      // A selection keyed to no composed field cannot be honored; it is ignored (§6 rule 3).
      if (def === undefined) continue;
      const value = this.fieldValues(def, task);
      if (!value.some((v) => values.includes(v))) return false;
    }
    return true;
  }

  /**
   * The host-supplied predicate, behind a latched barrier: it runs once per task per recompute, so
   * an unlatched report would emit at data scale. After the first throw the clause is dropped for
   * good and every task passes it.
   */
  private matchesPredicate(c: FilterCriteria, task: Readonly<Task>): boolean {
    if (typeof c.predicate !== "function" || this.predicateFaulted) return true;
    try {
      if (!c.predicate(task)) return false;
    } catch (error) {
      this.predicateFaulted = true;
      this.fault("criteria.predicate", error);
    }
    return true;
  }

  /** A field's values for one task, [] when absent — with the same latched barrier as above. */
  fieldValues(def: FilterFieldDef, task: Readonly<Task>): readonly string[] {
    if (this.fieldFaulted.has(def.id)) return [];
    try {
      const v = def.value(task);
      if (typeof v === "string") return [v];
      if (Array.isArray(v)) return v.filter((s): s is string => typeof s === "string");
      return [];
    } catch (error) {
      this.fieldFaulted.add(def.id);
      this.fault(`fields.${def.id}.value`, error);
      return [];
    }
  }
}
