// docs/specs/plugins/data-sync.md §3.1
/**
 * Page bookkeeping for lazy loading: which fixed-size pages are loaded or in flight, the
 * backend-reported total, and per-page continuation cursors. Pure and hostless.
 */
export class Pager {
  readonly pageSize: number;
  private readonly loaded = new Set<number>();
  private readonly inflight = new Set<number>();
  /** Cursor returned by page `n`, to be sent with the request for page `n + 1`. */
  private readonly cursorAfter = new Map<number, string>();
  private knownTotal: number | undefined;

  constructor(pageSize: number) {
    this.pageSize = pageSize;
  }

  total(): number | undefined {
    return this.knownTotal;
  }

  loadedCount(): number {
    return this.loaded.size;
  }

  /**
   * The ascending page indices overlapping `[offset, offset + limit)`, clamped to the known
   * total. Unusable arguments yield an empty list.
   */
  pagesFor(offset: number, limit: number): number[] {
    // §3.1 (normative): a negative offset is treated as unusable, matching the "non-finite or
    // negative arguments ... resolve `{ ok: true, pages: 0 }`" rule verbatim.
    if (!Number.isFinite(offset) || !Number.isFinite(limit) || offset < 0 || limit <= 0) return [];
    const from = Math.floor(offset);
    let to = from + Math.ceil(limit) - 1;
    if (this.knownTotal !== undefined) {
      if (from >= this.knownTotal) return [];
      to = Math.min(to, this.knownTotal - 1);
    }
    const first = Math.floor(from / this.pageSize);
    const last = Math.floor(to / this.pageSize);
    const pages: number[] = [];
    for (let page = first; page <= last; page += 1) pages.push(page);
    return pages;
  }

  isLoaded(page: number): boolean {
    return this.loaded.has(page);
  }

  isRangeLoaded(offset: number, limit: number): boolean {
    // Unusable arguments report `false` — distinct from a usable range with no overlapping pages
    // (at/beyond the known total, which reports `true` below), so this must be checked BEFORE
    // delegating to `pagesFor` (whose empty result alone cannot distinguish the two cases).
    if (!Number.isFinite(offset) || !Number.isFinite(limit) || offset < 0 || limit <= 0) return false;
    const pages = this.pagesFor(offset, limit);
    // Usable arguments with no overlapping pages: the range lies entirely at/beyond the known
    // total, which `ensureRange` treats as satisfied (`{ ok: true, pages: 0 }`) — the predicate
    // agrees and reports it loaded (§3.1).
    if (pages.length === 0) return true;
    return pages.every((page) => this.loaded.has(page));
  }

  /** The pages of the list that are neither loaded nor currently in flight. */
  missing(pages: readonly number[]): number[] {
    return pages.filter((page) => !this.loaded.has(page) && !this.inflight.has(page));
  }

  markInflight(page: number): void {
    this.inflight.add(page);
  }

  /** Records a completed page: its loaded state, the reply's total and continuation cursor. */
  markLoaded(page: number, reply: { total?: number; cursor?: string }): void {
    this.inflight.delete(page);
    this.loaded.add(page);
    if (typeof reply.total === "number" && Number.isFinite(reply.total) && reply.total >= 0) {
      this.knownTotal = Math.floor(reply.total);
    }
    if (typeof reply.cursor === "string") this.cursorAfter.set(page, reply.cursor);
  }

  /**
   * Un-marks a page that did not complete, so it can be retried: clears its in-flight mark and —
   * for the case where `markLoaded` already ran before a later step failed (a row-application
   * throw partway through `applyPage`, review round 2) — its loaded mark too, so `isLoaded`/
   * `isRangeLoaded` stop reporting it as covered. A no-op on `loaded` for the two call sites where
   * the page was never marked loaded in the first place (a rejected `fetchRange`, a malformed
   * reply): `Set.delete` of an absent member is harmless.
   */
  markFailed(page: number): void {
    this.inflight.delete(page);
    this.loaded.delete(page);
  }

  /** The cursor to send with the request for `page`, when the previous page returned one. */
  cursorFor(page: number): string | undefined {
    return page > 0 ? this.cursorAfter.get(page - 1) : undefined;
  }

  clear(): void {
    this.loaded.clear();
    this.inflight.clear();
    this.cursorAfter.clear();
    this.knownTotal = undefined;
  }
}
