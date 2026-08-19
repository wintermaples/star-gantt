// docs/specs/plugins/export.md §1.8, §9 (`internal/excel/`).
/**
 * The Excel workbook area's slice of the facade.
 *
 * Consumes `internal/formats/csv`'s cell-text builder through `./bridge` (§9's csv-wins merge
 * ruling) so `toXlsx` writes exactly the same rows, order, and cell text as `exportCsv`.
 */
import { DISPOSED_MESSAGE } from "../wiring";
import type { ExportWiring } from "../wiring";
import type { ExportService, XlsxExportOptions } from "../../types";
import { tasksToRows, usableColumns } from "./bridge";
import { buildXlsx, sanitizeSheetName } from "./xlsx-write";

/** The member `internal/excel/` owns. */
export type ExcelSurface = Pick<ExportService, "toXlsx">;

export function wireExcel(w: ExportWiring): ExcelSurface {
  // §7 — the `excel` nest's `sheetName` is carried through *unsanitized* by `resolveConfig` ("a
  // non-empty `sheetName` verbatim"; sanitization is this area's job, §1.8). Sanitized once here,
  // since it never changes after `setup()`; a nest value that sanitizes to `""` falls back to the
  // built-in default, same as an unusable per-call value does below.
  const defaultSheetName = sanitizeSheetName(w.config.excel.sheetName) || "Tasks";

  return {
    toXlsx(options?: XlsxExportOptions): ArrayBuffer {
      // Review m1/m6 — mirrors the disposed-instance guard `../../index.ts`'s image path
      // (`begin()`) already enforces; `DISPOSED_MESSAGE` is `../wiring`'s, not a hand-copied literal.
      if (w.disposed()) throw new Error(DISPOSED_MESSAGE);
      const columns = usableColumns(options?.columns);
      const sheetName = sanitizeSheetName(options?.sheetName) || defaultSheetName;
      const rows = tasksToRows(w.data.query().byId.values(), columns);
      const bytes = buildXlsx(rows, sheetName);
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    },
  };
}
