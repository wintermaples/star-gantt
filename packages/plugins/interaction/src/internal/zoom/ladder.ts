// docs/specs/plugins/interaction.md §6.6 — the zoom ladder: configured level ids, density
// comparison, and stepping through the chart's `stargantt.timeline` service.
/**
 * The zoom ladder the toolbar's +/− buttons and slider step through.
 *
 * Adapted to `TimelineService`: the active level is read from the store-shaped `zoomLevel` member
 * instead of a `zoomLevel()` accessor, and `setZoomLevel` throws on an unknown id, hence the
 * try/catch tolerance below.
 *
 * Hostless: it sees only the narrow slice of `TimelineService` it needs, so it is testable without
 * a Gantt instance.
 */

/** The slice of `TimelineService` the ladder needs. */
export interface LadderTimeline {
  readonly zoomLevel: { get(): { id: string; pxPerDay: number } };
  setZoomLevel(id: string, anchorTime?: number): void;
  levelMetrics(): readonly { readonly id: string; readonly pxPerDay: number }[];
}

/** One ladder entry: a level id known to exist in the composition, with its density. */
export interface LadderEntry {
  id: string;
  pxPerDay: number;
}

// docs/specs/plugins/interaction.md §6.6 — "the six built-in levels, coarsest first"; the same six
// ids view.md's `timeline.zoomLevels` default carries (`"day"`, `"week"`, `"hour"`, `"month"`,
// `"quarter"`, `"year"`), reordered coarsest first.
export const DEFAULT_LEVELS: readonly string[] = ["year", "quarter", "month", "week", "day", "hour"];

// docs/specs/plugins/interaction.md §6.6 / §6 (rule 3 convention shared across this
// package's config resolution) — an unusable configured value silently falls back to its default.
/**
 * Normalizes the configured `levels` array: keeps non-empty strings, drops duplicates keeping the
 * first occurrence, and falls back to the default ladder when nothing usable remains.
 */
export function normalizeLevels(levels: unknown): readonly string[] {
  if (!Array.isArray(levels)) return DEFAULT_LEVELS;
  const out: string[] = [];
  for (const id of levels) {
    if (typeof id !== "string" || id === "" || out.includes(id)) continue;
    out.push(id);
  }
  return out.length === 0 ? DEFAULT_LEVELS : out;
}

export interface Ladder {
  /** The ladder ids, coarsest first — the configured order, or the default. */
  readonly ids: readonly string[];
  /**
   * Activates the ladder id one step finer (`+1`) or coarser (`-1`) than the active level, anchored
   * at `anchorTime`. When the active id is not in the ladder, the density table picks the nearest
   * strictly denser / sparser entry. No-op at either end, or when nothing qualifies.
   */
  step(direction: 1 | -1, anchorTime: number): void;
  /** Activates the ladder id at `index`, anchored. Unknown or out-of-range ids are a no-op. */
  setIndex(index: number, anchorTime: number): void;
  /**
   * The densest known entry whose whole `spanMs` fits `widthPx`, or the coarsest known entry when
   * none fits, or `undefined` when no ladder id exists in the composition.
   */
  fitEntry(spanMs: number, widthPx: number): LadderEntry | undefined;
  /**
   * Activates `id` unanchored (no viewport-center preservation). A ladder id the composition does
   * not carry, or any other rejection from the underlying timeline service, is a no-op.
   */
  activateUnanchored(id: string): void;
}

const MS_PER_DAY = 86_400_000;

/** A metrics entry is usable when it can be compared and activated: an id and a positive density. */
function usableMetrics(value: LadderEntry | null | undefined): value is LadderEntry {
  return (
    value !== null &&
    value !== undefined &&
    typeof value.id === "string" &&
    value.id !== "" &&
    Number.isFinite(value.pxPerDay) &&
    value.pxPerDay > 0
  );
}

/**
 * Builds the ladder over `ids`.
 *
 * The density table is derived from `TimelineService.levelMetrics()`, read fresh whenever an
 * action needs it: the ladder ids the composition actually carries, in ladder order, each with its
 * `pxPerDay`. Nothing is activated to measure it, so no zoom-level store notification fires for a
 * zoom change the user did not ask for, and a level contributed after setup is picked up on the
 * next read.
 */
export function createLadder(ids: readonly string[], timeline: LadderTimeline): Ladder {
  function densities(): LadderEntry[] {
    const reported = timeline.levelMetrics();
    // Defensive against a foreign timeline service: anything but an array reports no densities.
    const metrics: readonly LadderEntry[] = Array.isArray(reported) ? (reported as LadderEntry[]) : [];
    const byId = new Map<string, number>();
    for (const entry of metrics) {
      // First registration wins, matching which level `setZoomLevel` would activate for that id.
      if (usableMetrics(entry) && !byId.has(entry.id)) byId.set(entry.id, entry.pxPerDay);
    }
    const out: LadderEntry[] = [];
    for (const id of ids) {
      const pxPerDay = byId.get(id);
      // An id the composition does not carry is tolerated: it simply has no entry.
      if (pxPerDay !== undefined) out.push({ id, pxPerDay });
    }
    return out;
  }

  function activate(id: string, anchorTime: number): void {
    try {
      timeline.setZoomLevel(id, anchorTime);
    } catch {
      // Ladder id absent from the composed list — the action is a no-op.
    }
  }

  function step(direction: 1 | -1, anchorTime: number): void {
    const current = timeline.zoomLevel.get();
    const index = ids.indexOf(current.id);
    if (index >= 0) {
      const nextId = ids[index + direction];
      if (nextId !== undefined) activate(nextId, anchorTime);
      return;
    }
    // Active level outside the ladder: nearest entry strictly denser / sparser by pxPerDay.
    const entries = densities();
    let best: LadderEntry | undefined;
    for (const entry of entries) {
      if (direction === 1) {
        if (entry.pxPerDay > current.pxPerDay && (best === undefined || entry.pxPerDay < best.pxPerDay)) {
          best = entry;
        }
      } else if (
        entry.pxPerDay < current.pxPerDay &&
        (best === undefined || entry.pxPerDay > best.pxPerDay)
      ) {
        best = entry;
      }
    }
    if (best !== undefined) activate(best.id, anchorTime);
  }

  function setIndex(index: number, anchorTime: number): void {
    const id = ids[index];
    if (id !== undefined) activate(id, anchorTime);
  }

  function fitEntry(spanMs: number, widthPx: number): LadderEntry | undefined {
    const entries = densities();
    if (entries.length === 0) return undefined;
    let fit: LadderEntry | undefined;
    let coarsest = entries[0] as LadderEntry;
    for (const entry of entries) {
      if (entry.pxPerDay < coarsest.pxPerDay) coarsest = entry;
      const widthNeeded = (spanMs / MS_PER_DAY) * entry.pxPerDay;
      if (widthNeeded <= widthPx && (fit === undefined || entry.pxPerDay > fit.pxPerDay)) {
        fit = entry;
      }
    }
    return fit ?? coarsest;
  }

  function activateUnanchored(id: string): void {
    try {
      timeline.setZoomLevel(id);
    } catch {
      // Any rejection — most commonly a ladder id absent from the composed list — makes the action
      // a no-op; the timeline service's own error channel reports real faults.
    }
  }

  return { ids, step, setIndex, fitEntry, activateUnanchored };
}
