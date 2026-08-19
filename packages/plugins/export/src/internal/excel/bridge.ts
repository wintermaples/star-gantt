// docs/specs/plugins/export.md §1.8, §9 — task → row serialization for workbook export. Hostless.
/**
 * §9's csv-wins merge ruling: this bridge consumes `internal/formats/csv`'s guarded `cellOf` /
 * `usableColumns` directly rather than keeping its own copy. There were previously two
 * near-identical builders (one for import/export, one for excel); where they diverged, the excel
 * builder lacked §1.4's out-of-range-date raw-number fallback (`isoOrRaw`) and would have thrown
 * serializing a task dated outside `Date`'s representable range — the csv-guarded builder wins,
 * fixing that latent divergence as part of the merge (recorded, not re-litigated).
 */
import type { Task } from "@stargantt/plugin-data-store";
import type { TaskCsvField } from "../../types";
import { CSV_FIELDS, cellOf, usableColumns } from "../formats/csv";

export { usableColumns };

/** All task fields, in canonical column order — re-exported under the excel area's own name. */
export const XLSX_FIELDS: readonly TaskCsvField[] = CSV_FIELDS;

/** One header row of field names, then one row per task in iteration order. */
export function tasksToRows(tasks: Iterable<Readonly<Task>>, columns: readonly TaskCsvField[]): string[][] {
  const rows: string[][] = [columns.map(String)];
  for (const task of tasks) rows.push(columns.map((field) => cellOf(task, field)));
  return rows;
}
