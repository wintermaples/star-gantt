// docs/specs/plugins/export.md §9 — internal module: not part of the published surface.
/**
 * XML text escaping shared by the SVG writers of `internal/capture`.
 *
 * Both the document composer (`compose.ts`) and the recording proxy (`../capture` tree) emit SVG by
 * string concatenation, so both need the same escaping; keeping one copy here is what stops the two
 * from drifting apart.
 */

/** Escapes a string for use inside a double-quoted XML attribute value. */
export function escapeAttr(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Escapes a string for use as XML character data. */
export function escapeText(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
