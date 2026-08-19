// docs/specs/plugins/tree-grid.md § Internal modules — "Sequence IDs": display-only automatic
// numbering over the store's iteration order, cached between task-set changes.
import type { TaskId } from "@stargantt/plugin-data-store";

/** The resolved shape of `TaskFieldsConfig.idNumbering`. */
export interface IdNumbering {
  prefix: string;
  start: number;
  minDigits: number;
}

export const DEFAULT_NUMBERING: IdNumbering = { prefix: "", start: 1, minDigits: 1 };

/** Narrows a raw config value to a usable `IdNumbering`, dropping unusable members. */
export function resolveNumbering(raw: unknown): IdNumbering {
  const out = { ...DEFAULT_NUMBERING };
  if (typeof raw !== "object" || raw === null) return out;
  const r = raw as Record<string, unknown>;
  if (typeof r["prefix"] === "string") out.prefix = r["prefix"];
  if (typeof r["start"] === "number" && Number.isInteger(r["start"])) out.start = r["start"];
  if (typeof r["minDigits"] === "number" && Number.isInteger(r["minDigits"]) && r["minDigits"] > 0) {
    out.minDigits = r["minDigits"];
  }
  return out;
}

/** Formats the sequence ID of the task at position `index` (0-based). */
export function formatSequenceId(numbering: IdNumbering, index: number): string {
  const n = numbering.start + index;
  const digits = String(Math.abs(n)).padStart(numbering.minDigits, "0");
  return `${numbering.prefix}${n < 0 ? "-" : ""}${digits}`;
}

/**
 * A lazily built, invalidatable map from task id to sequence position. `positionOf` rebuilds
 * from `ids()` on first use after an `invalidate()`, so lookups between data changes are O(1).
 */
export function sequenceCache(ids: () => Iterable<TaskId>): {
  positionOf(id: TaskId): number | undefined;
  invalidate(): void;
} {
  let map: Map<TaskId, number> | undefined;
  return {
    positionOf(id) {
      if (map === undefined) {
        map = new Map();
        let i = 0;
        for (const taskId of ids()) map.set(taskId, i++);
      }
      return map.get(id);
    },
    invalidate() {
      map = undefined;
    },
  };
}
