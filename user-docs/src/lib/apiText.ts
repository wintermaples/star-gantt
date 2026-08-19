/**
 * Rendering helpers for the generated API text.
 *
 * `api.json` carries a type annotation as the extractor printed it — object types broken over
 * several lines, which is how the reference pages show them inside a code block. A table cell and
 * a pill cannot take those line breaks, so the places that show a type inline flatten it here
 * rather than each inventing its own collapse.
 */

/** A printed type as one line: every run of whitespace becomes a single space. */
export function oneLine(type: string): string {
  return type.replace(/\s+/g, " ").trim();
}
