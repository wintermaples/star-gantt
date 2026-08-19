// docs/specs/plugins/export.md §1.4–§1.6, §9 (`internal/formats/`).
/**
 * The CSV / JSON / iCal area's slice of the facade.
 *
 * `exportCsv` / `exportJson` / `exportICal` are thin serializer calls. `importCsv` / `importJson`
 * share one pipeline: parse → validate → diff, then branch on `options.dialog` / `options.dryRun`
 * / the default direct-apply path (§1.5). The direct-apply path (and the dialog's own apply) both
 * go through `applyChanges` in `./apply-plan`, which dispatches through the shared guard
 * `internal/embed/guard.ts` installs — the single `data/willApplyTransaction` subscription this
 * whole plugin shares with the read-only veto (§2.1, §11).
 */
import { guardFor } from "../embed/guard";
import { DISPOSED_MESSAGE } from "../wiring";
import type { ExportWiring } from "../wiring";
import type {
  CsvExportOptions,
  CsvImportOptions,
  ExportService,
  ICalExportOptions,
  ImportDocument,
  ImportOptions,
  ImportResult,
  JsonImportOptions,
} from "../../types";
import type { CsvMapping } from "../../types";
import { applyChanges } from "./apply-plan";
import { parseCsvTasks, serializeCsv } from "./csv";
import { createImportDialog } from "./dialog";
import type { DialogState, ImportDialog } from "./dialog";
import { diffDocument } from "./diff";
import { serializeICal } from "./ical";
import { parseJsonDocument, serializeProject } from "./json";
import { validateDocument } from "./validate";

/** The members `internal/formats/` owns. */
export type FormatsSurface = Pick<
  ExportService,
  "exportCsv" | "exportJson" | "exportICal" | "importCsv" | "importJson"
>;

function emptyDocument(format: "csv" | "json"): ImportDocument {
  return { format, tasks: [], links: [], resources: [], assignments: [], issues: [] };
}

// Review m1 — the same disposed-instance guard `../../index.ts`'s image path (`begin()`) already
// enforces, mirrored here since `ExportWiring.disposed()` had no caller in this area.
// Review m6 — `DISPOSED_MESSAGE` is `../wiring`'s, not a hand-copied literal, so every facade
// member (this area's five plus the other seven) throws the exact same string.
function assertNotDisposed(w: ExportWiring): void {
  if (w.disposed()) throw new Error(DISPOSED_MESSAGE);
}

export function wireFormats(w: ExportWiring): FormatsSurface {
  const guard = guardFor(w);

  function parseCsvDoc(text: string, mapping?: CsvMapping): ImportDocument {
    if (typeof text !== "string") return emptyDocument("csv");
    const parsed = parseCsvTasks(text, mapping, w.config.importExport.csvDelimiter);
    return {
      format: "csv",
      tasks: parsed.tasks,
      links: [],
      resources: [],
      assignments: [],
      headers: parsed.headers,
      mapping: parsed.mapping,
      issues: parsed.issues,
    };
  }

  function parseJsonDoc(text: string): ImportDocument {
    if (typeof text !== "string") {
      const doc = emptyDocument("json");
      doc.issues.push({ code: "invalid-json", reason: "not a string" });
      return doc;
    }
    return parseJsonDocument(text);
  }

  /* --- the on-demand import dialog (§1.6) -------------------------------- */
  let dialog: ImportDialog | undefined;
  // Owned once: disposal removes whatever dialog is current (only one exists at a time — a fresh
  // open replaces it).
  w.ctx.own({ dispose: () => closeDialog() });

  function closeDialog(): void {
    dialog?.dispose();
    dialog = undefined;
  }

  function openDialog(
    doc: ImportDocument,
    reparse: (mapping: CsvMapping) => ImportDocument,
    options: ImportOptions | undefined,
  ): void {
    function stateOf(d: ImportDocument): DialogState {
      const view = w.data.query();
      return { doc: d, issues: validateDocument(d, view), changes: diffDocument(d, view, options) };
    }
    const pane = w.view.chartPaneElement();
    closeDialog();
    dialog = createImportDialog(pane, stateOf(doc), w.messages, {
      remap: (mapping) => stateOf(reparse(mapping)),
      apply: (changes) => void applyChanges(w, guard, changes, "dialog"),
      close: closeDialog,
      fault: w.reportError,
    });
  }

  /* --- the shared parse → validate → diff → (dryRun | dialog | apply) pipeline (§1.5) ------- */
  function runPipeline(
    doc: ImportDocument,
    reparse: (mapping: CsvMapping) => ImportDocument,
    options: ImportOptions | undefined,
  ): ImportResult {
    const view = w.data.query();
    const issues = [...doc.issues, ...validateDocument(doc, view)];
    const changes = diffDocument(doc, view, options);

    if (options?.dialog === true) {
      openDialog(doc, reparse, options);
      return { document: doc, issues, changes };
    }
    if (options?.dryRun === true) {
      return { document: doc, issues, changes };
    }

    let toApply = changes;
    const filter = options?.filter;
    if (typeof filter === "function") {
      toApply = changes.filter((change) => {
        try {
          return filter(change) === true;
        } catch (error) {
          // §1 — a throwing `filter` excludes the change (fail-safe) and is reported once.
          w.reportError("importOptions.filter", error);
          return false;
        }
      });
    }
    const applied = applyChanges(w, guard, toApply, "api");
    return { document: doc, issues, changes: toApply, applied };
  }

  return {
    exportCsv(options?: CsvExportOptions): string {
      assertNotDisposed(w);
      const view = w.data.query();
      // §1.4 — an unusable per-call `delimiter` falls back to the `importExport` nest's
      // `csvDelimiter`, not to `","` outright: resolved here so `serializeCsv`'s own (bare-",")
      // fallback never has to run for this call.
      const delimiter =
        typeof options?.delimiter === "string" && options.delimiter.length === 1
          ? options.delimiter
          : w.config.importExport.csvDelimiter;
      return serializeCsv(view.byId.values(), { ...options, delimiter });
    },

    exportJson(): string {
      assertNotDisposed(w);
      return serializeProject(w.data);
    },

    exportICal(options?: ICalExportOptions): string {
      assertNotDisposed(w);
      return serializeICal(w.data.query().byId.values(), options, Date.now());
    },

    importCsv(text: string, options?: CsvImportOptions): ImportResult {
      assertNotDisposed(w);
      const doc = parseCsvDoc(text, options?.mapping);
      return runPipeline(doc, (mapping) => parseCsvDoc(text, mapping), options);
    },

    importJson(text: string, options?: JsonImportOptions): ImportResult {
      assertNotDisposed(w);
      const doc = parseJsonDoc(text);
      // JSON documents carry no column mapping, so the dialog never invokes `remap` for one — the
      // reparse hook only has to satisfy the interface.
      return runPipeline(doc, () => doc, options);
    },
  };
}
