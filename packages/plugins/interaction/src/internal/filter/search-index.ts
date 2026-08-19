// docs/specs/plugins/interaction.md §2.3 — the bigram index behind incremental search.
/**
 * The bigram search index behind incremental search.
 *
 * Pure logic: no DOM, no core imports. The index maps every two-character window ("bigram") of a
 * task's searchable text — its name, the names of its assigned resources, and its `meta.tags` — to
 * the ids of the tasks containing it. A query term of two characters or more is answered by
 * intersecting the postings of its bigrams (rarest first) and verifying the term as a substring on
 * the survivors, so at 100k tasks a search touches only the handful of tasks sharing the term's
 * rarest bigram instead of scanning every haystack. Single-character terms fall back to a linear
 * substring scan. Bigrams work for any script — CJK text needs no word segmentation.
 */
import type { ReadonlyDataView, TaskId } from "@stargantt/plugin-data-store";

/** Splits a query string into lowercase terms; every term must match for a task to match. */
export function queryTerms(text: string): string[] {
  return text
    .toLowerCase()
    .split(/\s+/u)
    .filter((t) => t.length > 0);
}

/** Reads the searchable tag strings out of a task's `meta.tags`, tolerating any shape. */
export function tagStrings(meta: Record<string, unknown> | undefined): string[] {
  const tags = meta?.["tags"];
  if (typeof tags === "string") return [tags];
  if (!Array.isArray(tags)) return [];
  return tags.filter((t): t is string => typeof t === "string");
}

/**
 * The assigned resource names for one task in one data view, `[]` when it has none. Shared by the
 * indexer (below) and the built-in "resource" filterable field, so the two never drift on how an
 * assignment resolves to a searchable/filterable name.
 */
export function resourceNames(view: ReadonlyDataView, taskId: TaskId): string[] {
  const assignments = view.assignmentsByTask.get(taskId);
  if (assignments === undefined) return [];
  const names: string[] = [];
  for (const a of assignments) {
    const resource = view.resources.get(a.resourceId);
    if (resource !== undefined) names.push(resource.name);
  }
  return names;
}

export class SearchIndex {
  private haystacks = new Map<TaskId, string>();
  private grams = new Map<string, TaskId[]>();
  private dirty = true;

  constructor(private readonly view: () => ReadonlyDataView) {}

  /** Marks the index stale; the rebuild itself is deferred to the next search. */
  invalidate(): void {
    this.dirty = true;
  }

  /**
   * The ids of the tasks whose indexed text contains every term as a substring
   * (case-insensitive). An empty term list matches every task.
   */
  search(terms: readonly string[]): Set<TaskId> {
    this.ensure();
    const out = new Set<TaskId>();
    if (terms.length === 0) {
      for (const id of this.haystacks.keys()) out.add(id);
      return out;
    }
    const lowered = terms.map((t) => t.toLowerCase());
    // Seed the scan from whichever term has the smallest candidate set, not just the first one:
    // a rare second term (e.g. a name shared by one task) can be far cheaper to start from than a
    // one- or two-character first term that matches almost everything.
    const seed = this.smallestCandidateTerm(lowered);
    for (const id of this.candidates(seed)) {
      const hay = this.haystacks.get(id);
      if (hay === undefined) continue;
      let all = true;
      for (const term of lowered) {
        if (!hay.includes(term)) {
          all = false;
          break;
        }
      }
      if (all) out.add(id);
    }
    return out;
  }

  /** The term (already lowercased) with the cheapest candidate set to scan from. */
  private smallestCandidateTerm(terms: readonly string[]): string {
    let best = terms[0] as string;
    let bestSize = this.candidateSize(best);
    for (let i = 1; i < terms.length; i += 1) {
      const term = terms[i] as string;
      const size = this.candidateSize(term);
      if (size < bestSize) {
        best = term;
        bestSize = size;
      }
    }
    return best;
  }

  /** The size `candidates()` would produce for one term, without materializing the set. */
  private candidateSize(term: string): number {
    if (term.length < 2) return this.haystacks.size;
    let min = Number.POSITIVE_INFINITY;
    for (let i = 0; i + 2 <= term.length; i += 1) {
      const postings = this.grams.get(term.slice(i, i + 2));
      if (postings === undefined) return 0;
      if (postings.length < min) min = postings.length;
    }
    return min;
  }

  /** Candidate ids for one lowercase term: postings intersection, or every id for short terms. */
  private candidates(term: string): Iterable<TaskId> {
    if (term.length < 2) return this.haystacks.keys();
    // Intersect starting from the rarest bigram so the verification set stays minimal.
    let best: TaskId[] | undefined;
    for (let i = 0; i + 2 <= term.length; i += 1) {
      const postings = this.grams.get(term.slice(i, i + 2));
      if (postings === undefined) return [];
      if (best === undefined || postings.length < best.length) best = postings;
    }
    return best ?? [];
  }

  private ensure(): void {
    if (!this.dirty) return;
    this.dirty = false;
    const view = this.view();
    this.haystacks = new Map();
    this.grams = new Map();
    for (const task of view.byId.values()) {
      const parts: string[] = [task.name, ...resourceNames(view, task.id), ...tagStrings(task.meta)];
      const hay = parts.join("\n").toLowerCase();
      this.haystacks.set(task.id, hay);
      // De-duplicate bigrams per task so a posting list never repeats an id.
      const seen = new Set<string>();
      for (let i = 0; i + 2 <= hay.length; i += 1) {
        const gram = hay.slice(i, i + 2);
        if (seen.has(gram)) continue;
        seen.add(gram);
        const postings = this.grams.get(gram);
        if (postings === undefined) this.grams.set(gram, [task.id]);
        else postings.push(task.id);
      }
    }
  }
}
