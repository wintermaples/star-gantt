// docs/specs/plugins/resource.md §1.2 resolution note — the shape a composition without the
// `loadChart` nest (or without `stargantt.view`) already produces for the 3 relocated report
// members: an empty row list, a header-only CSV, and a valid empty-table PDF.
import type { ResourceMessages } from "../messages";

export function emptyUtilizationReport(): readonly [] {
  return [];
}

export function emptyUtilizationReportCSV(messages: ResourceMessages): string {
  const columns = ["resource", "from", "to", "allocated", "capacity", "utilization"] as const;
  return columns.map((c) => messages.reportColumnHeader(c)).join(",");
}

export function emptyUtilizationReportPDF(): Blob {
  // A minimal, syntactically valid empty PDF document (no pages) — good enough as the inert
  // fallback; `internal/load-chart`'s report writer produces the real A4-landscape table.
  const body = "%PDF-1.4\n%%EOF";
  return new Blob([body], { type: "application/pdf" });
}
